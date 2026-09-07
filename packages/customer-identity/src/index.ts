import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { transaction } from '@pickchick/database';
import type { DatabasePool, DatabaseClient } from '@pickchick/database';
import type { PhoneCodeDelivery } from '@pickchick/phone-verification';
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
import { digest, hmac, equalHash, encrypt, decrypt } from './crypto.js';
export * from './contracts.js';
export * from './config.js';
export const CUSTOMER_IDENTITY = Symbol('CUSTOMER_IDENTITY');
const ACCESS_MS = 15 * 60_000,
  CHALLENGE_MS = 3 * 60_000,
  VERIFY_RECEIPT_MS = 24 * 60 * 60_000;
type EnabledOptions = Extract<CustomerIdentityOptions, { enabled: true }>;
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
  revoked_at: Date | null;
}
interface ChallengeRow {
  id: string;
  phone_lookup: string;
  phone_cipher: string | null;
  device_hash: string;
  code_hash: string | null;
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
  ) {}
  config() {
    if (!this.options.enabled || this.delivery.provider === 'disabled')
      return { enabled: false, consent_version: null, terms_url: null, privacy_url: null };
    return {
      enabled: true,
      consent_version: this.options.consentVersion,
      terms_url: this.options.termsUrl,
      privacy_url: this.options.privacyUrl,
    };
  }
  private enabled(): EnabledOptions {
    if (!this.options.enabled || this.delivery.provider === 'disabled')
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
      phone = normalizeKazakhstanPhone(body.phone);
    // Caller must supply the trusted socket/proxy-resolved address, never an untrusted forwarding header.
    if (!isIP(clientIp)) throw fail('INVALID_REQUEST');
    const ip =
      clientIp.startsWith('::ffff:') && isIP(clientIp.slice(7)) === 4
        ? clientIp.slice(7)
        : clientIp.toLowerCase();
    const phoneHash = hmac(config.lookupKey, 'phone', phone),
      deviceHash = hmac(config.lookupKey, 'device', body.device_id),
      ipHash = hmac(config.lookupKey, 'ip', ip);
    const id = randomUUID(),
      code = String(randomInt(0, 1_000_000)).padStart(6, '0');
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
        if (replay.phone_lookup !== phoneHash || replay.device_hash !== deviceHash)
          throw fail('CONFLICT');
        if (replay.state === 'rejected') throw fail('SERVICE_UNAVAILABLE');
        return {
          replay: true,
          challenge_id: replay.id,
          expires_at: iso(replay.expires_at),
          resend_at: iso(new Date(replay.created_at.getTime() + 60_000)),
          delivery_status:
            replay.state === 'submitted' || replay.state === 'consumed'
              ? ('submitted' as const)
              : ('unknown' as const),
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
          max(created_at) FILTER (WHERE phone_lookup=$1) AS last_phone,
          max(created_at) FILTER (WHERE device_hash=$2) AS last_device
         FROM identity_otp_challenges WHERE created_at>$5 AND (phone_lookup=$1 OR device_hash=$2 OR ip_hash=$3)`,
          [phoneHash, deviceHash, ipHash, hour, day],
        )
      ).rows[0]!;
      if (
        Number(counts.phone_hour) >= 5 ||
        Number(counts.phone_day) >= 10 ||
        Number(counts.device_hour) >= 10 ||
        Number(counts.device_day) >= 30 ||
        Number(counts.ip_hour) >= 30 ||
        Number(counts.ip_day) >= 100 ||
        [counts.last_phone, counts.last_device].some(
          (last) => last && now.getTime() - last.getTime() < 60_000,
        )
      )
        throw fail('RATE_LIMITED');
      const budget = await db.query(
        `INSERT INTO identity_sms_daily_budget(budget_day,reservations) VALUES (($1::timestamptz AT TIME ZONE 'UTC')::date,1)
         ON CONFLICT(budget_day) DO UPDATE SET reservations=identity_sms_daily_budget.reservations+1
         WHERE identity_sms_daily_budget.reservations<$2 RETURNING reservations`,
        [now, config.dailySmsBudget],
      );
      if (budget.rowCount !== 1) throw fail('RATE_LIMITED');
      await db.query(
        "UPDATE identity_otp_challenges SET state='superseded', code_hash=NULL,phone_cipher=NULL WHERE phone_lookup=$1 AND state IN ('reserved','submitted','unknown')",
        [phoneHash],
      );
      const expires = new Date(now.getTime() + CHALLENGE_MS);
      await db.query(
        `INSERT INTO identity_otp_challenges(id,phone_lookup,phone_cipher,device_hash,ip_hash,code_hash,state,created_at,expires_at,request_id)
         VALUES($1,$2,$3,$4,$5,$6,'reserved',$7,$8,$9)`,
        [
          id,
          phoneHash,
          encrypt(config.piiKey, `challenge:${id}`, phone),
          deviceHash,
          ipHash,
          hmac(config.otpKey, `otp:${id}:${deviceHash}`, code),
          now,
          expires,
          body.request_id,
        ],
      );
      return {
        replay: false,
        challenge_id: id,
        expires_at: iso(expires),
        resend_at: iso(new Date(now.getTime() + 60_000)),
        delivery_status: 'unknown' as const,
      };
    });
    const response = {
      challenge_id: reservation.challenge_id,
      expires_at: reservation.expires_at,
      resend_at: reservation.resend_at,
    };
    if (reservation.replay) return { ...response, delivery_status: reservation.delivery_status };
    // A crash/timeout here leaves a durable unknown reservation. It must never be dispatched again.
    let state: 'submitted' | 'unknown' | 'rejected';
    try {
      const result = await this.delivery.sendCode({ phoneE164: phone, code });
      state =
        result.kind === 'submitted'
          ? 'submitted'
          : result.kind === 'unknown'
            ? 'unknown'
            : 'rejected';
    } catch {
      state = 'unknown';
    }
    await this.pool.query(
      "UPDATE identity_otp_challenges SET state=$2,code_hash=CASE WHEN $2='rejected' THEN NULL ELSE code_hash END,phone_cipher=CASE WHEN $2='rejected' THEN NULL ELSE phone_cipher END WHERE id=$1 AND state='reserved'",
      [id, state],
    );
    if (state === 'rejected') throw fail('SERVICE_UNAVAILABLE');
    return { ...response, delivery_status: state };
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
          challenge.attempts >= 5 ||
          !challenge.code_hash
        )
          return fail('UNAUTHORIZED');
        const correct = equalHash(
          challenge.code_hash,
          hmac(config.otpKey, `otp:${challenge.id}:${deviceHash}`, body.code),
        );
        // Return the error outside the transaction, preserving failed attempts across restart/races.
        await db.query('UPDATE identity_otp_challenges SET attempts=attempts+1 WHERE id=$1', [
          challenge.id,
        ]);
        if (!correct) return fail('UNAUTHORIZED');
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
         WHERE s.refresh_hash=$1 OR s.id=(SELECT session_id FROM identity_refresh_receipts WHERE previous_hash=$1)`,
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
        const receipt = (
          await db.query<{
            previous_hash: string;
            request_id: string;
            successor_hash: string;
            response_cipher: string;
          }>('SELECT * FROM identity_refresh_receipts WHERE session_id=$1', [session.id])
        ).rows[0];
        if (previousHash !== session.refresh_hash) {
          if (
            !receipt ||
            receipt.previous_hash !== previousHash ||
            receipt.request_id !== body.request_id ||
            receipt.successor_hash !== session.refresh_hash
          )
            return fail('CONFLICT');
          return CustomerSessionSchema.parse(
            decrypt(config.receiptKey, `refresh:${session.id}`, receipt.response_cipher),
          );
        }
        // Request IDs identify a single rotation, even when the caller already has its successor.
        if (receipt?.request_id === body.request_id) return fail('CONFLICT');
        const customer = (
          await db.query<CustomerRow>('SELECT * FROM identity_customers WHERE id=$1', [
            session.customer_id,
          ])
        ).rows[0]!;
        const now = await this.now(db),
          access = randomBytes(32).toString('hex'),
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
          'UPDATE identity_sessions SET access_hash=$2,access_expires_at=$3,refresh_hash=$4,generation=generation+1,refreshed_at=$5 WHERE id=$1',
          [session.id, digest(access), expires, digest(refresh), now],
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
          [customer.id, encrypt(config.piiKey, `profile:${customer.id}`, profile), hasProfile, now],
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
      'UPDATE identity_sessions SET revoked_at=COALESCE(revoked_at,$2),access_hash=NULL,refresh_hash=NULL WHERE id=$1',
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
    });
  }
}
