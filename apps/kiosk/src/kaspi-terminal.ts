/**
 * Kaspi Smart POS local API from the iPad kiosk (ADR-0018; method notes in
 * docs/integrations/kaspi-smart-pos-api.md of branch codex/kaspi-pos-1115). The kiosk talks to
 * its own terminal over the restaurant LAN on port 8080 of a private IPv4, every method a GET
 * `/v2/<method>?<query>`, the token in the `accesstoken` header (all methods except register).
 *
 * Two transports (22.11.2026, ADR-0018 point 1): with «Защита интеграции» on, the terminal speaks
 * only TLS on 8080 with a self-signed certificate (plain HTTP is reset); with it off it speaks
 * plain HTTP but refuses register with code 105. So a link is HTTPS with the SHA-256 of the
 * terminal's leaf certificate pinned (no CA trust; the name is not checked, we address it by IP),
 * through the native module `kaspi-tls` (URLSession: React Native fetch rejects self-signed
 * certificates). The native side accepts the server trust only for the pinned leaf and cancels
 * before any request byte leaves otherwise. A link without a pin (`pin: null`) is plain HTTP
 * through fetch, kept for terminals that answer HTTP. Nothing falls back from HTTPS to HTTP.
 *
 * Results say exactly what is known, like the edge client (packages/local-orders kaspi-client):
 * - `ok`: a valid envelope with data;
 * - `refused`: the terminal answered with an error (HTTP status and its `statusCode`);
 * - `unreachable`: nothing was sent (bad pre-flight, a failed read-only call, or `CERTIFICATE`:
 *   the terminal presented another certificate than the pinned one);
 * - `lost`: the request may have reached the terminal but no valid answer came back.
 * fetch cannot tell «connection refused» from «sent, answer lost», so a call that changes the
 * terminal (register, revoke, payment) first checks the terminal with read-only `deviceinfo` over
 * the same transport: only a failed pre-flight is `unreachable`; once the change itself was sent,
 * any failure except a refused certificate is `lost`. Nothing here retries: the callers decide
 * (a payment is never repeated).
 */
export type KaspiMethod = 'register' | 'revoke' | 'payment' | 'status' | 'actualize' | 'deviceinfo';
export type KaspiCallResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'refused'; httpStatus: number; statusCode: number | null; message: string | null }
  | { kind: 'unreachable'; reason: 'CONNECT' | 'TIMEOUT' | 'CERTIFICATE' }
  | { kind: 'lost'; reason: 'TIMEOUT' | 'CONNECTION' | 'ANSWER' };
export interface KaspiCallOptions {
  token?: string | null;
  timeoutMs?: number;
  /** SHA-256 (lowercase hex) of the terminal's leaf certificate: HTTPS. Null or absent: HTTP. */
  pin?: string | null;
}
/** The seam the controller uses; tests give a simulator, the app gives kaspiTerminalCall. */
export type KaspiTerminalPort = (
  host: string,
  method: KaspiMethod,
  params: Record<string, string>,
  options?: KaspiCallOptions,
) => Promise<KaspiCallResult>;

/** What the native TLS module answers for one request (apps/kiosk/modules/kaspi-tls). */
export type KaspiTlsAnswer =
  | { ok: true; status: number; body: string }
  | {
      ok: false;
      /**
       * CERTIFICATE: another leaf than the pin, cancelled in the handshake (nothing sent).
       * CONNECT / TIMEOUT without `sent`: no pinned TLS session existed yet (nothing sent).
       * CONNECTION / TIMEOUT with `sent`: the request may have left. ANSWER: answer too long.
       * UNSUPPORTED: no native module (web, a build made before it).
       */
      failure: 'CERTIFICATE' | 'CONNECT' | 'TIMEOUT' | 'CONNECTION' | 'ANSWER' | 'UNSUPPORTED';
      sent: boolean;
    };
/** The native handshake probe: the presented leaf, or whether TCP worked at all. */
export type KaspiTlsProbe =
  { transport: 'https'; sha256: string } | { transport: 'http' } | { transport: 'none' };
/** The native seam: tests give a double, the app gives the kaspi-tls module (or its fallback). */
export interface KaspiTls {
  /** TLS handshake only: the presented leaf's SHA-256, then cancelled (no request is sent). */
  probe(host: string, port: number, timeoutMs: number): Promise<KaspiTlsProbe>;
  /** One GET over TLS, accepted only for the pinned leaf. */
  request(
    host: string,
    port: number,
    path: string,
    token: string | null,
    sha256: string,
    timeoutMs: number,
  ): Promise<KaspiTlsAnswer>;
}
/** How a terminal at an address speaks, for the first link; null: nothing answered there. */
export type KaspiProbe = { transport: 'https'; pin: string } | { transport: 'http' } | null;
/** The probe seam the session uses (tests give a double, the app gives kaspiTerminalProbe). */
export type KaspiProbePort = (host: string) => Promise<KaspiProbe>;

export const KASPI_TERMINAL_PORT = 8080;
/** Ordinary calls; register waits for «Разрешить» on the terminal, so it has its own limit. */
export const KASPI_CALL_TIMEOUT_MS = 8000;
export const KASPI_REGISTER_TIMEOUT_MS = 120000;
export const KASPI_PROBE_TIMEOUT_MS = 5000;
/** A certificate pin: SHA-256 of the leaf (DER), lowercase hex. */
export const KASPI_PIN = /^[a-f0-9]{64}$/;
const PREFLIGHT_TIMEOUT_MS = 4000;
const MAX_ANSWER = 64 * 1024;
const PARAM = /^[A-Za-z0-9_.:-]{1,512}$/;
/** Methods that change something on the terminal: never `unreachable` after they were sent. */
const CHANGING: KaspiMethod[] = ['register', 'revoke', 'payment'];

/** No native TLS (web, a build without the module): nothing can be sent over HTTPS. */
export const KASPI_TLS_UNSUPPORTED: KaspiTls = {
  probe: async () => ({ transport: 'http' }),
  request: async () => ({ ok: false, failure: 'UNSUPPORTED', sent: false }),
};

/** The raw native module (apps/kiosk/modules/kaspi-tls): untyped answers, checked below. */
export interface KaspiTlsNative {
  probe(host: string, port: number, timeoutMs: number): Promise<unknown>;
  request(
    host: string,
    port: number,
    path: string,
    token: string,
    sha256: string,
    timeoutMs: number,
  ): Promise<unknown>;
}
const FAILURES = ['CERTIFICATE', 'CONNECT', 'TIMEOUT', 'CONNECTION', 'ANSWER'] as const;
/**
 * The seam over the native module, its answers strictly checked; null (web, Android, a build
 * without the module) → unsupported. An unreadable request answer counts as maybe sent.
 */
export function kaspiTlsFrom(native: KaspiTlsNative | null): KaspiTls {
  if (!native) return KASPI_TLS_UNSUPPORTED;
  const record = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    probe: async (host, port, timeoutMs) => {
      const v = record(await native.probe(host, port, timeoutMs));
      if (v.transport === 'https' && typeof v.sha256 === 'string' && KASPI_PIN.test(v.sha256))
        return { transport: 'https', sha256: v.sha256 };
      if (v.transport === 'none') return { transport: 'none' };
      return { transport: 'http' };
    },
    request: async (host, port, path, token, sha256, timeoutMs) => {
      const v = record(await native.request(host, port, path, token ?? '', sha256, timeoutMs));
      if (v.ok === true && Number.isInteger(v.status) && typeof v.body === 'string')
        return { ok: true, status: v.status as number, body: v.body };
      const failure = FAILURES.find((f) => f === v.failure);
      if (v.ok === false && failure) return { ok: false, failure, sent: v.sent !== false };
      return { ok: false, failure: 'CONNECTION', sent: true };
    },
  };
}

/** 10/8, 172.16/12 or 192.168/16, written canonically (no leading zeros). */
export function privateIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 15) return false;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map((p) => (p.length > 1 && p.startsWith('0') ? NaN : Number(p)));
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** «228fc8c4…1a2b3c4d»: the first and last 8 hex characters of a pin, shown to the staff. */
export const kaspiPinShort = (pin: string) => `${pin.slice(0, 8)}…${pin.slice(-8)}`;

/** The Kaspi answer envelope: HTTP status, `statusCode`, `data`, `errorText`. */
export function kaspiEnvelope(httpStatus: number, body: string): KaspiCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return httpStatus >= 200 && httpStatus < 300
      ? { kind: 'lost', reason: 'ANSWER' }
      : { kind: 'refused', httpStatus, statusCode: null, message: null };
  }
  const value =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const code =
    typeof value.statusCode === 'number' && Number.isInteger(value.statusCode)
      ? value.statusCode
      : null;
  const data =
    value.data && typeof value.data === 'object' && !Array.isArray(value.data)
      ? (value.data as Record<string, unknown>)
      : null;
  const text = (item: unknown) =>
    typeof item === 'string' && item.trim() ? item.trim().slice(0, 300) : null;
  const message = text(value.errorText) ?? text(data?.message) ?? text(value.message);
  // Error codes of the documentation: 100-108 and 999 (codes 0/200 or none are success).
  const errorCode = code !== null && code !== 0 && code !== 200;
  const success = httpStatus >= 200 && httpStatus < 300;
  if (success && data && !errorCode) return { kind: 'ok', data };
  if (success && !data && !errorCode) return { kind: 'lost', reason: 'ANSWER' };
  return { kind: 'refused', httpStatus, statusCode: code, message };
}

/** One GET over the native pinned TLS. */
async function sendTls(
  tls: KaspiTls,
  host: string,
  path: string,
  token: string | null,
  pin: string,
  timeoutMs: number,
  changing: boolean,
): Promise<KaspiCallResult> {
  let answer: KaspiTlsAnswer;
  try {
    answer = await tls.request(host, KASPI_TERMINAL_PORT, path, token, pin, timeoutMs);
  } catch {
    // The bridge itself failed: it cannot say what was sent.
    answer = { ok: false, failure: 'CONNECTION', sent: true };
  }
  if (answer.ok) {
    if (!Number.isInteger(answer.status) || typeof answer.body !== 'string')
      return { kind: 'lost', reason: 'ANSWER' };
    if (answer.body.length > MAX_ANSWER) return { kind: 'lost', reason: 'ANSWER' };
    return kaspiEnvelope(answer.status, answer.body);
  }
  // Cancelled in the handshake: provably nothing of the request left the iPad.
  if (answer.failure === 'CERTIFICATE') return { kind: 'unreachable', reason: 'CERTIFICATE' };
  if (answer.failure === 'UNSUPPORTED') return { kind: 'unreachable', reason: 'CONNECT' };
  if (answer.failure === 'ANSWER') return { kind: 'lost', reason: 'ANSWER' };
  const timeout = answer.failure === 'TIMEOUT';
  if (changing || answer.sent) return { kind: 'lost', reason: timeout ? 'TIMEOUT' : 'CONNECTION' };
  return { kind: 'unreachable', reason: timeout ? 'TIMEOUT' : 'CONNECT' };
}

async function send(
  fetcher: typeof fetch,
  tls: KaspiTls,
  pin: string | null,
  host: string,
  method: KaspiMethod,
  params: Record<string, string>,
  token: string | null,
  timeoutMs: number,
  changing: boolean,
): Promise<KaspiCallResult> {
  const query = new URLSearchParams(params).toString();
  const path = `/v2/${method}${query ? '?' + query : ''}`;
  if (pin !== null) return sendTls(tls, host, path, token, pin, timeoutMs, changing);
  const url = `http://${host}:${KASPI_TERMINAL_PORT}${path}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/json', ...(token ? { accesstoken: token } : {}) },
      });
    } catch {
      if (changing) return { kind: 'lost', reason: timedOut ? 'TIMEOUT' : 'CONNECTION' };
      return { kind: 'unreachable', reason: timedOut ? 'TIMEOUT' : 'CONNECT' };
    }
    let body: string;
    try {
      if (Number(response.headers.get('content-length') ?? 0) > MAX_ANSWER)
        return { kind: 'lost', reason: 'ANSWER' };
      body = await response.text();
    } catch {
      return { kind: 'lost', reason: timedOut ? 'TIMEOUT' : 'CONNECTION' };
    }
    if (body.length > MAX_ANSWER) return { kind: 'lost', reason: 'ANSWER' };
    return kaspiEnvelope(response.status, body);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One GET to the terminal at a private IPv4: HTTPS with the pinned certificate when `pin` is
 * given, plain HTTP otherwise. Throws (nothing sent) on an invalid host, pin, parameter or token.
 * A changing method is preceded by a read-only `deviceinfo` check (see the header).
 */
export async function kaspiTerminalCall(
  host: string,
  method: KaspiMethod,
  params: Record<string, string>,
  { token = null, timeoutMs, pin = null }: KaspiCallOptions = {},
  fetcher: typeof fetch = fetch,
  tls: KaspiTls = KASPI_TLS_UNSUPPORTED,
): Promise<KaspiCallResult> {
  if (!privateIPv4(host)) throw new Error('KASPI_HOST_INVALID');
  if (pin !== null && !KASPI_PIN.test(pin)) throw new Error('KASPI_PIN_INVALID');
  for (const [name, value] of Object.entries(params))
    if (!/^[A-Za-z]{1,32}$/.test(name) || !PARAM.test(value))
      throw new Error('KASPI_PARAM_INVALID');
  if (token !== null && !PARAM.test(token)) throw new Error('KASPI_TOKEN_INVALID');
  const changing = CHANGING.includes(method);
  const limit =
    timeoutMs ?? (method === 'register' ? KASPI_REGISTER_TIMEOUT_MS : KASPI_CALL_TIMEOUT_MS);
  if (changing) {
    const probe = await send(
      fetcher,
      tls,
      pin,
      host,
      'deviceinfo',
      {},
      null,
      PREFLIGHT_TIMEOUT_MS,
      false,
    );
    // Any HTTP answer proves the terminal is there; only no answer at all stops the call.
    if (probe.kind === 'unreachable') return probe;
    if (probe.kind === 'lost') return { kind: 'unreachable', reason: 'TIMEOUT' };
  }
  return send(fetcher, tls, pin, host, method, params, token, limit, changing);
}

/**
 * How the terminal at this address speaks, before the first link: the SHA-256 of its leaf
 * certificate when it answers TLS (the pin, trusted on first use: the staff sees its start and
 * end and confirms by linking), otherwise whether read-only /v2/deviceinfo answers the Kaspi
 * envelope over plain HTTP. Null: nothing answered. Throws on an invalid address. Sends no token
 * and changes nothing on the terminal.
 */
export async function kaspiTerminalProbe(
  host: string,
  fetcher: typeof fetch = fetch,
  tls: KaspiTls = KASPI_TLS_UNSUPPORTED,
): Promise<KaspiProbe> {
  if (!privateIPv4(host)) throw new Error('KASPI_HOST_INVALID');
  let probe: KaspiTlsProbe;
  try {
    probe = await tls.probe(host, KASPI_TERMINAL_PORT, KASPI_PROBE_TIMEOUT_MS);
  } catch {
    probe = { transport: 'http' };
  }
  if (probe.transport === 'https') {
    const pin = typeof probe.sha256 === 'string' ? probe.sha256.toLowerCase() : '';
    return KASPI_PIN.test(pin) ? { transport: 'https', pin } : null;
  }
  if (probe.transport === 'none') return null;
  const answer = await send(
    fetcher,
    tls,
    null,
    host,
    'deviceinfo',
    {},
    null,
    KASPI_PROBE_TIMEOUT_MS,
    false,
  );
  // Any Kaspi answer over plain HTTP (even an error) shows a terminal speaking HTTP.
  return answer.kind === 'ok' || answer.kind === 'refused' ? { transport: 'http' } : null;
}

/**
 * expirationDate of register/revoke ("2024-09-25 17:27:03", the terminal's local time:
 * Kazakhstan, UTC+5). Unreadable: null (the caller then renews early).
 */
export function kaspiExpiration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)$/.exec(value.trim());
  if (!match) return null;
  const time = Date.parse(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+05:00`,
  );
  return Number.isFinite(time) ? time : null;
}

/** A short text field of a terminal answer, or null. */
export const kaspiText = (value: unknown, max = 64) =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null;
