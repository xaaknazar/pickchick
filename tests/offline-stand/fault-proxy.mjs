/**
 * Offline stand: a controllable link between two local processes (docs/operations/offline-stand.md).
 *
 * "WAN" = cashier workers -> cloud API, "LAN" = kitchen screen -> cashier edge. HTTP aware, so a
 * request can be committed upstream while the answer is lost, delivered twice, delivered after
 * the client gave up, or overtaken by a later request. Loopback targets only; never a real host.
 */
import { createServer, request as httpRequest, Agent } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

export const FAULT_MODES = ['up', 'down', 'blackhole', 'chaos'];
const CHAOS_KEYS = [
  'reset',
  'dropResponse',
  'duplicate',
  'late',
  'lateMs',
  'reorder',
  'reorderMs',
  'delayMs',
];
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** mulberry32: small deterministic PRNG so a chaos run can be replayed with the same seed. */
export function seededRandom(seed) {
  let state = Number(seed) >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loopback(target) {
  const url = new URL(target);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search
  )
    throw new Error('FaultProxy target must be a plain loopback http origin');
  return url;
}

function checkedChaos(options = {}) {
  for (const key of Object.keys(options))
    if (!CHAOS_KEYS.includes(key)) throw new Error(`Unknown chaos option ${key}`);
  const p = (key) => {
    const value = options[key] ?? 0;
    if (typeof value !== 'number' || !(value >= 0 && value <= 1))
      throw new Error(`Chaos probability ${key} must be in [0,1]`);
    return value;
  };
  const ms = (key, fallback) => {
    const value = options[key] ?? fallback;
    if (!Number.isInteger(value) || value < 0 || value > 600000)
      throw new Error(`Chaos ${key} must be whole milliseconds`);
    return value;
  };
  const delayMs = options.delayMs ?? [0, 0];
  if (
    !Array.isArray(delayMs) ||
    delayMs.length !== 2 ||
    !delayMs.every((v) => Number.isInteger(v) && v >= 0 && v <= 60000) ||
    delayMs[0] > delayMs[1]
  )
    throw new Error('Chaos delayMs must be [min,max] milliseconds');
  return {
    reset: p('reset'),
    dropResponse: p('dropResponse'),
    duplicate: p('duplicate'),
    late: p('late'),
    lateMs: ms('lateMs', 7000),
    reorder: p('reorder'),
    reorderMs: ms('reorderMs', 1500),
    delayMs,
  };
}

const emptyStats = () => ({
  requests: 0,
  forwarded: 0,
  refused: 0,
  blackholed: 0,
  reset: 0,
  delayed: 0,
  late: 0,
  reordered: 0,
  dropped_response: 0,
  duplicated: 0,
  upstream_errors: 0,
});

export class FaultProxy {
  #name;
  #target;
  #random;
  #server;
  #agent = new Agent({ keepAlive: true, maxSockets: 64 });
  #sockets = new Set();
  #held = new Set();
  #mode = 'up';
  #chaos = checkedChaos();
  #stats = emptyStats();
  #window = null;
  #timers = new Set();
  #closed = false;
  #url = null;

  constructor({ name, target, seed = 1 }) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name ?? '')) throw new Error('FaultProxy needs a name');
    this.#name = name;
    this.#target = loopback(target);
    this.#random = seededRandom(seed);
  }
  get name() {
    return this.#name;
  }
  get url() {
    return this.#url;
  }
  get mode() {
    return this.#mode;
  }
  get chaos() {
    return { ...this.#chaos };
  }
  stats() {
    return { ...this.#stats };
  }

  async start(port = 0) {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#server.keepAliveTimeout = 2000;
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
      if (this.#mode === 'down') {
        this.#stats.refused++;
        socket.destroy();
      }
    });
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, '127.0.0.1', resolve);
    });
    this.#url = `http://127.0.0.1:${this.#server.address().port}`;
    return this.#url;
  }

  /** 'up' forwards; 'down' resets every connection; 'blackhole' accepts and never answers;
   * 'chaos' forwards with the given per-request fault probabilities. */
  set(mode, chaos) {
    if (!FAULT_MODES.includes(mode)) throw new Error(`Unknown fault mode ${mode}`);
    const next = mode === 'chaos' ? checkedChaos(chaos) : checkedChaos();
    this.#mode = mode;
    this.#chaos = next;
    if (mode === 'down') for (const socket of this.#sockets) socket.destroy();
    if (mode !== 'blackhole') {
      for (const socket of this.#held) socket.destroy();
      this.#held.clear();
    }
  }

  async close() {
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const socket of this.#sockets) socket.destroy();
    this.#agent.destroy();
    if (this.#server) await new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #later(ms, fn) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#closed) fn();
    }, ms);
    this.#timers.add(timer);
  }

  async #handle(req, res) {
    this.#stats.requests++;
    const socket = req.socket;
    if (this.#mode === 'down') {
      this.#stats.refused++;
      socket.destroy();
      return;
    }
    if (this.#mode === 'blackhole') {
      this.#stats.blackholed++;
      this.#held.add(socket);
      socket.on('close', () => this.#held.delete(socket));
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      socket.destroy();
      return;
    }
    if (this.#mode === 'up') {
      await this.#forwardAndAnswer(req, body, res, { dropResponse: false, duplicate: false });
      return;
    }
    // Always draw the same number of values per request: a seed replays the same faults.
    const c = this.#chaos,
      draw = Array.from({ length: 7 }, this.#random);
    if (draw[0] < c.reset) {
      this.#stats.reset++;
      socket.destroy();
      return;
    }
    const plan = {
      dropResponse: draw[1] < c.dropResponse,
      duplicate: draw[2] < c.duplicate,
      late: draw[3] < c.late,
      reorder: draw[4] < c.reorder,
      delay: Math.round(c.delayMs[0] + draw[5] * (c.delayMs[1] - c.delayMs[0])),
    };
    if (plan.delay > 0) {
      this.#stats.delayed++;
      await sleep(plan.delay);
    }
    if (plan.late) {
      // The client keeps waiting and times out on its own; the request still lands later.
      this.#stats.late++;
      this.#later(c.lateMs, () => {
        void this.#forward(req, body).finally(() => socket.destroy());
      });
      return;
    }
    if (plan.reorder) {
      this.#stats.reordered++;
      const release = () => this.#forwardAndAnswer(req, body, res, plan);
      if (!this.#window) {
        const window = (this.#window = []);
        this.#later(c.reorderMs, () => {
          if (this.#window === window) this.#window = null;
          for (const go of window.reverse()) void go();
        });
      }
      this.#window.push(release);
      return;
    }
    await this.#forwardAndAnswer(req, body, res, plan);
  }

  async #forwardAndAnswer(req, body, res, plan) {
    let reply;
    try {
      if (plan.duplicate) {
        this.#stats.duplicated++;
        // A second copy races the first one: the receiver sees the same bytes twice at once.
        const [first] = await Promise.allSettled([
          this.#forward(req, body),
          sleep(Math.floor(this.#random() * 20)).then(() => this.#forward(req, body)),
        ]);
        if (first.status === 'rejected') throw first.reason;
        reply = first.value;
      } else reply = await this.#forward(req, body);
    } catch {
      req.socket.destroy();
      return;
    }
    if (plan.dropResponse) {
      // Upstream committed; the caller never learns it (lost ACK).
      this.#stats.dropped_response++;
      req.socket.destroy();
      return;
    }
    try {
      const headers = {};
      for (const [key, value] of Object.entries(reply.headers))
        if (!HOP.has(key.toLowerCase())) headers[key] = value;
      headers['content-length'] = String(reply.body.length);
      res.writeHead(reply.status, headers);
      res.end(reply.body);
    } catch {
      req.socket.destroy();
    }
  }

  #forward(req, body) {
    return new Promise((resolve, reject) => {
      const headers = {};
      for (const [key, value] of Object.entries(req.headers))
        if (!HOP.has(key.toLowerCase())) headers[key] = value;
      headers.host = this.#target.host;
      if (body.length || !['GET', 'HEAD'].includes(req.method))
        headers['content-length'] = String(body.length);
      const upstream = httpRequest(
        new URL(req.url, this.#target),
        { method: req.method, headers, agent: this.#agent, timeout: 30000 },
        (response) => {
          readBody(response).then(
            (data) => {
              this.#stats.forwarded++;
              resolve({ status: response.statusCode, headers: response.headers, body: data });
            },
            (error) => {
              this.#stats.upstream_errors++;
              reject(error);
            },
          );
        },
      );
      upstream.on('timeout', () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
      upstream.on('error', (error) => {
        this.#stats.upstream_errors++;
        reject(error);
      });
      upstream.end(body);
    });
  }
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        stream.destroy();
        reject(new Error('BODY_TOO_LARGE'));
      } else chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.on('aborted', () => reject(new Error('ABORTED')));
  });
}
