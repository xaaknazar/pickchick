import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { transaction, type DatabasePool } from '@pickchick/database';
import { CommerceError, UUIDSchema, parse } from './model.js';
import { z } from 'zod';
const StartSchema = z.strictObject({
  sessionId: UUIDSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const validToken = (token: string) => typeof token === 'string' && /^[0-9a-f]{64}$/.test(token);
const uuid = (value: string) => {
  if (!UUIDSchema.safeParse(value).success) throw new CommerceError('INVALID');
};
const matches = (token: string, hash: string) =>
  validToken(token) &&
  timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(hash, 'hex'));
const forbidden = (): never => {
  throw new CommerceError('FORBIDDEN');
};
const pendingRecovery = `EXISTS(SELECT 1 FROM commerce_orders recovery_order
 WHERE recovery_order.principal_id=s.id AND recovery_order.organization_id=s.organization_id
  AND recovery_order.branch_id=s.branch_id AND recovery_order.customer_id IS NULL
  AND recovery_order.snapshot->>'channel'='kiosk'
  AND (EXISTS(SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=recovery_order.id AND a.state IN ('pending','unknown'))
   OR EXISTS(SELECT 1 FROM commerce_kaspi_invoices k WHERE k.order_id=recovery_order.id AND k.state IN ('issuing','issued','unknown'))))`;
type Session = {
  id: string;
  device_id: string;
  organization_id: string;
  branch_id: string;
  token_hash: string;
  expires_at: Date;
  ended_at: Date | null;
  phone_ciphertext: Buffer | null;
  phone_nonce: Buffer | null;
  phone_tag: Buffer | null;
  phone_expires_at: Date | null;
  valid: boolean;
};

/** Guest credentials never authenticate a customer account. Phone data is server-only. */
export class KioskSessions {
  private readonly key: Buffer;
  private readonly ttl: number;
  constructor(
    private readonly pool: DatabasePool,
    options: { piiKey: Buffer; sessionTtlSeconds?: number },
  ) {
    if (!Buffer.isBuffer(options.piiKey) || options.piiKey.length !== 32)
      throw new CommerceError('INVALID');
    this.key = Buffer.from(options.piiKey);
    this.ttl = options.sessionTtlSeconds ?? 3600;
    if (!Number.isInteger(this.ttl) || this.ttl < 1 || this.ttl > 3600)
      throw new CommerceError('INVALID');
  }
  async start(deviceId: string, deviceToken: string, value: unknown) {
    uuid(deviceId);
    const input = parse(StartSchema, value);
    if (!validToken(deviceToken) || !validToken(input.token)) return forbidden();
    return transaction(this.pool, async (client) => {
      const device = (
        await client.query('SELECT * FROM kiosk_devices WHERE id=$1 AND active FOR UPDATE', [
          deviceId,
        ])
      ).rows[0];
      if (!device || !matches(deviceToken, device.token_hash)) return forbidden();
      await client.query(
        `INSERT INTO kiosk_sessions(id,device_id,organization_id,branch_id,token_hash,expires_at)
    SELECT $1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 second'
    WHERE (SELECT count(*) FROM kiosk_sessions WHERE device_id=$2 AND ended_at IS NULL AND expires_at>clock_timestamp())<10
    ON CONFLICT DO NOTHING`,
        [
          input.sessionId,
          deviceId,
          device.organization_id,
          device.branch_id,
          tokenHash(input.token),
          this.ttl,
        ],
      );
      const session = (
        await client.query<Session>(
          `SELECT *,ended_at IS NULL AND expires_at>clock_timestamp() AS valid
    FROM kiosk_sessions WHERE id=$1 FOR UPDATE`,
          [input.sessionId],
        )
      ).rows[0];
      if (
        !session ||
        session.device_id !== deviceId ||
        !matches(input.token, session.token_hash) ||
        !session.valid
      )
        return forbidden();
      return {
        sessionId: session.id,
        expiresAt: session.expires_at.toISOString(),
        branchId: session.branch_id,
        organizationId: session.organization_id,
      };
    });
  }
  async authenticate(
    deviceId: string,
    deviceToken: string,
    sessionToken: string,
    options: { allowEnded?: boolean } = {},
  ) {
    uuid(deviceId);
    if (!validToken(deviceToken) || !validToken(sessionToken)) return forbidden();
    const session = (
      await this.pool.query<Session>(
        `SELECT s.* FROM kiosk_sessions s JOIN kiosk_devices d ON d.id=s.device_id
   WHERE d.id=$1 AND d.active AND d.token_hash=$2 AND s.token_hash=$3
    AND ($4::boolean OR (s.ended_at IS NULL AND s.expires_at>clock_timestamp()))`,
        [deviceId, tokenHash(deviceToken), tokenHash(sessionToken), options.allowEnded === true],
      )
    ).rows[0];
    if (!session) return forbidden();
    return {
      sessionId: session.id,
      organizationId: session.organization_id,
      branchId: session.branch_id,
      deviceId: session.device_id,
    };
  }
  private decrypt(session: Session): string {
    if (!session.phone_ciphertext || !session.phone_nonce || !session.phone_tag) return forbidden();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, session.phone_nonce);
      decipher.setAAD(
        Buffer.from(`kiosk-phone:${session.id}:${session.organization_id}:${session.branch_id}`),
      );
      decipher.setAuthTag(session.phone_tag);
      return Buffer.concat([decipher.update(session.phone_ciphertext), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw new CommerceError('NOT_READY');
    }
  }
  async setPhone(sessionId: string, phone: string): Promise<void> {
    uuid(sessionId);
    if (typeof phone !== 'string' || !/^\+77[0-9]{9}$/.test(phone))
      throw new CommerceError('INVALID');
    await transaction(this.pool, async (client) => {
      const session = (
        await client.query<Session>(
          `SELECT s.*,s.ended_at IS NULL AND s.expires_at>clock_timestamp() AND d.active AS valid
    FROM kiosk_sessions s JOIN kiosk_devices d ON d.id=s.device_id WHERE s.id=$1 FOR UPDATE OF s FOR SHARE OF d`,
          [sessionId],
        )
      ).rows[0];
      if (!session || !session.valid) return forbidden();
      if (session.phone_expires_at) {
        if (!session.phone_ciphertext) throw new CommerceError('CONFLICT');
        if (this.decrypt(session) !== phone) throw new CommerceError('CONFLICT');
        return;
      }
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(
        Buffer.from(`kiosk-phone:${session.id}:${session.organization_id}:${session.branch_id}`),
      );
      const encrypted = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
      await client.query(
        `UPDATE kiosk_sessions SET phone_ciphertext=$2,phone_nonce=$3,phone_tag=$4,
    phone_expires_at=clock_timestamp()+interval '1 day' WHERE id=$1`,
        [sessionId, encrypted, nonce, cipher.getAuthTag()],
      );
    });
  }
  async readOrderPhone(orderId: string): Promise<string | null> {
    uuid(orderId);
    const session = (
      await this.pool.query<Session>(
        `SELECT s.* FROM commerce_orders o JOIN kiosk_sessions s
   ON s.id=o.principal_id AND s.organization_id=o.organization_id AND s.branch_id=o.branch_id
   WHERE o.id=$1 AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk' AND (s.phone_expires_at>clock_timestamp() OR ${pendingRecovery})
    AND s.phone_ciphertext IS NOT NULL`,
        [orderId],
      )
    ).rows[0];
    return session ? this.decrypt(session) : null;
  }
  async end(sessionId: string): Promise<void> {
    uuid(sessionId);
    await this.pool.query(
      'UPDATE kiosk_sessions SET ended_at=COALESCE(ended_at,clock_timestamp()) WHERE id=$1',
      [sessionId],
    );
  }
  /** Retention cleanup is independent of guest expiry and never deletes orders. */
  async purgeExpiredPhones(): Promise<number> {
    const result = await this.pool
      .query(`UPDATE kiosk_sessions s SET phone_ciphertext=NULL,phone_nonce=NULL,phone_tag=NULL
   WHERE phone_expires_at<=clock_timestamp() AND phone_ciphertext IS NOT NULL AND NOT ${pendingRecovery}`);
    return result.rowCount ?? 0;
  }
}
