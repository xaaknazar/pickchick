import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { transaction } from '@pickchick/database';
import type { DatabasePool, DatabaseClient } from '@pickchick/database';
import { phoneDeliveryChannels } from '@pickchick/phone-verification';
import type {
  PhoneDeliveryChannel,
  PhoneCodeDelivery,
  PhoneCodeDeliveryResult,
} from '@pickchick/phone-verification';
import {
  CustomerIdentityError,
  CustomerSessionSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  RefreshRequestSchema,
  CustomerPatchSchema,
  normalizeKazakhstanPhone,
  isValidCustomerBirthDate,
  parseInput,
} from './contracts.js';
import type { Customer, CustomerProfile, CustomerSession, OtpResponse } from './contracts.js';
import type { CustomerIdentityOptions } from './config.js';
import { reviewCodeDigest } from './config.js';
import { digest, hmac, equalHash, encrypt, decrypt } from './crypto.js';
export * from './contracts.js';
export * from './config.js';
export const CUSTOMER_IDENTITY = Symbol('CUSTOMER_IDENTITY');
const ACCESS_MS = 15 * 60_000,
  CHALLENGE_MS = 3 * 60_000,
  VERIFY_RECEIPT_MS = 24 * 60 * 60_000,
  DAY_MS = 24 * 60 * 60_000,
  // Concurrent refreshes of one device may present the just-rotated token for this long.
  REUSE_GRACE_MS = 60_000,
  // Rotated-away refresh hashes kept per live session for reuse detection.
  RETIRED_REFRESH_KEPT = 64,
  REVIEW_PROVIDER = 'review_account';
/**
 * Abuse limits (audit 19.10: 5.3, 2.6, 5.4). Installed apps still get 4-digit Telegram codes,
 * so guessing is bounded per phone across challenges, durably (challenges are purged after
 * 24 h). Requests that were never verified ("open") are limited per address and per /24
 * (IPv6 /64 and /48), while verified logins behind a shared carrier address are not.
 */
export const OTP_LIMITS = {
  attemptsFourDigit: 3,
  attemptsSixDigit: 5,
  phoneFailuresDay: 6,
  phoneFailuresMonth: 12,
  addressOpenHour: 20,
  addressOpenDay: 60,
  networkOpenHour: 60,
  networkOpenDay: 200,
  addressHour: 300,
  addressDay: 2000,
  addressFailuresDay: 40,
} as const;
const attemptsFor = (length: 4 | 6) =>
  length === 4 ? OTP_LIMITS.attemptsFourDigit : OTP_LIMITS.attemptsSixDigit;
type EnabledOptions = Extract<CustomerIdentityOptions, { enabled: true }>;
export type IdentityEvent = Record<string, string | number | boolean>;
const logEvent = (event: IdentityEvent) => console.warn(JSON.stringify(event));
function ipv6Groups(value: string): string[] {
  const groups = (part: string | undefined) =>
    part
      ? part.split(':').flatMap((g) => {
          if (!g.includes('.')) return [g];
          const [a = 0, b = 0, c = 0, d = 0] = g.split('.').map(Number);
          return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
        })
      : [];
  const [head, tail] = value.toLowerCase().split('%')[0]!.split('::');
  const left = groups(head),
    right = groups(tail);
  const full =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return full.map((g) => parseInt(g, 16).toString(16));
}
/** A subscriber address (IPv4, or the IPv6 /64) and its network (/24, or the IPv6 /48). */
export function clientNetworks(ip: string): { address: string; network: string } {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.');
    return { address: ip, network: `${a}.${b}.${c}.0/24` };
  }
  const groups = ipv6Groups(ip);
  return {
    address: groups.slice(0, 4).join(':') + '::/64',
    network: groups.slice(0, 3).join(':') + '::/48',
  };
}
interface CustomerRow {
  id: string;
  phone_lookup: string | null;
  phone_cipher: string | null;
  profile_cipher: string | null;
  profile_completed_at: Date | null;
  created_at: Date;
  deleted_at: Date | null;
}
interface SessionRow {
  id: string;
  customer_id: string;
  device_hash: string;
  access_hash: string | null;
  access_expires_at: Date;
  refresh_hash: string | null;
  generation: string;
  created_at: Date;
  refreshed_at: Date;
  revoked_at: Date | null;
}
interface ChallengeRow {
  delivery_channel: PhoneDeliveryChannel;
  delivery_provider: string | null;
  requested_channel: 'sms' | 'telegram' | 'auto';
  delivery_consent_version: string | null;
  id: string;
  phone_lookup: string;
  phone_cipher: string | null;
  device_hash: string;
  code_hash: string | null;
  code_length: 4 | 6;
  attempts: number;
  receipt_failed_attempts: number;
  state: string;
  created_at: Date;
  expires_at: Date;
  verify_request_id: string | null;
  verify_input_hash: string | null;
  response_cipher: string | null;
  receipt_expires_at: Date | null;
  session_id: string | null;
  initial_refresh_hash: string | null;
}
const fail = (code: ConstructorParameters<typeof CustomerIdentityError>[0]) =>
  new CustomerIdentityError(code);
const unwrap = <T>(value: T | CustomerIdentityError): T => {
  if (value instanceof CustomerIdentityError) throw value;
  return value;
};
const iso = (value: Date) => value.toISOString();

/** PostgreSQL owns attempts, budgets, credentials and receipts. No Redis or in-process session authority. */
export class CustomerIdentity {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: CustomerIdentityOptions,
    private readonly delivery: PhoneCodeDelivery,
    private readonly events: (event: IdentityEvent) => void = logEvent,
  ) {}
  private readonly deliveryAlerts = new Map<string, number>();
  /**
   * The provider refused the code for a reason that is not the recipient's (Gateway balance,
   * token, configuration): nobody can sign in. At most one event per channel/reason in 5 min.
   */
  private deliveryAttention(channel: PhoneDeliveryChannel, reason: string) {
    const key = `${channel}:${reason}`,
      at = Date.now();
    if ((this.deliveryAlerts.get(key) ?? -Infinity) > at - 5 * 60_000) return;
    this.deliveryAlerts.set(key, at);
    this.events({ event: 'customer_otp_delivery_attention', channel, reason });
  }
  /** The App Review phone (enabled or not) never pays or places TEST orders. */
  isReviewCustomer(customer: Pick<Customer, 'phone'>): boolean {
    return !!this.options.reviewAccount && customer.phone === this.options.reviewAccount.phone;
  }
  private reviewLogin(phone: string): string | null {
    const review = this.options.reviewAccount;
    return review?.enabled && review.codeDigest && review.phone === phone
      ? review.codeDigest
      : null;
  }
  /**
   * Failed code checks for this phone across all its challenges (hour buckets, 30 days).
   * A device that already held a session of this phone's customer is the owner's own device
   * (its random device_id never leaves it), so guessing by others cannot lock the owner out
   * of signing in again there, for example after the session lifetime ended.
   */
  private async phoneLocked(
    db: DatabaseClient,
    lookup: string,
    deviceHash: string,
    now: Date,
  ): Promise<boolean> {
    const row = (
      await db.query<{ day: string; month: string }>(
        `SELECT coalesce(sum(failures) FILTER (WHERE failure_hour>$2::timestamptz-interval '24 hours'),0)::text AS day,
                coalesce(sum(failures),0)::text AS month
         FROM identity_otp_failures WHERE phone_lookup=$1 AND failure_hour>$2::timestamptz-interval '30 days'`,
        [lookup, now],
      )
    ).rows[0]!;
    if (
      Number(row.day) < OTP_LIMITS.phoneFailuresDay &&
      Number(row.month) < OTP_LIMITS.phoneFailuresMonth
    )
      return false;
    const known = await db.query(
      `SELECT 1 FROM identity_sessions s JOIN identity_customers c ON c.id=s.customer_id
       WHERE c.phone_lookup=$1 AND c.deleted_at IS NULL AND s.device_hash=$2 LIMIT 1`,
      [lookup, deviceHash],
    );
    return known.rowCount === 0;
  }
  private sessionExpired(session: SessionRow, now: Date): boolean {
    const config = this.options.enabled ? this.options : null;
    const max = (config?.sessionMaxDays ?? 90) * DAY_MS,
      idle = (config?.sessionIdleDays ?? 30) * DAY_MS;
    return (
      now.getTime() >= session.created_at.getTime() + max ||
      now.getTime() >= session.refreshed_at.getTime() + idle
    );
  }
  config() {
    if (!this.options.enabled || phoneDeliveryChannels(this.delivery).length === 0)
      return { enabled: false, consent_version: null, terms_url: null, privacy_url: null };
    const channels = phoneDeliveryChannels(this.delivery);
    return {
      enabled: true,
      // Old mobile clients only understand the legacy direct-request channels.
      channels: channels.filter((channel) => channel !== 'whatsapp'),
      ...(channels.includes('telegram') ? { channel_selection: 'automatic' as const } : {}),
      ...(channels.includes('whatsapp') ? { whatsapp_fallback_enabled: true } : {}),
      delivery_consent_required: true,
      consent_version: this.options.consentVersion,
      terms_url: this.options.termsUrl,
      privacy_url: this.options.privacyUrl,
    };
  }
  private enabled(): EnabledOptions {
    if (!this.options.enabled || phoneDeliveryChannels(this.delivery).length === 0)
      throw fail('SERVICE_UNAVAILABLE');
    return this.options;
  }
  private async now(db: DatabaseClient): Promise<Date> {
    return (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  }
  private async phoneLock(db: DatabaseClient, lookup: string) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 90827))', [
      `identity:${lookup}`,
    ]);
  }
  private customer(row: CustomerRow, config: EnabledOptions): Customer {
    if (row.deleted_at || !row.phone_cipher || !row.profile_cipher) throw fail('UNAUTHORIZED');
    const profile = decrypt<CustomerProfile>(
      config.piiKey,
      `profile:${row.id}`,
      row.profile_cipher,
    );
    return {
      id: row.id,
      phone: decrypt<string>(config.piiKey, `phone:${row.id}`, row.phone_cipher),
      ...profile,
      profile_completed_at: row.profile_completed_at ? iso(row.profile_completed_at) : null,
      created_at: iso(row.created_at),
    };
  }
  async requestOtp(input: unknown, clientIp: string): Promise<OtpResponse> {
    const config = this.enabled(),
      body = parseInput(OtpRequestSchema, input),
      phone = normalizeKazakhstanPhone(body.phone),
      channel = body.channel ?? 'sms';
    if (body.delivery_consent.privacy_version !== config.consentVersion)
      throw fail('INVALID_REQUEST');
    // Missing channel belongs to legacy SMS clients, never silently reroute to Telegram.
    const availableChannels = phoneDeliveryChannels(this.delivery);
    if (
      channel === 'auto'
        ? !availableChannels.includes('telegram')
        : !availableChannels.includes(channel)
    )
      throw fail('SERVICE_UNAVAILABLE');
    // Caller must supply the trusted socket/proxy-resolved address, never an untrusted forwarding header.
    if (!isIP(clientIp)) throw fail('INVALID_REQUEST');
    const ip =
      clientIp.startsWith('::ffff:') && isIP(clientIp.slice(7)) === 4
        ? clientIp.slice(7)
        : clientIp.toLowerCase();
    const where = clientNetworks(ip);
    const phoneHash = hmac(config.lookupKey, 'phone', phone),
      deviceHash = hmac(config.lookupKey, 'device', body.device_id),
      ipHash = hmac(config.lookupKey, 'ip', where.address),
      netHash = hmac(config.lookupKey, 'ip-net', where.network);
    const id = randomUUID(),
      codeLength: 4 | 6 = channel === 'telegram' || channel === 'auto' ? 4 : 6,
      code = String(randomInt(0, 10 ** codeLength)).padStart(codeLength, '0');
    // App Review: a fixed code (only its digest is configured), nothing is sent or budgeted.
    const review = this.reviewLogin(phone);
    const newPhoneCap = Math.max(
      1,
      Math.floor((config.dailySmsBudget * (config.newPhoneBudgetPercent ?? 80)) / 100),
    );
    const reservation = await transaction(this.pool, async (db) => {
      // The budget lock serializes only this short reservation transaction, never the provider call.
      await db.query('SELECT pg_advisory_xact_lock(90827001)');
      await this.phoneLock(db, phoneHash);
      if (
        (
          await db.query('SELECT 1 FROM identity_otp_request_tombstones WHERE request_id=$1', [
            body.request_id,
          ])
        ).rowCount
      )
        throw fail('CONFLICT');
      const replay = (
        await db.query<ChallengeRow>('SELECT * FROM identity_otp_challenges WHERE request_id=$1', [
          body.request_id,
        ])
      ).rows[0];
      if (replay) {
        if (
          replay.phone_lookup !== phoneHash ||
          replay.device_hash !== deviceHash ||
          replay.requested_channel !== channel ||
          replay.delivery_consent_version !== body.delivery_consent.privacy_version
        )
          throw fail('CONFLICT');
        if (replay.state === 'rejected') throw fail('SERVICE_UNAVAILABLE');
        return {
          replay: true,
          refund: null,
          attention: [] as IdentityEvent[],
          challenge_id: replay.id,
          code_length: replay.code_length,
          expires_at: iso(replay.expires_at),
          resend_at: iso(new Date(replay.created_at.getTime() + 60_000)),
          delivery_status:
            replay.state === 'submitted' || replay.state === 'consumed'
              ? ('submitted' as const)
              : ('unknown' as const),
          delivery_channel: replay.delivery_channel,
        };
      }
      const now = await this.now(db),
        hour = new Date(now.getTime() - 3_600_000),
        day = new Date(now.getTime() - 86_400_000);
      const counts = (
        await db.query<{
          phone_hour: string;
          phone_day: string;
          device_hour: string;
          device_day: string;
          ip_hour: string;
          ip_day: string;
          ip_open_hour: string;
          ip_open_day: string;
          net_open_hour: string;
          net_open_day: string;
          ip_failures: string;
          last_phone: Date | null;
          last_device: Date | null;
        }>(
          `SELECT
          count(*) FILTER (WHERE phone_lookup=$1 AND created_at>$4)::text AS phone_hour,
          count(*) FILTER (WHERE phone_lookup=$1)::text AS phone_day,
          count(*) FILTER (WHERE device_hash=$2 AND created_at>$4)::text AS device_hour,
          count(*) FILTER (WHERE device_hash=$2)::text AS device_day,
          count(*) FILTER (WHERE ip_hash=$3 AND created_at>$4)::text AS ip_hour,
          count(*) FILTER (WHERE ip_hash=$3)::text AS ip_day,
          count(*) FILTER (WHERE ip_hash=$3 AND state<>'consumed' AND created_at>$4)::text AS ip_open_hour,
          count(*) FILTER (WHERE ip_hash=$3 AND state<>'consumed')::text AS ip_open_day,
          count(*) FILTER (WHERE ip_net_hash=$6 AND state<>'consumed' AND created_at>$4)::text AS net_open_hour,
          count(*) FILTER (WHERE ip_net_hash=$6 AND state<>'consumed')::text AS net_open_day,
          (coalesce(sum(attempts) FILTER (WHERE ip_hash=$3),0)
            - count(*) FILTER (WHERE ip_hash=$3 AND state='consumed'))::text AS ip_failures,
          max(created_at) FILTER (WHERE phone_lookup=$1) AS last_phone,
          max(created_at) FILTER (WHERE device_hash=$2) AS last_device
         FROM identity_otp_challenges
         WHERE created_at>$5 AND (phone_lookup=$1 OR device_hash=$2 OR ip_hash=$3 OR ip_net_hash=$6)`,
          [phoneHash, deviceHash, ipHash, hour, day, netHash],
        )
      ).rows[0]!;
      const limits = OTP_LIMITS;
      if (
        // Per phone first: a shared carrier address must not decide a real customer's login.
        Number(counts.phone_hour) >= 5 ||
        Number(counts.phone_day) >= 10 ||
        (await this.phoneLocked(db, phoneHash, deviceHash, now)) ||
        Number(counts.device_hour) >= 10 ||
        Number(counts.device_day) >= 30 ||
        Number(counts.ip_open_hour) >= limits.addressOpenHour ||
        Number(counts.ip_open_day) >= limits.addressOpenDay ||
        Number(counts.net_open_hour) >= limits.networkOpenHour ||
        Number(counts.net_open_day) >= limits.networkOpenDay ||
        Number(counts.ip_hour) >= limits.addressHour ||
        Number(counts.ip_day) >= limits.addressDay ||
        Number(counts.ip_failures) >= limits.addressFailuresDay ||
        [counts.last_phone, counts.last_device].some(
          (last) => last && now.getTime() - last.getTime() < 60_000,
        )
      )
        throw fail('RATE_LIMITED');
      const attention: IdentityEvent[] = [];
      let refund: { now: Date; newPhone: boolean } | null = null;
      if (!review) {
        // New phones may use only their share; returning customers keep the rest of the day.
        const newPhone = !(
          await db.query('SELECT 1 FROM identity_customers WHERE phone_lookup=$1', [phoneHash])
        ).rowCount;
        const budget = await db.query<{ reservations: number; new_phone_reservations: number }>(
          `INSERT INTO identity_sms_daily_budget(budget_day,reservations,new_phone_reservations)
           VALUES (($1::timestamptz AT TIME ZONE 'UTC')::date,1,$3)
           ON CONFLICT(budget_day) DO UPDATE SET reservations=identity_sms_daily_budget.reservations+1,
             new_phone_reservations=identity_sms_daily_budget.new_phone_reservations+$3
           WHERE identity_sms_daily_budget.reservations<$2
             AND ($3=0 OR identity_sms_daily_budget.new_phone_reservations<$4)
           RETURNING reservations,new_phone_reservations`,
          [now, config.dailySmsBudget, newPhone ? 1 : 0, newPhoneCap],
        );
        if (budget.rowCount !== 1) throw fail('RATE_LIMITED');
        const used = budget.rows[0]!;
        for (const percent of [50, 80, 100])
          if (used.reservations === Math.ceil((config.dailySmsBudget * percent) / 100))
            attention.push({
              event: 'customer_otp_budget_attention',
              pool: 'all',
              percent,
              budget: config.dailySmsBudget,
            });
        if (newPhone && newPhoneCap < config.dailySmsBudget)
          for (const percent of [80, 100])
            if (used.new_phone_reservations === Math.ceil((newPhoneCap * percent) / 100))
              attention.push({
                event: 'customer_otp_budget_attention',
                pool: 'new_phones',
                percent,
                budget: newPhoneCap,
              });
        refund = { now, newPhone };
      }
      await db.query(
        "UPDATE identity_otp_challenges SET state='superseded', code_hash=NULL,phone_cipher=NULL WHERE phone_lookup=$1 AND state IN ('reserved','submitted','unknown')",
        [phoneHash],
      );
      const expires = new Date(now.getTime() + CHALLENGE_MS);
      await db.query(
        `INSERT INTO identity_otp_challenges(id,phone_lookup,phone_cipher,device_hash,ip_hash,code_hash,state,created_at,expires_at,request_id,delivery_channel,requested_channel,delivery_consent_version,code_length,ip_net_hash,delivery_provider)
         VALUES($1,$2,$3,$4,$5,$6,$14,$7,$8,$9,$10,$11,$12,$13,$15,$16)`,
        [
          id,
          phoneHash,
          encrypt(config.piiKey, `challenge:${id}`, phone),
          deviceHash,
          ipHash,
          hmac(config.otpKey, `otp:${id}:${deviceHash}`, review ?? code),
          now,
          expires,
          body.request_id,
          channel === 'auto' ? 'telegram' : channel,
          channel,
          body.delivery_consent.privacy_version,
          codeLength,
          review ? 'submitted' : 'reserved',
          netHash,
          review ? REVIEW_PROVIDER : null,
        ],
      );
      return {
        replay: false,
        refund,
        attention,
        challenge_id: id,
        code_length: codeLength,
        expires_at: iso(expires),
        resend_at: iso(new Date(now.getTime() + 60_000)),
        delivery_status: review ? ('submitted' as const) : ('unknown' as const),
        delivery_channel: channel === 'auto' ? ('telegram' as const) : channel,
      };
    });
    for (const event of reservation.attention) this.events(event);
    const response = {
      ...(body.channel ? { channel: reservation.delivery_channel } : {}),
      challenge_id: reservation.challenge_id,
      code_length: reservation.code_length,
      expires_at: reservation.expires_at,
      resend_at: reservation.resend_at,
    };
    if (reservation.replay || review)
      return { ...response, delivery_status: reservation.delivery_status };
    // A crash/timeout here leaves a durable unknown reservation. It must never be dispatched again.
    let state: 'submitted' | 'unknown' | 'rejected';
    let actualChannel: PhoneDeliveryChannel = channel === 'auto' ? 'telegram' : channel;
    let submitted: Extract<PhoneCodeDeliveryResult, { kind: 'submitted' }> | undefined;
    // Only a definite "this number cannot receive it" before any message went out is refunded.
    let undeliverable = false;
    try {
      let result = await this.delivery.sendCode({ phoneE164: phone, code }, actualChannel);
      if (
        channel === 'auto' &&
        result.kind === 'rejected' &&
        result.reason === 'recipient_unavailable' &&
        availableChannels.includes('whatsapp')
      ) {
        // This committed update is the second attempt's durable reservation. A
        // crash or replay here returns unknown and must never dispatch again.
        const switched = await transaction(this.pool, async (db) => {
          await this.phoneLock(db, phoneHash);
          return db.query(
            `UPDATE identity_otp_challenges SET delivery_channel='whatsapp'
             WHERE id=$1 AND state='reserved' AND delivery_channel='telegram'
               AND requested_channel='auto' AND code_hash IS NOT NULL
               AND expires_at>clock_timestamp()
               AND NOT EXISTS (
                 SELECT 1 FROM identity_otp_challenges newer
                 WHERE newer.phone_lookup=$2 AND newer.created_at>identity_otp_challenges.created_at
               )`,
            [id, phoneHash],
          );
        });
        if (switched.rowCount !== 1) throw fail('SERVICE_UNAVAILABLE');
        actualChannel = 'whatsapp';
        result = await this.delivery.sendCode({ phoneE164: phone, code }, actualChannel);
      }
      if (result.kind === 'submitted') submitted = result;
      undeliverable =
        result.kind === 'rejected' &&
        ['recipient_unavailable', 'invalid_input'].includes(result.reason) &&
        actualChannel === (channel === 'auto' ? 'telegram' : channel);
      if (
        result.kind === 'rejected' &&
        (result.reason === 'channel_unavailable' || result.reason === 'provider_rejected')
      )
        this.deliveryAttention(actualChannel, result.reason);
      state =
        result.kind === 'submitted'
          ? 'submitted'
          : result.kind === 'unknown'
            ? 'unknown'
            : 'rejected';
    } catch (error) {
      if (error instanceof CustomerIdentityError) throw error;
      state = 'unknown';
    }
    const refund = state === 'rejected' && undeliverable ? reservation.refund : null;
    const finalization = await transaction(this.pool, async (db) => {
      // Same lock order as the reservation (budget lock, then challenge rows): a refund can
      // never deadlock with a new request for this phone that supersedes the challenge.
      if (refund) await db.query('SELECT pg_advisory_xact_lock(90827001)');
      const updated = await db.query(
        "UPDATE identity_otp_challenges SET state=$2,delivery_provider=$3,delivery_reference=$4,code_hash=CASE WHEN $2='rejected' THEN NULL ELSE code_hash END,phone_cipher=CASE WHEN $2='rejected' THEN NULL ELSE phone_cipher END WHERE id=$1 AND state='reserved' AND delivery_channel=$5",
        [id, state, submitted?.provider ?? null, submitted?.messageId ?? null, actualChannel],
      );
      if (updated.rowCount === 1 && refund) {
        // Nothing was delivered or charged: the reservation returns to the day's budget.
        // reservations>0 is a table invariant: the day's only reservation removes the row.
        const removed = await db.query(
          "DELETE FROM identity_sms_daily_budget WHERE budget_day=($1::timestamptz AT TIME ZONE 'UTC')::date AND reservations=1",
          [refund.now],
        );
        if (removed.rowCount === 0)
          await db.query(
            `UPDATE identity_sms_daily_budget SET reservations=reservations-1,
               new_phone_reservations=GREATEST(new_phone_reservations-$2,0)
             WHERE budget_day=($1::timestamptz AT TIME ZONE 'UTC')::date AND reservations>1`,
            [refund.now, refund.newPhone ? 1 : 0],
          );
      }
      return updated;
    });
    if (finalization.rowCount !== 1) throw fail('SERVICE_UNAVAILABLE');
    if (state === 'rejected') throw fail('SERVICE_UNAVAILABLE');
    return {
      ...response,
      ...(body.channel ? { channel: actualChannel } : {}),
      delivery_status: state,
    };
  }
  async verifyOtp(input: unknown): Promise<CustomerSession> {
    const config = this.enabled(),
      body = parseInput(OtpVerifySchema, input);
    const deviceHash = hmac(config.lookupKey, 'device', body.device_id);
    const inputHash = hmac(config.otpKey, 'verify-receipt', JSON.stringify(body));
    return unwrap(
      await transaction(this.pool, async (db) => {
        const locator = (
          await db.query<{ phone_lookup: string }>(
            'SELECT phone_lookup FROM identity_otp_challenges WHERE id=$1',
            [body.challenge_id],
          )
        ).rows[0];
        if (!locator) return fail('UNAUTHORIZED');
        await this.phoneLock(db, locator.phone_lookup);
        const challenge = (
          await db.query<ChallengeRow>(
            'SELECT * FROM identity_otp_challenges WHERE id=$1 FOR UPDATE',
            [body.challenge_id],
          )
        ).rows[0]!;
        const now = await this.now(db);
        if (!equalHash(deviceHash, challenge.device_hash)) return fail('UNAUTHORIZED');
        if (challenge.state === 'consumed') {
          if (
            challenge.verify_request_id !== body.request_id ||
            challenge.receipt_failed_attempts >= 5 ||
            !challenge.verify_input_hash ||
            !challenge.response_cipher ||
            !challenge.receipt_expires_at ||
            challenge.receipt_expires_at <= now
          )
            return fail('CONFLICT');
          if (!equalHash(challenge.verify_input_hash, inputHash)) {
            // Only the bound device + original request key may spend this budget.
            // Return the error after commit so restart/concurrent guesses cannot reset it.
            await db.query(
              'UPDATE identity_otp_challenges SET receipt_failed_attempts=receipt_failed_attempts+1 WHERE id=$1',
              [challenge.id],
            );
            return fail('CONFLICT');
          }
          const current = (
            await db.query<SessionRow>('SELECT * FROM identity_sessions WHERE id=$1 FOR UPDATE', [
              challenge.session_id,
            ])
          ).rows[0];
          if (!current || current.revoked_at) return fail('UNAUTHORIZED');
          if (current.refresh_hash !== challenge.initial_refresh_hash) return fail('CONFLICT');
          return CustomerSessionSchema.parse(
            decrypt(config.receiptKey, `verify:${challenge.id}`, challenge.response_cipher),
          );
        }
        // Recovery replays the original acceptance; it never manufactures consent to a new policy.
        // Only a new verification must accept today's configured documents.
        if (
          body.consents.terms_version !== config.consentVersion ||
          body.consents.privacy_version !== config.consentVersion
        )
          return fail('INVALID_REQUEST');
        if (
          !['reserved', 'submitted', 'unknown'].includes(challenge.state) ||
          challenge.expires_at <= now ||
          challenge.attempts >= attemptsFor(challenge.code_length) ||
          !challenge.code_hash
        )
          return fail('UNAUTHORIZED');
        // Too many wrong codes for this phone across challenges: no further guess is evaluated.
        if (await this.phoneLocked(db, challenge.phone_lookup, deviceHash, now))
          return fail('RATE_LIMITED');
        const review = challenge.delivery_provider === REVIEW_PROVIDER;
        if (review && !this.options.reviewAccount?.enabled) return fail('UNAUTHORIZED');
        const correct = equalHash(
          challenge.code_hash,
          hmac(
            config.otpKey,
            `otp:${challenge.id}:${deviceHash}`,
            review ? reviewCodeDigest(body.code) : body.code,
          ),
        );
        // Return the error outside the transaction, preserving failed attempts across restart/races.
        await db.query('UPDATE identity_otp_challenges SET attempts=attempts+1 WHERE id=$1', [
          challenge.id,
        ]);
        if (!correct) {
          await db.query(
            `INSERT INTO identity_otp_failures(phone_lookup,failure_hour,failures)
             VALUES($1,date_trunc('hour',$2::timestamptz),1)
             ON CONFLICT(phone_lookup,failure_hour) DO UPDATE SET failures=identity_otp_failures.failures+1`,
            [challenge.phone_lookup, now],
          );
          return fail('UNAUTHORIZED');
        }
        if (!challenge.phone_cipher) return fail('SERVICE_UNAVAILABLE');
        const phone = decrypt<string>(
          config.piiKey,
          `challenge:${challenge.id}`,
          challenge.phone_cipher,
        );
        let customer = (
          await db.query<CustomerRow>(
            'SELECT * FROM identity_customers WHERE phone_lookup=$1 FOR UPDATE',
            [challenge.phone_lookup],
          )
        ).rows[0];
        if (!customer) {
          const id = randomUUID();
          customer = (
            await db.query<CustomerRow>(
              'INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at) VALUES($1,$2,$3,$4,$5) RETURNING *',
              [
                id,
                challenge.phone_lookup,
                encrypt(config.piiKey, `phone:${id}`, phone),
                encrypt(config.piiKey, `profile:${id}`, {
                  nickname: '',
                  birth_date: null,
                  gender: null,
                }),
                now,
              ],
            )
          ).rows[0]!;
        }
        // A new OTP for the same device replaces only that device's previous active session.
        const old = (
          await db.query<{ id: string }>(
            'SELECT id FROM identity_sessions WHERE customer_id=$1 AND device_hash=$2 AND revoked_at IS NULL FOR UPDATE',
            [customer.id, deviceHash],
          )
        ).rows;
        for (const session of old) await this.revoke(db, session.id, now);
        const sessionId = randomUUID(),
          access = randomBytes(32).toString('hex'),
          refresh = randomBytes(32).toString('hex'),
          expires = new Date(now.getTime() + ACCESS_MS);
        await db.query(
          'INSERT INTO identity_sessions(id,customer_id,device_hash,access_hash,access_expires_at,refresh_hash,created_at,refreshed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
          [sessionId, customer.id, deviceHash, digest(access), expires, digest(refresh), now],
        );
        for (const [kind, accepted] of [
          ['terms', true],
          ['privacy', true],
          ['marketing', body.consents.marketing_opt_in],
        ] as const) {
          await db.query(
            'INSERT INTO identity_consents(id,customer_id,kind,version,accepted,recorded_at) VALUES($1,$2,$3,$4,$5,$6)',
            [randomUUID(), customer.id, kind, config.consentVersion, accepted, now],
          );
        }
        const response = {
          access_token: access,
          refresh_token: refresh,
          access_expires_at: iso(expires),
          session_id: sessionId,
          customer: this.customer(customer, config),
        };
        await db.query(
          `UPDATE identity_otp_challenges SET state='consumed', consumed_at=$2,phone_cipher=NULL,code_hash=NULL,
        verify_request_id=$3,verify_input_hash=$4,session_id=$5,initial_refresh_hash=$6,response_cipher=$7,receipt_expires_at=$8 WHERE id=$1`,
          [
            challenge.id,
            now,
            body.request_id,
            inputHash,
            sessionId,
            digest(refresh),
            encrypt(config.receiptKey, `verify:${challenge.id}`, response),
            new Date(now.getTime() + VERIFY_RECEIPT_MS),
          ],
        );
        return response;
      }),
    );
  }
  async refresh(input: unknown): Promise<CustomerSession> {
    const config = this.enabled(),
      body = parseInput(RefreshRequestSchema, input),
      previousHash = digest(body.refresh_token),
      deviceHash = hmac(config.lookupKey, 'device', body.device_id);
    return unwrap(
      await transaction(this.pool, async (db) => {
        const locator = (
          await db.query<{ id: string; phone_lookup: string }>(
            `SELECT s.id,c.phone_lookup FROM identity_sessions s JOIN identity_customers c ON c.id=s.customer_id
         WHERE s.refresh_hash=$1 OR s.id=(SELECT session_id FROM identity_refresh_receipts WHERE previous_hash=$1)
           OR s.retired_refresh_hashes @> ARRAY[$1]::text[]`,
            [previousHash],
          )
        ).rows[0];
        if (!locator?.phone_lookup) return fail('UNAUTHORIZED');
        await this.phoneLock(db, locator.phone_lookup);
        const session = (
          await db.query<SessionRow>('SELECT * FROM identity_sessions WHERE id=$1 FOR UPDATE', [
            locator.id,
          ])
        ).rows[0]!;
        if (session.revoked_at || !equalHash(deviceHash, session.device_hash))
          return fail('UNAUTHORIZED');
        const now = await this.now(db);
        if (this.sessionExpired(session, now)) {
          // Absolute lifetime or idle timeout: the app signs in again with a new code.
          await this.revoke(db, session.id, now);
          return fail('UNAUTHORIZED');
        }
        const receipt = (
          await db.query<{
            previous_hash: string;
            request_id: string;
            successor_hash: string;
            response_cipher: string;
            created_at: Date;
          }>('SELECT * FROM identity_refresh_receipts WHERE session_id=$1', [session.id])
        ).rows[0];
        if (previousHash !== session.refresh_hash) {
          const latest =
            receipt?.previous_hash === previousHash &&
            receipt.successor_hash === session.refresh_hash;
          if (latest && receipt.request_id === body.request_id)
            return CustomerSessionSchema.parse(
              decrypt(config.receiptKey, `refresh:${session.id}`, receipt.response_cipher),
            );
          // A sibling request racing the rotation that just happened on this device.
          if (latest && now.getTime() - receipt.created_at.getTime() < REUSE_GRACE_MS)
            return fail('CONFLICT');
          // A rotated-away token used again: stolen or cloned. End the whole session.
          await this.revoke(db, session.id, now);
          return fail('UNAUTHORIZED');
        }
        // Request IDs identify a single rotation, even when the caller already has its successor.
        if (receipt?.request_id === body.request_id) return fail('CONFLICT');
        const customer = (
          await db.query<CustomerRow>('SELECT * FROM identity_customers WHERE id=$1', [
            session.customer_id,
          ])
        ).rows[0]!;
        const access = randomBytes(32).toString('hex'),
          refresh = randomBytes(32).toString('hex'),
          expires = new Date(now.getTime() + ACCESS_MS);
        const response = {
          access_token: access,
          refresh_token: refresh,
          access_expires_at: iso(expires),
          session_id: session.id,
          customer: this.customer(customer, config),
        };
        await db.query(
          `UPDATE identity_sessions SET access_hash=$2,access_expires_at=$3,refresh_hash=$4,generation=generation+1,refreshed_at=$5,
             retired_refresh_hashes=(ARRAY[$6]::text[] || retired_refresh_hashes)[1:$7]
           WHERE id=$1`,
          [
            session.id,
            digest(access),
            expires,
            digest(refresh),
            now,
            previousHash,
            RETIRED_REFRESH_KEPT,
          ],
        );
        await db.query(
          `INSERT INTO identity_refresh_receipts(session_id,previous_hash,request_id,successor_hash,response_cipher,created_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(session_id) DO UPDATE SET previous_hash=EXCLUDED.previous_hash, request_id=EXCLUDED.request_id,successor_hash=EXCLUDED.successor_hash,response_cipher=EXCLUDED.response_cipher,created_at=EXCLUDED.created_at`,
          [
            session.id,
            previousHash,
            body.request_id,
            digest(refresh),
            encrypt(config.receiptKey, `refresh:${session.id}`, response),
            now,
          ],
        );
        await db.query(
          'UPDATE identity_otp_challenges SET response_cipher=NULL,verify_input_hash=NULL,initial_refresh_hash=NULL,receipt_expires_at=NULL WHERE session_id=$1',
          [session.id],
        );
        return response;
      }),
    );
  }
  private async authorized(
    db: DatabaseClient,
    token: string,
    lock = false,
  ): Promise<{ session: SessionRow; customer: CustomerRow }> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw fail('UNAUTHORIZED');
    const locator = (
      await db.query<{ phone_lookup: string }>(
        'SELECT c.phone_lookup FROM identity_sessions s JOIN identity_customers c ON c.id=s.customer_id WHERE s.access_hash=$1 AND s.revoked_at IS NULL AND c.deleted_at IS NULL',
        [digest(token)],
      )
    ).rows[0];
    if (!locator) throw fail('UNAUTHORIZED');
    if (lock) await this.phoneLock(db, locator.phone_lookup);
    const session = (
      await db.query<SessionRow>(
        `SELECT * FROM identity_sessions WHERE access_hash=$1 AND revoked_at IS NULL AND access_expires_at>clock_timestamp()${lock ? ' FOR UPDATE' : ''}`,
        [digest(token)],
      )
    ).rows[0];
    if (!session) throw fail('UNAUTHORIZED');
    const customer = (
      await db.query<CustomerRow>(
        `SELECT * FROM identity_customers WHERE id=$1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
        [session.customer_id],
      )
    ).rows[0];
    if (!customer) throw fail('UNAUTHORIZED');
    return { session, customer };
  }
  async me(accessToken: string): Promise<{ customer: Customer }> {
    const config = this.enabled();
    return transaction(this.pool, async (db) => ({
      customer: this.customer((await this.authorized(db, accessToken)).customer, config),
    }));
  }
  async patchMe(accessToken: string, input: unknown): Promise<{ customer: Customer }> {
    const config = this.enabled(),
      body = parseInput(CustomerPatchSchema, input);
    return transaction(this.pool, async (db) => {
      const { customer } = await this.authorized(db, accessToken, true),
        now = await this.now(db);
      if (
        typeof body.birth_date === 'string' &&
        !isValidCustomerBirthDate(body.birth_date, now.getTime())
      )
        throw fail('INVALID_REQUEST');
      const profile = decrypt<CustomerProfile>(
        config.piiKey,
        `profile:${customer.id}`,
        customer.profile_cipher!,
      );
      for (const field of ['nickname', 'birth_date', 'gender'] as const)
        if (body[field] !== undefined) Object.assign(profile, { [field]: body[field] });
      const hasProfile = ['nickname', 'birth_date', 'gender'].some((key) => key in body);
      const updated = (
        await db.query<CustomerRow>(
          'UPDATE identity_customers SET profile_cipher=$2,profile_completed_at=CASE WHEN $3 THEN $4 ELSE profile_completed_at END WHERE id=$1 RETURNING *',
          [
            customer.id,
            encrypt(config.piiKey, `profile:${customer.id}`, profile),
            hasProfile && profile.gender !== null,
            now,
          ],
        )
      ).rows[0]!;
      if (body.marketing_opt_in !== undefined)
        await db.query(
          "INSERT INTO identity_consents(id,customer_id,kind,version,accepted,recorded_at) VALUES($1,$2,'marketing',$3,$4,$5)",
          [randomUUID(), customer.id, config.consentVersion, body.marketing_opt_in, now],
        );
      return { customer: this.customer(updated, config) };
    });
  }
  private async revoke(db: DatabaseClient, id: string, now: Date) {
    await db.query('DELETE FROM identity_refresh_receipts WHERE session_id=$1', [id]);
    await db.query(
      'UPDATE identity_otp_challenges SET response_cipher=NULL,verify_input_hash=NULL,initial_refresh_hash=NULL,receipt_expires_at=NULL WHERE session_id=$1',
      [id],
    );
    await db.query(
      "UPDATE identity_sessions SET revoked_at=COALESCE(revoked_at,$2),access_hash=NULL,refresh_hash=NULL,retired_refresh_hashes='{}' WHERE id=$1",
      [id, now],
    );
  }
  async logout(accessToken: string): Promise<{ ok: true }> {
    this.enabled();
    return transaction(this.pool, async (db) => {
      const { session } = await this.authorized(db, accessToken, true);
      await this.revoke(db, session.id, await this.now(db));
      return { ok: true };
    });
  }
  async deleteMe(accessToken: string): Promise<{ ok: true }> {
    this.enabled();
    return transaction(this.pool, async (db) => {
      const { customer } = await this.authorized(db, accessToken, true),
        now = await this.now(db);
      const sessions = (
        await db.query<{ id: string }>(
          'SELECT id FROM identity_sessions WHERE customer_id=$1 FOR UPDATE',
          [customer.id],
        )
      ).rows;
      for (const session of sessions) await this.revoke(db, session.id, now);
      await db.query(
        "UPDATE identity_otp_challenges SET phone_cipher=NULL,code_hash=NULL,response_cipher=NULL,verify_input_hash=NULL,initial_refresh_hash=NULL,receipt_expires_at=NULL,state=CASE WHEN state='consumed' THEN state ELSE 'superseded' END WHERE phone_lookup=$1",
        [customer.phone_lookup],
      );
      await db.query(
        'UPDATE identity_otp_challenges SET session_id=NULL,verify_request_id=NULL WHERE session_id IN (SELECT id FROM identity_sessions WHERE customer_id=$1)',
        [customer.id],
      );
      await db.query('DELETE FROM identity_sessions WHERE customer_id=$1', [customer.id]);
      await db.query('DELETE FROM identity_consents WHERE customer_id=$1', [customer.id]);
      await db.query(
        'UPDATE identity_customers SET phone_lookup=NULL,phone_cipher=NULL,profile_cipher=NULL,profile_completed_at=NULL,deleted_at=$2 WHERE id=$1',
        [customer.id, now],
      );
      await db.query('INSERT INTO identity_deletions(customer_id,deleted_at) VALUES($1,$2)', [
        customer.id,
        now,
      ]);
      return { ok: true };
    });
  }
  /** Trusted administrative command only; deliberately not exposed as a public HTTP route. */
  async revokeSession(sessionId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
      throw fail('INVALID_REQUEST');
    await transaction(this.pool, async (db) => {
      const row = (
        await db.query<{ phone_lookup: string | null }>(
          'SELECT c.phone_lookup FROM identity_sessions s JOIN identity_customers c ON c.id=s.customer_id WHERE s.id=$1',
          [sessionId],
        )
      ).rows[0];
      if (!row?.phone_lookup) return;
      await this.phoneLock(db, row.phone_lookup);
      await this.revoke(db, sessionId, await this.now(db));
    });
  }
  /** Owner-operated retention maintenance. No SMS dispatch or expiry of active device sessions. */
  async cleanup(): Promise<void> {
    await transaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(90827001)');
      await db.query(
        'UPDATE identity_otp_challenges SET phone_cipher=NULL,code_hash=NULL WHERE expires_at<=clock_timestamp() AND (phone_cipher IS NOT NULL OR code_hash IS NOT NULL)',
      );
      await db.query(
        'UPDATE identity_otp_challenges SET response_cipher=NULL,verify_input_hash=NULL,initial_refresh_hash=NULL,receipt_expires_at=NULL WHERE receipt_expires_at<=clock_timestamp()',
      );
      // The reservation lock prevents a purged key racing a new dispatch.
      await db.query(
        "INSERT INTO identity_otp_request_tombstones(request_id,purged_at) SELECT request_id,clock_timestamp() FROM identity_otp_challenges WHERE created_at<clock_timestamp()-interval '24 hours' AND response_cipher IS NULL ON CONFLICT DO NOTHING",
      );
      await db.query(
        "DELETE FROM identity_otp_challenges WHERE created_at<clock_timestamp()-interval '24 hours' AND response_cipher IS NULL",
      );
      await db.query(
        "DELETE FROM identity_sms_daily_budget WHERE budget_day<(clock_timestamp() AT TIME ZONE 'UTC')::date-7",
      );
      await db.query(
        "DELETE FROM identity_otp_failures WHERE failure_hour<clock_timestamp()-interval '31 days'",
      );
    });
  }
}

/**
 * Server-side payment use only (Kaspi invoice to the verified phone). Returns the
 * active customer's phone in E.164 or null; never logs or returns it elsewhere.
 */
export async function readCustomerPaymentPhone(
  pool: DatabasePool,
  options: CustomerIdentityOptions,
  customerId: string,
): Promise<string | null> {
  if (!options.enabled || !/^[0-9a-f-]{36}$/.test(customerId)) return null;
  const row = (
    await pool.query<{ phone_cipher: string | null; deleted_at: Date | null }>(
      'SELECT phone_cipher,deleted_at FROM identity_customers WHERE id=$1',
      [customerId],
    )
  ).rows[0];
  if (!row || row.deleted_at || !row.phone_cipher) return null;
  const phone = decrypt<string>(options.piiKey, `phone:${customerId}`, row.phone_cipher);
  // The App Review account never receives a Kaspi invoice, even if an attempt slipped through.
  return options.reviewAccount?.phone === phone ? null : phone;
}
