import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { TLSSocket } from 'node:tls';

/**
 * Kaspi Smart POS local API client (ADR-0017, docs/integrations/kaspi-smart-pos-api.md): HTTPS on
 * port 8080 of a private IPv4, every method GET /v2/<method>?params. The terminal certificate is
 * issued for *.kaspipos.kz and we address it by IP, so the name is not checked: the SHA-256 of
 * the leaf certificate is pinned instead, and no byte of a request leaves before it matches.
 * Results say exactly what is known: `unreachable` - nothing was sent; `lost` - the request may
 * have reached the terminal but no valid answer came back (a payment then is never repeated).
 */
export interface KaspiLink {
  host: string;
  port: number;
  certificateSha256: string;
}
export type KaspiMethod = 'register' | 'revoke' | 'payment' | 'status' | 'actualize' | 'deviceinfo';
export type KaspiCallResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'refused'; httpStatus: number; statusCode: number | null; message: string | null }
  | { kind: 'unreachable'; reason: 'CONNECT' | 'CERTIFICATE' | 'TIMEOUT' }
  | { kind: 'lost'; reason: 'TIMEOUT' | 'CONNECTION' | 'ANSWER' };
export interface KaspiCallOptions {
  token?: string | null;
  timeoutMs?: number;
}
/** The seam the edge uses; tests give a simulator, the edge gives kaspiCall. */
export interface KaspiPosPort {
  call(
    link: KaspiLink,
    method: KaspiMethod,
    params: Record<string, string>,
    options?: KaspiCallOptions,
  ): Promise<KaspiCallResult>;
}

const MAX_ANSWER = 64 * 1024;
const PARAM = /^[A-Za-z0-9_.:-]{1,512}$/;

export function privateIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const normalizeFingerprint = (value: string) => value.replaceAll(':', '').toLowerCase();

/** A TLS connection to the terminal whose leaf certificate is the pinned one (or any, unpinned). */
function openPinned(
  link: { host: string; port: number; certificateSha256: string | null },
  timeoutMs: number,
): Promise<
  { socket: TLSSocket; fingerprint: string } | { failed: 'CONNECT' | 'CERTIFICATE' | 'TIMEOUT' }
> {
  return new Promise((resolve) => {
    let done = false;
    const socket = tlsConnect({
      host: link.host,
      port: link.port,
      // The name cannot match an IP; trust is the pinned fingerprint checked below.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    });
    const finish = (
      value:
        | { socket: TLSSocket; fingerprint: string }
        | { failed: 'CONNECT' | 'CERTIFICATE' | 'TIMEOUT' },
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if ('failed' in value) socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ failed: 'TIMEOUT' }), timeoutMs);
    socket.once('error', () => finish({ failed: 'CONNECT' }));
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      const fingerprint = peer?.fingerprint256 ? normalizeFingerprint(peer.fingerprint256) : '';
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) return finish({ failed: 'CERTIFICATE' });
      if (link.certificateSha256 !== null && fingerprint !== link.certificateSha256)
        return finish({ failed: 'CERTIFICATE' });
      finish({ socket, fingerprint });
    });
  });
}

/** SHA-256 of the terminal's certificate, for the operator to compare and pin (setup `probe`). */
export async function kaspiCertificate(host: string, port = 8080, timeoutMs = 8000) {
  if (!privateIPv4(host) || port !== 8080) throw new Error('KASPI_HOST_INVALID');
  return kaspiPeerCertificate(host, port, timeoutMs);
}
/** @internal kaspiCertificate without the address rule (loopback simulator in tests). */
export async function kaspiPeerCertificate(host: string, port: number, timeoutMs = 8000) {
  const opened = await openPinned({ host, port, certificateSha256: null }, timeoutMs);
  if ('failed' in opened) throw new Error('KASPI_' + opened.failed);
  opened.socket.destroy();
  return opened.fingerprint;
}

function envelope(httpStatus: number, body: string): KaspiCallResult {
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
  if (httpStatus >= 200 && httpStatus < 300 && data && !errorCode) return { kind: 'ok', data };
  if (httpStatus >= 200 && httpStatus < 300 && !data && !errorCode)
    return { kind: 'lost', reason: 'ANSWER' };
  return { kind: 'refused', httpStatus, statusCode: code, message };
}

/** One GET to the terminal. Never retried here: callers decide what a lost answer means. */
export async function kaspiCall(
  link: KaspiLink,
  method: KaspiMethod,
  params: Record<string, string>,
  options: KaspiCallOptions = {},
): Promise<KaspiCallResult> {
  if (!privateIPv4(link.host) || link.port !== 8080) throw new Error('KASPI_LINK_INVALID');
  return kaspiRequest(link, method, params, options);
}

/**
 * @internal kaspiCall without the private-IPv4/port rule (tests talk to a loopback simulator).
 */
export async function kaspiRequest(
  link: KaspiLink,
  method: KaspiMethod,
  params: Record<string, string>,
  { token = null, timeoutMs = 10000 }: KaspiCallOptions = {},
): Promise<KaspiCallResult> {
  if (!/^[a-f0-9]{64}$/.test(link.certificateSha256)) throw new Error('KASPI_LINK_INVALID');
  for (const [name, value] of Object.entries(params))
    if (!/^[A-Za-z]{1,32}$/.test(name) || !PARAM.test(value))
      throw new Error('KASPI_PARAM_INVALID');
  if (token !== null && !PARAM.test(token)) throw new Error('KASPI_TOKEN_INVALID');
  const opened = await openPinned(link, Math.min(timeoutMs, 8000));
  if ('failed' in opened) return { kind: 'unreachable', reason: opened.failed };
  const query = new URLSearchParams(params).toString();
  const path = `/v2/${method}${query ? '?' + query : ''}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: KaspiCallResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opened.socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ kind: 'lost', reason: 'TIMEOUT' }), timeoutMs);
    const req = httpRequest(
      {
        createConnection: () => opened.socket,
        host: link.host,
        port: link.port,
        method: 'GET',
        path,
        headers: { accept: 'application/json', ...(token ? { accesstoken: token } : {}) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER) return finish({ kind: 'lost', reason: 'ANSWER' });
          chunks.push(chunk);
        });
        response.on('end', () =>
          finish(envelope(response.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'))),
        );
        response.on('error', () => finish({ kind: 'lost', reason: 'CONNECTION' }));
      },
    );
    req.on('error', () => finish({ kind: 'lost', reason: 'CONNECTION' }));
    req.end();
  });
}

export const kaspiPort: KaspiPosPort = { call: kaspiCall };

/**
 * expirationDate of register/revoke ("2024-09-25 17:27:03", the terminal's local time: Kazakhstan,
 * UTC+5). Unreadable: null (the caller then renews early).
 */
export function kaspiExpiration(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+05:00`,
  );
  return Number.isFinite(date.getTime()) ? date : null;
}
