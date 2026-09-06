/** Local rehearsal only. This code never authenticates a phone with the API. */
export const DEMO_ACCOUNT_KEY = 'pickchick.demo.profile.v1';
export const DEMO_LOGIN_CODE = '123456';
export const DEMO_CODE_TTL_MS = 180_000;
export const DEMO_RESEND_MS = 60_000;
export const DEMO_CODE_ATTEMPTS = 5;

export interface DemoAccount {
  version: 1;
  kind: 'local_demo';
  phone: string;
  createdAt: number;
}
export interface DemoChallenge {
  phone: string;
  expiresAt: number;
  resendAt: number;
  attemptsLeft: number;
}
export interface DemoAccountStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
  now(): number;
}
export type DemoLoginErrorCode =
  | 'invalid_phone'
  | 'wait_to_resend'
  | 'no_challenge'
  | 'expired'
  | 'attempts_exhausted'
  | 'invalid_code';
export class DemoLoginError extends Error {
  readonly code: DemoLoginErrorCode;
  constructor(code: DemoLoginErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Accepts the local mobile number, +7, or the domestic 8 prefix, without guessing ownership. */
export function normalizeDemoPhone(value: string): string | null {
  if (!/^[+\d\s()-]{1,30}$/.test(value)) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8')))
    digits = digits.slice(1);
  return /^7\d{9}$/.test(digits) ? `+7${digits}` : null;
}

export function formatDemoPhone(value: string): string {
  const phone = normalizeDemoPhone(value);
  if (!phone) return value;
  const local = phone.slice(2);
  return `+7 ${local.slice(0, 3)} ${local.slice(3, 6)}-${local.slice(6, 8)}-${local.slice(8)}`;
}

export function parseDemoAccount(raw: string | null): DemoAccount | null {
  if (!raw || raw.length > 1000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'createdAt,kind,phone,version' ||
      record.version !== 1 ||
      record.kind !== 'local_demo' ||
      typeof record.phone !== 'string' ||
      normalizeDemoPhone(record.phone) !== record.phone ||
      !Number.isSafeInteger(record.createdAt) ||
      Number(record.createdAt) <= 0
    )
      return null;
    return record as unknown as DemoAccount;
  } catch {
    return null;
  }
}

/** Independent of TestCustomerCore: its storage contract has no HTTP or server-session access. */
export class DemoAccountCore {
  account: DemoAccount | null = null;
  challenge: DemoChallenge | null = null;
  private readonly io: DemoAccountStorage;
  constructor(io: DemoAccountStorage) {
    this.io = io;
  }
  async restore(): Promise<void> {
    const raw = await this.io.read();
    this.account = parseDemoAccount(raw);
    if (raw && !this.account) await this.io.remove();
  }
  requestCode(input: string): void {
    const phone = normalizeDemoPhone(input);
    if (!phone) throw new DemoLoginError('invalid_phone');
    const now = this.io.now();
    if (this.challenge?.phone === phone && now < this.challenge.resendAt)
      throw new DemoLoginError('wait_to_resend');
    this.challenge = {
      phone,
      expiresAt: now + DEMO_CODE_TTL_MS,
      resendAt: now + DEMO_RESEND_MS,
      attemptsLeft: DEMO_CODE_ATTEMPTS,
    };
  }
  async verifyCode(code: string): Promise<void> {
    const challenge = this.challenge;
    if (!challenge) throw new DemoLoginError('no_challenge');
    if (this.io.now() >= challenge.expiresAt) throw new DemoLoginError('expired');
    if (challenge.attemptsLeft === 0) throw new DemoLoginError('attempts_exhausted');
    if (code !== DEMO_LOGIN_CODE) {
      this.challenge = { ...challenge, attemptsLeft: challenge.attemptsLeft - 1 };
      throw new DemoLoginError(
        this.challenge.attemptsLeft === 0 ? 'attempts_exhausted' : 'invalid_code',
      );
    }
    const next: DemoAccount = {
      version: 1,
      kind: 'local_demo',
      phone: challenge.phone,
      createdAt: this.io.now(),
    };
    // Persist before displaying success; a failed write leaves the challenge recoverable.
    await this.io.write(JSON.stringify(next));
    this.account = next;
    this.challenge = null;
  }
  cancelChallenge(): void {
    this.challenge = null;
  }
  async signOut(): Promise<void> {
    // Do not touch the independent order session or pending financial-command rehearsal.
    await this.io.remove();
    this.account = null;
    this.challenge = null;
  }
}
