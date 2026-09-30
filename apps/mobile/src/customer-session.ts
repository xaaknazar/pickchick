import { normalizeDemoPhone } from './demo-account.ts';
import { normalizeProfileDetails, type DemoProfileInput } from './profile-details.ts';

export type CustomerChannel = 'sms' | 'telegram';
export const CUSTOMER_CHANNEL_LABELS: Record<CustomerChannel, string> = {
  sms: 'SMS',
  telegram: 'Telegram',
};
const isChannel = (v: unknown): v is CustomerChannel => v === 'sms' || v === 'telegram';
export const CUSTOMER_SESSION_KEY = 'pickchick.customer.session.v1';
export interface Customer {
  id: string;
  phone: string;
  nickname: string;
  birth_date: string | null;
  gender: 'female' | 'male' | null;
  profile_completed_at: string | null;
  created_at: string;
}
export interface CustomerTokens {
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  session_id: string;
  customer: Customer;
}
export interface CustomerChallenge {
  channel: CustomerChannel;
  deliveryConsentVersion?: string;
  challenge_id: string;
  phone: string;
  expires_at: string;
  resend_at: string;
  delivery_status: 'submitted' | 'unknown';
}
export interface CustomerAuthConfig {
  channels: CustomerChannel[];
  channelSelection: boolean;
  deliveryConsentRequired: boolean;
  enabled: boolean;
  consent_version: string | null;
  terms_url: string | null;
  privacy_url: string | null;
}
export type CustomerRequest = (
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
  accessToken?: string,
) => Promise<unknown>;
export interface CustomerSessionIO {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
  request: CustomerRequest;
  randomId(): string;
  now(): number;
}
interface Envelope {
  version: 1;
  device_id: string;
  tokens: CustomerTokens | null;
  challenge: CustomerChallenge | null;
  otp_request: {
    request_id: string;
    phone: string;
    channel?: CustomerChannel;
    delivery_consent?: { privacy_version: string; accepted: true };
  } | null;
  verify_intent: { request_id: string; consent_version: string } | null;
  refresh_request_id: string | null;
  closing: 'logout' | null;
}
export class CustomerSessionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly authoritative: boolean;
  constructor(code: string, status = 0, authoritative = false) {
    super(code);
    this.code = code;
    this.status = status;
    this.authoritative = authoritative;
  }
}
function authoritative401(error: unknown): error is CustomerSessionError {
  return (
    error instanceof CustomerSessionError &&
    error.authoritative &&
    error.status === 401 &&
    error.code === 'UNAUTHORIZED'
  );
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const instant = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CustomerSessionError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
export function parseCustomer(value: unknown, now = Date.now()): Customer {
  const v = object(value);
  const profile = normalizeProfileDetails(
    { nickname: v.nickname, birthDate: v.birth_date, gender: v.gender },
    now,
  );
  if (
    typeof v.id !== 'string' ||
    !uuid.test(v.id) ||
    typeof v.phone !== 'string' ||
    normalizeDemoPhone(v.phone) !== v.phone ||
    !profile ||
    !instant(v.created_at) ||
    (v.profile_completed_at !== null && !instant(v.profile_completed_at))
  )
    throw new CustomerSessionError('INVALID_RESPONSE');
  return {
    id: v.id,
    phone: v.phone,
    nickname: profile.nickname,
    birth_date: profile.birthDate,
    gender: profile.gender,
    profile_completed_at: v.profile_completed_at,
    created_at: v.created_at,
  };
}
export function parseCustomerTokens(value: unknown, now = Date.now()): CustomerTokens {
  const v = object(value);
  for (const key of ['access_token', 'refresh_token']) {
    if (typeof v[key] !== 'string' || !/^[A-Za-z0-9._~-]{32,512}$/.test(v[key]))
      throw new CustomerSessionError('INVALID_RESPONSE');
  }
  if (!instant(v.access_expires_at) || typeof v.session_id !== 'string' || !uuid.test(v.session_id))
    throw new CustomerSessionError('INVALID_RESPONSE');
  return {
    access_token: v.access_token as string,
    refresh_token: v.refresh_token as string,
    access_expires_at: v.access_expires_at,
    session_id: v.session_id,
    customer: parseCustomer(v.customer, now),
  };
}
function parseChallenge(
  value: unknown,
  phone: string,
  expectedChannel: CustomerChannel = 'sms',
): CustomerChallenge {
  const v = object(value);
  if (
    (v.deliveryConsentVersion !== undefined &&
      (typeof v.deliveryConsentVersion !== 'string' ||
        !/^[A-Za-z0-9._-]{1,100}$/.test(v.deliveryConsentVersion))) ||
    (v.channel !== undefined && !isChannel(v.channel)) ||
    (v.channel ?? 'sms') !== expectedChannel ||
    typeof v.challenge_id !== 'string' ||
    !uuid.test(v.challenge_id) ||
    !instant(v.expires_at) ||
    !instant(v.resend_at) ||
    !['submitted', 'unknown'].includes(String(v.delivery_status))
  )
    throw new CustomerSessionError('INVALID_RESPONSE');
  return {
    challenge_id: v.challenge_id,
    channel: expectedChannel,
    ...(typeof v.deliveryConsentVersion === 'string'
      ? { deliveryConsentVersion: v.deliveryConsentVersion }
      : {}),
    phone,
    expires_at: v.expires_at,
    resend_at: v.resend_at,
    delivery_status: v.delivery_status as CustomerChallenge['delivery_status'],
  };
}
function parseEnvelope(raw: string, now: number): Envelope {
  if (raw.length > 16000) throw new CustomerSessionError('STORAGE_INVALID');
  const v = object(JSON.parse(raw));
  if (
    v.version !== 1 ||
    typeof v.device_id !== 'string' ||
    !uuid.test(v.device_id) ||
    ![null, 'logout'].includes(v.closing as null | string)
  )
    throw new CustomerSessionError('STORAGE_INVALID');
  for (const key of ['refresh_request_id'])
    if (v[key] !== null && (typeof v[key] !== 'string' || !uuid.test(v[key])))
      throw new CustomerSessionError('STORAGE_INVALID');
  const verify = v.verify_intent === null ? null : object(v.verify_intent);
  if (
    verify &&
    (typeof verify.request_id !== 'string' ||
      !uuid.test(verify.request_id) ||
      typeof verify.consent_version !== 'string' ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(verify.consent_version))
  )
    throw new CustomerSessionError('STORAGE_INVALID');
  const challenge = v.challenge === null ? null : object(v.challenge);
  if (
    challenge &&
    (typeof challenge.phone !== 'string' || normalizeDemoPhone(challenge.phone) !== challenge.phone)
  )
    throw new CustomerSessionError('STORAGE_INVALID');
  const tokens = v.tokens === null ? null : parseCustomerTokens(v.tokens, now);
  const pending = v.otp_request === null ? null : object(v.otp_request);
  if (
    pending &&
    ((pending.channel !== undefined && !isChannel(pending.channel)) ||
      (pending.delivery_consent !== undefined &&
        (!pending.delivery_consent ||
          typeof pending.delivery_consent !== 'object' ||
          Array.isArray(pending.delivery_consent) ||
          (pending.delivery_consent as Record<string, unknown>).accepted !== true ||
          typeof (pending.delivery_consent as Record<string, unknown>).privacy_version !==
            'string' ||
          !/^[A-Za-z0-9._-]{1,100}$/.test(
            (pending.delivery_consent as { privacy_version: string }).privacy_version,
          ))) ||
      typeof pending.request_id !== 'string' ||
      !uuid.test(pending.request_id) ||
      typeof pending.phone !== 'string' ||
      normalizeDemoPhone(pending.phone) !== pending.phone)
  )
    throw new CustomerSessionError('STORAGE_INVALID');
  if ((v.refresh_request_id !== null && !tokens) || (verify !== null && !challenge))
    throw new CustomerSessionError('STORAGE_INVALID');
  return {
    version: 1,
    device_id: v.device_id,
    tokens,
    challenge: challenge
      ? parseChallenge(
          challenge,
          challenge.phone as string,
          (challenge.channel ?? 'sms') as CustomerChannel,
        )
      : null,
    otp_request: pending as Envelope['otp_request'],
    verify_intent: verify as Envelope['verify_intent'],
    refresh_request_id: v.refresh_request_id as string | null,
    closing: v.closing as Envelope['closing'],
  };
}

/** Personal customer credentials only. It never adopts the separate local demo or TEST order identity. */
export class CustomerSessionCore {
  private io: CustomerSessionIO;
  private state: Envelope | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private restored = false;
  config: CustomerAuthConfig = {
    enabled: false,
    channels: [],
    channelSelection: false,
    deliveryConsentRequired: false,
    consent_version: null,
    terms_url: null,
    privacy_url: null,
  };
  constructor(io: CustomerSessionIO) {
    this.io = io;
  }
  get customer(): Customer | null {
    return this.state?.closing ? null : (this.state?.tokens?.customer ?? null);
  }
  get challenge(): CustomerChallenge | null {
    return this.state?.challenge ?? null;
  }
  get pendingVerify(): boolean {
    return Boolean(this.state?.verify_intent);
  }
  get pendingChannel(): CustomerChannel | null {
    return this.state?.otp_request ? (this.state.otp_request.channel ?? 'sms') : null;
  }
  get pendingPhone(): string | null {
    return this.state?.otp_request?.phone ?? null;
  }
  get pendingOtp(): boolean {
    return Boolean(this.state?.otp_request);
  }
  get ready(): boolean {
    return this.restored;
  }
  get closing(): boolean {
    return this.state?.closing === 'logout';
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private current(): Envelope {
    if (!this.restored || !this.state) throw new CustomerSessionError('RESTORE_REQUIRED');
    return this.state;
  }
  private async persist(next: Envelope): Promise<void> {
    await this.io.write(JSON.stringify(next));
    this.state = next;
  }
  restore(): Promise<void> {
    return this.serial(async () => {
      this.restored = false;
      const raw = await this.io.read();
      // An unreadable credential must never be overwritten with a new identity.
      const next =
        raw === null
          ? {
              version: 1 as const,
              device_id: this.io.randomId(),
              tokens: null,
              challenge: null,
              otp_request: null,
              verify_intent: null,
              refresh_request_id: null,
              closing: null,
            }
          : parseEnvelope(raw, this.io.now());
      if (!raw) await this.persist(next);
      else this.state = next;
      this.restored = true;
    });
  }
  async loadConfig(): Promise<void> {
    const v = object(await this.io.request('/v1/auth/config', 'GET'));
    if (
      typeof v.enabled !== 'boolean' ||
      (v.consent_version !== null &&
        (typeof v.consent_version !== 'string' ||
          !v.consent_version ||
          v.consent_version.length > 100)) ||
      (v.enabled && v.consent_version === null)
    )
      throw new CustomerSessionError('INVALID_RESPONSE');
    for (const key of ['terms_url', 'privacy_url']) {
      const value = v[key];
      if (value === null && !v.enabled) continue;
      if (typeof value !== 'string' || value.length > 2048)
        throw new CustomerSessionError('INVALID_RESPONSE');
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new CustomerSessionError('INVALID_RESPONSE');
    }
    if (
      (v.delivery_consent_required !== undefined &&
        typeof v.delivery_consent_required !== 'boolean') ||
      (v.channels !== undefined &&
        (!Array.isArray(v.channels) ||
          v.channels.some((c) => !isChannel(c)) ||
          new Set(v.channels).size !== v.channels.length ||
          (v.enabled && v.channels.length === 0)))
    )
      throw new CustomerSessionError('INVALID_RESPONSE');
    this.config = {
      channels: v.enabled ? ((v.channels as CustomerChannel[] | undefined) ?? ['sms']) : [],
      channelSelection: v.channels !== undefined,
      deliveryConsentRequired: v.delivery_consent_required === true,
      enabled: v.enabled,
      consent_version: v.consent_version as string | null,
      terms_url: v.terms_url as string | null,
      privacy_url: v.privacy_url as string | null,
    };
  }
  requestCode(
    input: string,
    channel: CustomerChannel = 'sms',
    acceptedDeliveryVersion: string | null = null,
  ): Promise<void> {
    return this.serial(async () => {
      let s = this.current();
      if (s.tokens || s.closing) throw new CustomerSessionError('ALREADY_SIGNED_IN');
      const phone = normalizeDemoPhone(input);
      if (!phone) throw new CustomerSessionError('INVALID_PHONE');
      await this.loadConfig();
      if (!isChannel(channel) || !this.config.channels.includes(channel))
        throw new CustomerSessionError('SERVICE_UNAVAILABLE', 503);
      if (!this.config.enabled) throw new CustomerSessionError('SERVICE_UNAVAILABLE', 503);
      if (
        this.config.deliveryConsentRequired &&
        acceptedDeliveryVersion !== this.config.consent_version
      )
        throw new CustomerSessionError('CONSENT_REQUIRED');
      if (
        !s.otp_request &&
        s.challenge?.phone === phone &&
        this.io.now() < Date.parse(s.challenge.resend_at)
      )
        throw new CustomerSessionError('RATE_LIMITED', 429);
      if (
        s.otp_request &&
        (s.otp_request.phone !== phone ||
          (s.otp_request.channel ?? 'sms') !== channel ||
          (this.config.deliveryConsentRequired &&
            s.otp_request.delivery_consent?.privacy_version !== acceptedDeliveryVersion))
      )
        throw new CustomerSessionError('CONFLICT', 409);
      if (!s.otp_request) {
        await this.persist({
          ...s,
          otp_request: {
            request_id: this.io.randomId(),
            phone,
            ...(this.config.channelSelection ? { channel } : {}),
            ...(this.config.deliveryConsentRequired
              ? {
                  delivery_consent: {
                    privacy_version: acceptedDeliveryVersion!,
                    accepted: true as const,
                  },
                }
              : {}),
          },
        });
        s = this.current();
      }
      let challenge: CustomerChallenge;
      try {
        challenge = parseChallenge(
          await this.io.request('/v1/auth/otp/request', 'POST', {
            phone,
            device_id: s.device_id,
            request_id: s.otp_request!.request_id,
            ...(s.otp_request!.channel ? { channel: s.otp_request!.channel } : {}),
            ...(s.otp_request!.delivery_consent
              ? { delivery_consent: s.otp_request!.delivery_consent }
              : {}),
          }),
          phone,
          channel,
        );
      } catch (error) {
        // Definitive validation/rate/conflict replies did not leave a usable challenge.
        // Unknown transport or provider outcomes retain their original key for safe retry.
        if (
          error instanceof CustomerSessionError &&
          error.authoritative &&
          [400, 409, 429].includes(error.status)
        )
          await this.persist({ ...s, otp_request: null });
        throw error;
      }
      challenge.deliveryConsentVersion = s.otp_request?.delivery_consent?.privacy_version;
      await this.persist({ ...s, challenge, otp_request: null, verify_intent: null });
    });
  }
  verifyCode(code: string, acceptedVersion: string | null): Promise<void> {
    return this.serial(async () => {
      let s = this.current();
      if (!s.challenge) throw new CustomerSessionError('NO_CHALLENGE');
      if (!/^\d{6}$/.test(code)) throw new CustomerSessionError('INVALID_CODE');
      if (!s.verify_intent) {
        if (!acceptedVersion || acceptedVersion !== this.config.consent_version)
          throw new CustomerSessionError('CONSENT_REQUIRED');
        if (!this.config.enabled) throw new CustomerSessionError('SERVICE_UNAVAILABLE', 503);
        await this.persist({
          ...s,
          verify_intent: { request_id: this.io.randomId(), consent_version: acceptedVersion },
        });
        s = this.current();
      }
      // The exact accepted policy survives AppState refreshes, app restart, and a lost response.
      const intent = s.verify_intent!;
      let result: CustomerTokens;
      try {
        result = parseCustomerTokens(
          await this.io.request('/v1/auth/otp/verify', 'POST', {
            challenge_id: s.challenge!.challenge_id,
            code,
            device_id: s.device_id,
            request_id: intent.request_id,
            consents: {
              terms_version: intent.consent_version,
              privacy_version: intent.consent_version,
              marketing_opt_in: false,
            },
          }),
          this.io.now(),
        );
      } catch (error) {
        if (
          error instanceof CustomerSessionError &&
          error.authoritative &&
          [400, 401, 429].includes(error.status)
        )
          await this.persist({ ...s, verify_intent: null });
        throw error;
      }
      if (result.customer.phone !== s.challenge!.phone)
        throw new CustomerSessionError('IDENTITY_MISMATCH');
      await this.persist({
        ...s,
        tokens: result,
        challenge: null,
        verify_intent: null,
        refresh_request_id: null,
      });
    });
  }
  private async refresh(): Promise<string> {
    let s = this.current();
    if (!s.tokens) throw new CustomerSessionError('UNAUTHORIZED', 401);
    if (!s.refresh_request_id && Date.parse(s.tokens.access_expires_at) > this.io.now() + 30000)
      return s.tokens.access_token;
    if (!s.refresh_request_id) {
      await this.persist({ ...s, refresh_request_id: this.io.randomId() });
      s = this.current();
    }
    let result: CustomerTokens;
    try {
      result = parseCustomerTokens(
        await this.io.request('/v1/auth/refresh', 'POST', {
          refresh_token: s.tokens!.refresh_token,
          device_id: s.device_id,
          request_id: s.refresh_request_id,
        }),
        this.io.now(),
      );
    } catch (error) {
      // Only an authoritative revocation may discard access. 409/429/5xx/offline retain the exact retry.
      if (authoritative401(error))
        await this.persist({
          ...s,
          tokens: null,
          refresh_request_id: null,
          challenge: null,
          verify_intent: null,
        });
      throw error;
    }
    if (result.session_id !== s.tokens!.session_id || result.customer.id !== s.tokens!.customer.id)
      throw new CustomerSessionError('IDENTITY_MISMATCH');
    await this.persist({ ...s, tokens: result, refresh_request_id: null });
    return result.access_token;
  }
  accessToken(): Promise<string> {
    return this.serial(async () => {
      if (this.current().closing) throw new CustomerSessionError('LOGOUT_PENDING');
      // A recovered receipt may contain an expired access token but the valid successor refresh.
      await this.refresh();
      return this.refresh();
    });
  }
  /** Order HTTP owns its timeout/abort. Serialize only token rotation, never the long poll. */
  async withAccess<T>(customerId: string, send: (token: string) => Promise<T>): Promise<T> {
    const check = () => {
      const state = this.current();
      if (state.closing || state.tokens?.customer.id !== customerId)
        throw new CustomerSessionError('UNAUTHORIZED', 401, true);
    };
    const access = await this.serial(async () => {
      check();
      await this.refresh();
      return this.refresh();
    });
    let result: T;
    try {
      result = await send(access);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 401)
        throw error;
      const next = await this.serial(async () => {
        check();
        const state = this.current();
        if (state.tokens!.access_token === access)
          await this.persist({
            ...state,
            tokens: { ...state.tokens!, access_expires_at: new Date(0).toISOString() },
          });
        await this.refresh();
        return this.refresh();
      });
      result = await send(next);
    }
    check();
    return result;
  }
  private async authenticated(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ): Promise<unknown> {
    await this.refresh();
    let token = await this.refresh();
    try {
      return await this.io.request(path, method, body, token);
    } catch (error) {
      if (!authoritative401(error)) throw error;
      const s = this.current();
      if (!s.tokens) throw error;
      await this.persist({
        ...s,
        tokens: { ...s.tokens, access_expires_at: new Date(0).toISOString() },
      });
      token = await this.refresh();
      return this.io.request(path, method, body, token);
    }
  }
  sync(): Promise<void> {
    return this.serial(async () => {
      const s = this.current();
      if (s.closing) {
        await this.finishLogout();
        return;
      }
      if (!s.tokens) {
        await this.loadConfig();
        return;
      }
      await this.loadConfig();
      const v = object(await this.authenticated('/v1/customers/me', 'GET'));
      const customer = parseCustomer(v.customer, this.io.now());
      const current = this.current();
      if (customer.id !== current.tokens?.customer.id)
        throw new CustomerSessionError('IDENTITY_MISMATCH');
      await this.persist({ ...current, tokens: { ...current.tokens!, customer } });
    });
  }
  saveProfile(input: DemoProfileInput): Promise<void> {
    return this.serial(async () => {
      if (this.current().closing) throw new CustomerSessionError('LOGOUT_PENDING');
      const profile = normalizeProfileDetails(input, this.io.now());
      if (!profile) throw new CustomerSessionError('INVALID_PROFILE');
      const v = object(
        await this.authenticated('/v1/customers/me', 'PATCH', {
          nickname: profile.nickname,
          birth_date: profile.birthDate,
          gender: profile.gender,
        }),
      );
      const s = this.current();
      const customer = parseCustomer(v.customer, this.io.now());
      if (customer.id !== s.tokens?.customer.id)
        throw new CustomerSessionError('IDENTITY_MISMATCH');
      await this.persist({ ...s, tokens: { ...s.tokens!, customer } });
    });
  }
  cancelChallenge(): Promise<void> {
    return this.serial(async () => {
      await this.persist({
        ...this.current(),
        challenge: null,
        otp_request: null,
        verify_intent: null,
      });
    });
  }
  private async finishLogout(): Promise<void> {
    const s = this.current();
    if (!s.tokens) {
      await this.persist({ ...s, closing: null });
      return;
    }
    try {
      await this.authenticated('/v1/auth/logout', 'POST');
    } catch (error) {
      if (!authoritative401(error)) throw error;
    }
    await this.persist({
      ...this.current(),
      tokens: null,
      challenge: null,
      otp_request: null,
      verify_intent: null,
      refresh_request_id: null,
      closing: null,
    });
  }
  signOut(): Promise<void> {
    return this.serial(async () => {
      await this.persist({
        ...this.current(),
        closing: 'logout',
        challenge: null,
        otp_request: null,
        verify_intent: null,
      });
      await this.finishLogout();
    });
  }
  deleteAccount(): Promise<void> {
    return this.serial(async () => {
      if (this.current().closing) throw new CustomerSessionError('LOGOUT_PENDING');
      // A failed response is not proof of deletion: retain credentials and show the failure.
      const result = object(await this.authenticated('/v1/customers/me', 'DELETE'));
      if (result.ok !== true) throw new CustomerSessionError('INVALID_RESPONSE');
      await this.persist({
        ...this.current(),
        tokens: null,
        challenge: null,
        otp_request: null,
        verify_intent: null,
        refresh_request_id: null,
        closing: null,
      });
    });
  }
}
