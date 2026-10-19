import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Kiosk staff code (audit 19.10, findings 3.0, 3.3 and 3.4). Staff actions on the iPad - the demo
 * mode, «Начать заново» on a QR that may already be scanned, the service reset of a stuck kiosk -
 * require this code. It is checked only here: the kiosk never stores the code or its verifier, and
 * the owner configures `KIOSK_STAFF_PIN_VERIFIER` (scripts/kiosk-staff-pin.mjs). Without it every
 * staff action is unavailable, which is the safe default.
 */
export const KIOSK_STAFF_PIN = /^\d{4,8}$/;
/** Wrong codes per device before a lock, and the lock itself. */
export const KIOSK_STAFF_PIN_ATTEMPTS = 5;
export const KIOSK_STAFF_PIN_LOCK_MS = 15 * 60000;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } as const;

export class KioskStaffPinError extends Error {
  /** UNAUTHORIZED is a wrong code (401); a wrong device key stays FORBIDDEN (403). */
  constructor(readonly code: 'INVALID' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'NOT_READY') {
    super(code);
  }
}
const derive = (pin: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(pin, salt, 32, PARAMS, (error, key) => (error ? reject(error) : resolve(key)));
  });

/** Offline: the verifier line for the server environment. The code itself is never stored. */
export async function createKioskStaffPinVerifier(pin: string): Promise<string> {
  if (typeof pin !== 'string' || !KIOSK_STAFF_PIN.test(pin))
    throw new KioskStaffPinError('INVALID');
  const salt = randomBytes(16);
  return `scrypt1$${salt.toString('hex')}$${(await derive(pin, salt)).toString('hex')}`;
}
export type KioskStaffPinVerifier = { salt: Buffer; hash: Buffer };
/** Null when not configured (staff actions off); a malformed value stops the API at start. */
export function kioskStaffPinVerifier(env: NodeJS.ProcessEnv): KioskStaffPinVerifier | null {
  const value = env.KIOSK_STAFF_PIN_VERIFIER;
  if (!value) return null;
  const match = /^scrypt1\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(value);
  if (!match) throw new Error('Invalid KIOSK_STAFF_PIN_VERIFIER');
  return { salt: Buffer.from(match[1]!, 'hex'), hash: Buffer.from(match[2]!, 'hex') };
}

/**
 * Checks a staff code for an authenticated kiosk device. Wrong codes lock that device for
 * 15 minutes after five attempts; the scrypt budget of one process is bounded. Attempts live in
 * this process only (one API process today): a restart forgets them, and the kiosk keeps its own
 * lock as well.
 */
export class KioskStaffPin {
  private readonly failures = new Map<string, { count: number; until: number }>();
  private active = 0;
  constructor(
    private readonly verifier: KioskStaffPinVerifier | null,
    private readonly now: () => number = Date.now,
  ) {}
  get configured() {
    return !!this.verifier;
  }
  async verify(deviceId: string, input: unknown): Promise<void> {
    if (!this.verifier) throw new KioskStaffPinError('NOT_READY');
    const pin =
      !!input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input).length === 1 &&
      'pin' in input &&
      typeof input.pin === 'string'
        ? input.pin
        : null;
    if (pin === null || !KIOSK_STAFF_PIN.test(pin)) throw new KioskStaffPinError('INVALID');
    const previous = this.failures.get(deviceId);
    if ((previous && previous.until > this.now()) || this.active >= 4)
      throw new KioskStaffPinError('RATE_LIMITED');
    this.active++;
    let valid: boolean;
    try {
      valid = timingSafeEqual(await derive(pin, this.verifier.salt), this.verifier.hash);
    } finally {
      this.active--;
    }
    if (valid) {
      this.failures.delete(deviceId);
      return;
    }
    const count = (previous && previous.until === 0 ? previous.count : 0) + 1;
    if (count >= KIOSK_STAFF_PIN_ATTEMPTS) {
      this.failures.set(deviceId, { count: 0, until: this.now() + KIOSK_STAFF_PIN_LOCK_MS });
      throw new KioskStaffPinError('RATE_LIMITED');
    }
    this.failures.set(deviceId, { count, until: 0 });
    throw new KioskStaffPinError('UNAUTHORIZED');
  }
}
