/**
 * Kaspi Smart POS local API from the iPad kiosk (ADR-0018; method notes in
 * docs/integrations/kaspi-smart-pos-api.md of branch codex/kaspi-pos-1115). The kiosk talks to
 * its own terminal over the restaurant LAN: plain `http://<private IPv4>:8080/v2/<method>`, every
 * method a GET with query parameters, the token in the `accesstoken` header (all methods except
 * register). Our Smart POS 3 (application 2.64.9) answers plain HTTP without TLS (ADR-0017 p. 11).
 *
 * Results say exactly what is known, like the edge client (packages/local-orders kaspi-client):
 * - `ok`: a valid envelope with data;
 * - `refused`: the terminal answered with an error (HTTP status and its `statusCode`);
 * - `unreachable`: nothing was sent (bad pre-flight or a failed read-only call);
 * - `lost`: the request may have reached the terminal but no valid answer came back.
 * fetch cannot tell «connection refused» from «sent, answer lost», so a call that changes the
 * terminal (register, revoke, payment) first checks the terminal with read-only `deviceinfo`:
 * only a failed pre-flight is `unreachable`; once the change itself was sent, any failure is
 * `lost`. Nothing here retries: the callers decide (a payment is never repeated).
 */
export type KaspiMethod = 'register' | 'revoke' | 'payment' | 'status' | 'actualize' | 'deviceinfo';
export type KaspiCallResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'refused'; httpStatus: number; statusCode: number | null; message: string | null }
  | { kind: 'unreachable'; reason: 'CONNECT' | 'TIMEOUT' }
  | { kind: 'lost'; reason: 'TIMEOUT' | 'CONNECTION' | 'ANSWER' };
export interface KaspiCallOptions {
  token?: string | null;
  timeoutMs?: number;
}
/** The seam the controller uses; tests give a simulator, the app gives kaspiTerminalCall. */
export type KaspiTerminalPort = (
  host: string,
  method: KaspiMethod,
  params: Record<string, string>,
  options?: KaspiCallOptions,
) => Promise<KaspiCallResult>;

export const KASPI_TERMINAL_PORT = 8080;
/** Ordinary calls; register waits for «Разрешить» on the terminal, so it has its own limit. */
export const KASPI_CALL_TIMEOUT_MS = 8000;
export const KASPI_REGISTER_TIMEOUT_MS = 120000;
const PREFLIGHT_TIMEOUT_MS = 4000;
const MAX_ANSWER = 64 * 1024;
const PARAM = /^[A-Za-z0-9_.:-]{1,512}$/;
/** Methods that change something on the terminal: never `unreachable` after they were sent. */
const CHANGING: KaspiMethod[] = ['register', 'revoke', 'payment'];

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

async function send(
  fetcher: typeof fetch,
  host: string,
  method: KaspiMethod,
  params: Record<string, string>,
  token: string | null,
  timeoutMs: number,
  changing: boolean,
): Promise<KaspiCallResult> {
  const query = new URLSearchParams(params).toString();
  const url = `http://${host}:${KASPI_TERMINAL_PORT}/v2/${method}${query ? '?' + query : ''}`;
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
 * One GET to the terminal at a private IPv4. Throws (nothing sent) on an invalid host, parameter
 * or token. A changing method is preceded by a read-only `deviceinfo` check (see the header).
 */
export async function kaspiTerminalCall(
  host: string,
  method: KaspiMethod,
  params: Record<string, string>,
  { token = null, timeoutMs }: KaspiCallOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<KaspiCallResult> {
  if (!privateIPv4(host)) throw new Error('KASPI_HOST_INVALID');
  for (const [name, value] of Object.entries(params))
    if (!/^[A-Za-z]{1,32}$/.test(name) || !PARAM.test(value))
      throw new Error('KASPI_PARAM_INVALID');
  if (token !== null && !PARAM.test(token)) throw new Error('KASPI_TOKEN_INVALID');
  const changing = CHANGING.includes(method);
  const limit =
    timeoutMs ?? (method === 'register' ? KASPI_REGISTER_TIMEOUT_MS : KASPI_CALL_TIMEOUT_MS);
  if (changing) {
    const probe = await send(fetcher, host, 'deviceinfo', {}, null, PREFLIGHT_TIMEOUT_MS, false);
    // Any HTTP answer proves the terminal is there; only no answer at all stops the call.
    if (probe.kind === 'unreachable') return probe;
    if (probe.kind === 'lost') return { kind: 'unreachable', reason: 'TIMEOUT' };
  }
  return send(fetcher, host, method, params, token, limit, changing);
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
