import {
  KASPI_PIN,
  kaspiExpiration,
  kaspiText,
  privateIPv4,
  type KaspiCallOptions,
  type KaspiCallResult,
  type KaspiMethod,
  type KaspiProbe,
  type KaspiProbePort,
  type KaspiTerminalPort,
} from './kaspi-terminal.ts';

/**
 * The kiosk's own Kaspi Smart POS (ADR-0018): its address, identity, certificate pin and the
 * integration token. Stored only in SecureStore of this iPad (WHEN_UNLOCKED_THIS_DEVICE_ONLY);
 * the token and the pin are never sent to the cloud, which only learns terminal_id, serial, host.
 */
export const KASPI_TERMINAL_LINK_KEY = 'pickchick.kiosk.kaspi-terminal.v1';
export interface TerminalLink {
  host: string;
  terminalId: string;
  serial: string;
  /**
   * SHA-256 of the terminal's leaf certificate (HTTPS, «Защита интеграции» on), captured at the
   * first link; null: a terminal linked over plain HTTP (also every link stored before 22.11).
   */
  pin: string | null;
  /** The integration name of /v2/register; /v2/revoke needs the same one. */
  name: string;
  accessToken: string;
  refreshToken: string;
  /** Token expiry, ms since epoch (the terminal gives its local time, UTC+5). */
  expiresAt: number;
  linkedAt: number;
}
export interface TerminalLinkStore {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
  remove(): Promise<void>;
}
/** Renew the 24 h token when less than this is left (ADR-0018, owner task: 2 h). */
export const TOKEN_RENEW_BEFORE_MS = 2 * 3600000;
/** A failed renewal is tried again at most this often (the payment poll runs every second). */
export const TOKEN_RENEW_RETRY_MS = 60000;
/**
 * Owner 16.11.2026: the router cannot get a DHCP reservation, so the terminal's address may
 * change. When the stored address does not answer (nothing was sent), the kiosk looks for the
 * same terminal (terminal ID and serial from /v2/deviceinfo, and for an HTTPS link the same
 * certificate pin: deviceinfo is asked over the pinned TLS) in the /24 of the old address, at
 * most once a minute, keeps the new address and tells the cloud (PUT /terminal).
 */
export const RELOCATE_RETRY_MS = 60000;
export const RELOCATE_PROBE_TIMEOUT_MS = 1500;
export const RELOCATE_CONCURRENCY = 48;
const TOKEN = /^[A-Za-z0-9_.:-]{1,512}$/;
const NAME = /^pickchick-kiosk-[a-z0-9]{6}$/;
const FIELD = /^[A-Za-z0-9_.:-]{1,64}$/;

/** `pickchick-kiosk-<6 characters>` from a random UUID. */
export const terminalIntegrationName = (uuid: string) =>
  `pickchick-kiosk-${uuid
    .replace(/[^a-f0-9]/gi, '')
    .toLowerCase()
    .slice(0, 6)
    .padEnd(6, '0')}`;

export function parseTerminalLink(raw: string | null): TerminalLink | null {
  if (!raw || raw.length > 4000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    !privateIPv4(v.host) ||
    typeof v.terminalId !== 'string' ||
    !FIELD.test(v.terminalId) ||
    typeof v.serial !== 'string' ||
    !FIELD.test(v.serial) ||
    typeof v.name !== 'string' ||
    !NAME.test(v.name) ||
    typeof v.accessToken !== 'string' ||
    !TOKEN.test(v.accessToken) ||
    typeof v.refreshToken !== 'string' ||
    !TOKEN.test(v.refreshToken) ||
    !Number.isSafeInteger(v.expiresAt) ||
    !Number.isSafeInteger(v.linkedAt) ||
    // Absent in links stored before HTTPS (build 25): those are plain HTTP links.
    !(v.pin === undefined || v.pin === null || (typeof v.pin === 'string' && KASPI_PIN.test(v.pin)))
  )
    return null;
  return {
    host: v.host,
    terminalId: v.terminalId,
    serial: v.serial,
    pin: typeof v.pin === 'string' ? v.pin : null,
    name: v.name,
    accessToken: v.accessToken,
    refreshToken: v.refreshToken,
    expiresAt: v.expiresAt as number,
    linkedAt: v.linkedAt as number,
  };
}

/** Identity of the terminal from /v2/deviceinfo, or null when the answer lacks it. */
export function terminalIdentity(answer: KaspiCallResult | null) {
  if (answer?.kind !== 'ok') return null;
  const terminalId = kaspiText(answer.data.terminalId);
  const serial = kaspiText(answer.data.serialNum);
  if (!terminalId || !FIELD.test(terminalId) || !serial || !FIELD.test(serial)) return null;
  return { terminalId, serial };
}

/** Tokens of a register/revoke answer, or null. */
export function terminalTokens(answer: KaspiCallResult, now: number) {
  if (answer.kind !== 'ok') return null;
  const access = answer.data.accessToken;
  const refresh = answer.data.refreshToken;
  if (typeof access !== 'string' || !TOKEN.test(access)) return null;
  if (typeof refresh !== 'string' || !TOKEN.test(refresh)) return null;
  // Unreadable expiry: assume the shortest sensible life so it is renewed early again.
  const expiresAt =
    kaspiExpiration(answer.data.expirationDate) ?? now + TOKEN_RENEW_BEFORE_MS + 60000;
  return { accessToken: access, refreshToken: refresh, expiresAt };
}

/** The terminal answered and refused the token (or its absence): 401/403. */
export const tokenRefusedAnswer = (answer: KaspiCallResult) =>
  answer.kind === 'refused' && (answer.httpStatus === 401 || answer.httpStatus === 403);

/**
 * Calls of the linked terminal with a fresh token: renewed by /v2/revoke when less than two hours
 * are left, and after a 401/403 (then a read is retried once with the new token). A payment is
 * never retried: after a refused token it is renewed for the next, deliberate attempt.
 */
export class TerminalSession {
  private link: TerminalLink | null = null;
  private renewRetryAt = 0;
  private relocateRetryAt = 0;
  private relocating: Promise<boolean> | null = null;
  /** Called after the link moved to a new address (the controller tells the cloud). */
  onRelocated: ((link: TerminalLink) => void) | null = null;
  private readonly store: TerminalLinkStore;
  private readonly port: KaspiTerminalPort;
  private readonly now: () => number;
  private readonly prober: KaspiProbePort | null;
  /** Without a probe (older tests, plain-HTTP-only setups) every address is taken as HTTP. */
  constructor(
    store: TerminalLinkStore,
    port: KaspiTerminalPort,
    now: () => number,
    probe: KaspiProbePort | null = null,
  ) {
    this.store = store;
    this.port = port;
    this.now = now;
    this.prober = probe;
  }
  current() {
    return this.link;
  }
  async load() {
    this.link = parseTerminalLink(await this.store.read());
    return this.link;
  }
  async save(link: TerminalLink) {
    await this.store.write(JSON.stringify(link));
    this.link = link;
  }
  async forget() {
    await this.store.remove();
    this.link = null;
  }
  /** How the terminal at an address speaks (HTTPS and its certificate, or HTTP); null: silent. */
  async probe(host: string): Promise<KaspiProbe> {
    if (!this.prober) return { transport: 'http' };
    try {
      return await this.prober(host);
    } catch {
      return null;
    }
  }
  /**
   * Read-only identity check of an address, pinned when `pin` is given. 22.11.2026 (terminal #2,
   * app 2.64.9): with «Защита интеграции» on, /v2/deviceinfo without a token answers 401
   * `{"statusCode":999,"errorText":"Authorization failed"}`, so a linked terminal is always
   * asked with its access token.
   */
  deviceInfo(host: string, pin: string | null = null, token?: string) {
    return this.port(host, 'deviceinfo', {}, token ? { pin, token } : { pin });
  }
  register(host: string, name: string, pin: string | null = null) {
    return this.port(host, 'register', { name }, { pin });
  }
  /** /v2/revoke with the stored refresh token; the new tokens are stored before use. */
  async renew(force = false): Promise<boolean> {
    const link = this.link;
    if (!link) return false;
    if (!force && link.expiresAt - this.now() >= TOKEN_RENEW_BEFORE_MS) return true;
    if (!force && this.now() < this.renewRetryAt) return false;
    let answer: KaspiCallResult;
    try {
      answer = await this.port(
        link.host,
        'revoke',
        { name: link.name, refreshToken: link.refreshToken },
        { token: link.accessToken, pin: link.pin },
      );
    } catch {
      answer = { kind: 'unreachable', reason: 'CONNECT' };
    }
    const tokens = terminalTokens(answer, this.now());
    if (!tokens || this.link !== link) {
      this.renewRetryAt = this.now() + TOKEN_RENEW_RETRY_MS;
      return false;
    }
    try {
      await this.save({ ...link, ...tokens });
    } catch {
      this.renewRetryAt = this.now() + TOKEN_RENEW_RETRY_MS;
      return false;
    }
    this.renewRetryAt = 0;
    return true;
  }
  /** A call to the linked terminal; null when no terminal is linked. */
  async call(
    method: Exclude<KaspiMethod, 'register' | 'revoke'>,
    params: Record<string, string>,
    options: Omit<KaspiCallOptions, 'token'> = {},
  ): Promise<KaspiCallResult | null> {
    if (!this.link) return null;
    await this.renew();
    const link = this.link;
    if (!link) return null;
    let first = await this.safeCall(link, method, params, options);
    // Nothing reached the terminal: it may have a new address. Found → the call is sent there
    // once (safe for a payment too: `unreachable` means its pre-flight failed, nothing was sent).
    if (first.kind === 'unreachable' && (await this.relocate()) && this.link)
      first = await this.safeCall(this.link, method, params, options);
    if (!tokenRefusedAnswer(first)) return first;
    const renewed = await this.renew(true);
    if (!renewed || method === 'payment' || !this.link) return first;
    return this.safeCall(this.link, method, params, options);
  }
  /** Finds the linked terminal at a new address of the same /24; true when the link moved. */
  relocate(): Promise<boolean> {
    if (this.relocating) return this.relocating;
    const link = this.link;
    if (!link || this.now() < this.relocateRetryAt) return Promise.resolve(false);
    this.relocateRetryAt = this.now() + RELOCATE_RETRY_MS;
    this.relocating = this.scan(link).finally(() => {
      this.relocating = null;
    });
    return this.relocating;
  }
  private async scan(link: TerminalLink): Promise<boolean> {
    const prefix = link.host.slice(0, link.host.lastIndexOf('.') + 1);
    const candidates: string[] = [];
    for (let i = 1; i < 255; i++) if (prefix + i !== link.host) candidates.push(prefix + i);
    let found: string | null = null;
    let next = 0;
    const worker = async () => {
      while (!found && next < candidates.length) {
        const host = candidates[next++]!;
        let answer: KaspiCallResult | null;
        try {
          answer = await this.port(
            host,
            'deviceinfo',
            {},
            // An HTTPS link is pinned here too: only the same certificate answers at all, so a
            // device with another certificate is never taken for this terminal.
            // The token too: a protected terminal answers deviceinfo only with it (22.11.2026).
            { timeoutMs: RELOCATE_PROBE_TIMEOUT_MS, pin: link.pin, token: link.accessToken },
          );
        } catch {
          answer = null;
        }
        const identity = terminalIdentity(answer);
        if (identity?.terminalId === link.terminalId && identity.serial === link.serial)
          found ??= host;
      }
    };
    await Promise.all(Array.from({ length: RELOCATE_CONCURRENCY }, worker));
    if (!found || this.link !== link) return false;
    const moved = { ...link, host: found };
    try {
      await this.save(moved);
    } catch {
      return false;
    }
    this.relocateRetryAt = 0;
    try {
      this.onRelocated?.(moved);
    } catch {
      // Telling the cloud is best effort; the next staff check repeats it.
    }
    return true;
  }
  private async safeCall(
    link: TerminalLink,
    method: KaspiMethod,
    params: Record<string, string>,
    options: Omit<KaspiCallOptions, 'token'>,
  ): Promise<KaspiCallResult> {
    try {
      return await this.port(link.host, method, params, {
        ...options,
        token: link.accessToken,
        pin: link.pin,
      });
    } catch {
      // Invalid link or parameters: nothing was sent.
      return { kind: 'unreachable', reason: 'CONNECT' };
    }
  }
}
