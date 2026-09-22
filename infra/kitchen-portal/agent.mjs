import { TextDecoder } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validJob, MAX_REPLY } from './link.mjs';
export async function executeJob(job, edgePort = 3101) {
  const failure = {
    id: job?.id,
    status: 504,
    body: Buffer.from('{"code":"EDGE_TIMEOUT"}').toString('base64'),
  };
  if (!validJob(job) || job.expiresAt <= Date.now() || job.expiresAt > Date.now() + 15000)
    return failure;
  try {
    const response = await fetch(`http://127.0.0.1:${edgePort}${job.path}`, {
      method: job.method,
      headers: job.headers,
      body: job.body,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(10000, Math.max(1, job.expiresAt - Date.now()))),
    });
    if (response.status === 204) return { id: job.id, status: 204, body: '' };
    if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error();
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks = [];
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_REPLY) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks);
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    const retryAfter = Number(response.headers.get('retry-after'));
    return {
      id: job.id,
      status: response.status,
      body: body.toString('base64'),
      ...(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 3600
        ? { retryAfter }
        : {}),
    };
  } catch {
    return failure;
  }
}
export async function runAgent({ origin, key, edgePort = 3101 }, signal) {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== origin ||
    parsed.username ||
    !/^[a-f0-9]{64}$/.test(key) ||
    !Number.isInteger(edgePort) ||
    edgePort < 1 ||
    edgePort > 65535
  )
    throw new Error('INVALID_AGENT_CONFIG');
  const headers = { Authorization: 'Bearer ' + key };
  async function worker() {
    while (!signal.aborted) {
      try {
        const response = await fetch(origin + '/kitchen-link/poll', {
          headers,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
        });
        if (response.status === 204) continue;
        if (!response.ok) throw new Error();
        const reader = response.body.getReader();
        let size = 0;
        const chunks = [];
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 20000) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(item.value);
        }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const job = JSON.parse(raw);
        const reply = await executeJob(job, edgePort);
        const ack = await fetch(origin + '/kitchen-link/reply', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(reply),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        if (![204, 410].includes(ack.status)) throw new Error();
        await ack.body?.cancel();
      } catch {
        if (!signal.aborted) await delay(1500, undefined, { signal }).catch(() => {});
      }
    }
  }
  await Promise.all([worker(), worker()]);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const controller = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort());
  runAgent(config, controller.signal).catch(() => {
    console.error('Kitchen link agent stopped: invalid configuration');
    process.exitCode = 1;
  });
}
