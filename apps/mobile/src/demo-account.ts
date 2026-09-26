import {
  emptyDemoProfile,
  normalizeProfileDetails,
  type DemoProfile,
  type DemoProfileInput,
} from './profile-details.ts';

/** Local rehearsal only. This code never authenticates a phone with the API. */
export const DEMO_ACCOUNT_KEY = 'pickchick.demo.profile.v1';
export const DEMO_LOGIN_CODE = '123456';
export const DEMO_CODE_TTL_MS = 180_000;
export const DEMO_RESEND_MS = 60_000;
export const DEMO_CODE_ATTEMPTS = 5;

export interface DemoAccount {
  version: 2;
  kind: 'local_demo';
  phone: string;
  createdAt: number;
  profile: DemoProfile;
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
  | 'invalid_code'
  | 'invalid_profile'
  | 'no_account'
  | 'restore_required';
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

export function parseDemoAccount(raw: string | null, now: number = Date.now()): DemoAccount | null {
  if (!raw || raw.length > 1000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      (record.version !== 1 && record.version !== 2) ||
      Object.keys(record).sort().join(',') !==
        (record.version === 1
          ? 'createdAt,kind,phone,version'
          : 'createdAt,kind,phone,profile,version') ||
      record.kind !== 'local_demo' ||
      typeof record.phone !== 'string' ||
      normalizeDemoPhone(record.phone) !== record.phone ||
      !Number.isSafeInteger(record.createdAt) ||
      Number(record.createdAt) <= 0
    )
      return null;
    let profile = emptyDemoProfile();
    if (record.version === 2) {
      if (!record.profile || typeof record.profile !== 'object' || Array.isArray(record.profile))
        return null;
      const stored = record.profile as Record<string, unknown>;
      if (Object.keys(stored).sort().join(',') !== 'birthDate,completedAt,gender,nickname')
        return null;
      const details = normalizeProfileDetails(
        { nickname: stored.nickname, birthDate: stored.birthDate, gender: stored.gender },
        now,
      );
      if (
        !details ||
        (stored.completedAt !== null &&
          (!Number.isSafeInteger(stored.completedAt) || Number(stored.completedAt) <= 0))
      )
        return null;
      profile = { ...details, completedAt: stored.completedAt as number | null };
    }
    return {
      version: 2,
      kind: 'local_demo',
      phone: record.phone,
      createdAt: Number(record.createdAt),
      profile,
    };
  } catch {
    return null;
  }
}

/** Independent of TestCustomerCore: its storage contract has no HTTP or server-session access. */
export class DemoAccountCore {
  account: DemoAccount | null = null;
  challenge: DemoChallenge | null = null;
  private readonly io: DemoAccountStorage;
  private restoreBlocked = false;
  private restoring: Promise<void> | null = null;
  constructor(io: DemoAccountStorage) {
    this.io = io;
  }
  restore(): Promise<void> {
    if (this.restoring) return this.restoring;
    // A pending/failed read is not evidence that this device has no account.
    // Keep writes blocked until a retry has established its persisted identity.
    this.restoreBlocked = true;
    this.restoring = this.readAccount().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }
  private async readAccount(): Promise<void> {
    const raw = await this.io.read();
    const next = parseDemoAccount(raw, this.io.now());
    if (raw && !next) await this.io.remove();
    if (next && raw !== JSON.stringify(next)) {
      // Best-effort v1 migration: a write failure must not log out an existing
      // local account. A later restore/profile save can persist the new shape.
      try {
        await this.io.write(JSON.stringify(next));
      } catch {
        // The valid old record is still readable under the same storage key.
      }
    }
    this.account = next;
    this.restoreBlocked = false;
  }
  private requireRestored(): void {
    if (this.restoreBlocked) throw new DemoLoginError('restore_required');
  }
  requestCode(input: string): void {
    this.requireRestored();
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
    this.requireRestored();
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
    const next: DemoAccount =
      this.account?.phone === challenge.phone
        ? this.account
        : {
            version: 2,
            kind: 'local_demo',
            phone: challenge.phone,
            createdAt: this.io.now(),
            profile: emptyDemoProfile(),
          };
    // Persist before displaying success; a failed write leaves the challenge recoverable.
    await this.io.write(JSON.stringify(next));
    this.account = next;
    this.challenge = null;
  }
  async saveProfile(input: DemoProfileInput): Promise<void> {
    this.requireRestored();
    if (!this.account) throw new DemoLoginError('no_account');
    const now = this.io.now();
    const details = normalizeProfileDetails(input, now);
    if (!details || !Number.isSafeInteger(now) || now <= 0)
      throw new DemoLoginError('invalid_profile');
    const next: DemoAccount = { ...this.account, profile: { ...details, completedAt: now } };
    // The complete account is one storage write. Failure leaves the prior in-memory
    // profile unchanged; UI must not announce success before storage acknowledges it.
    await this.io.write(JSON.stringify(next));
    this.account = next;
  }
  cancelChallenge(): void {
    if (this.restoreBlocked) return;
    this.challenge = null;
  }
  async signOut(): Promise<void> {
    this.requireRestored();
    // Do not touch the independent order session or pending financial-command rehearsal.
    await this.io.remove();
    this.account = null;
    this.challenge = null;
  }
}
