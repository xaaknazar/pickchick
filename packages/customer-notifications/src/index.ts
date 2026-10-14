import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { NotificationPreferencePatchSchema, PushDeviceSchema } from '@pickchick/contracts';
import type { z } from 'zod';
import type { PushOptions } from './config.js';
import {
  notificationText,
  type NotificationLocale,
  type OrderNotificationKind,
} from './templates.js';
import {
  PushProviders,
  type PushTarget,
  type PushMessage,
  type DeliveryResult,
} from './providers.js';
export * from './config.js';
export * from './templates.js';
export * from './providers.js';
export const CUSTOMER_NOTIFICATIONS = Symbol('CUSTOMER_NOTIFICATIONS');
export class NotificationError extends Error {
  constructor(
    readonly code:
      'UNAUTHORIZED' | 'INVALID_REQUEST' | 'SERVICE_UNAVAILABLE' | 'NOT_FOUND' | 'RATE_LIMITED',
  ) {
    super(code);
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new NotificationError('INVALID_REQUEST');
  return result.data;
}
export interface Preferences {
  locale: NotificationLocale;
  orders: boolean;
  promotions: boolean;
}
interface Identity {
  customer_id: string;
  id: string;
}
export class CustomerNotifications {
  constructor(
    readonly pool: DatabasePool,
    readonly options: PushOptions,
  ) {}
  config() {
    return {
      enabled: this.options.enabled,
      providers: (['apns', 'fcm'] as const).filter((p) => Boolean(this.options[p])),
      consentVersion: 'notifications-v1' as const,
    };
  }
  private async authorized(db: DatabaseClient, token: string): Promise<Identity> {
    if (!this.options.enabled) throw new NotificationError('SERVICE_UNAVAILABLE');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new NotificationError('UNAUTHORIZED');
    const row = (
      await db.query<Identity>(
        `SELECT s.id,s.customer_id FROM identity_sessions s JOIN identity_customers c ON c.id=s.customer_id WHERE s.access_hash=$1 AND s.access_expires_at>clock_timestamp() AND s.revoked_at IS NULL AND c.deleted_at IS NULL FOR SHARE OF s,c`,
        [hash(token)],
      )
    ).rows[0];
    if (!row) throw new NotificationError('UNAUTHORIZED');
    return row;
  }
  async preferences(token: string): Promise<Preferences> {
    return transaction(this.pool, async (db) => {
      const who = await this.authorized(db, token);
      return (
        (
          await db.query<Preferences>(
            'SELECT locale,orders,promotions FROM customer_notification_preferences WHERE customer_id=$1',
            [who.customer_id],
          )
        ).rows[0] ?? { locale: 'ru', orders: false, promotions: false }
      );
    });
  }
  async updatePreferences(token: string, input: unknown): Promise<Preferences> {
    const patch = parse(NotificationPreferencePatchSchema, input);
    return transaction(this.pool, async (db) => {
      const who = await this.authorized(db, token);
      await db.query(
        'INSERT INTO customer_notification_preferences(customer_id) VALUES($1) ON CONFLICT DO NOTHING',
        [who.customer_id],
      );
      const old = (
        await db.query<Preferences>(
          'SELECT locale,orders,promotions FROM customer_notification_preferences WHERE customer_id=$1 FOR UPDATE',
          [who.customer_id],
        )
      ).rows[0]!;
      const next = {
        locale: patch.locale ?? old.locale,
        orders: patch.orders ?? old.orders,
        promotions: patch.promotions ?? old.promotions,
      };
      await db.query(
        `UPDATE customer_notification_preferences SET locale=$2,orders=$3,promotions=$4,orders_enabled_at=CASE WHEN $3 AND NOT orders THEN clock_timestamp() ELSE orders_enabled_at END,promotions_consent_version=CASE WHEN $4 THEN 'notifications-v1' ELSE promotions_consent_version END,updated_at=clock_timestamp() WHERE customer_id=$1`,
        [who.customer_id, next.locale, next.orders, next.promotions],
      );
      if (next.orders !== old.orders || next.promotions !== old.promotions)
        await db.query(
          `INSERT INTO customer_notification_consents(customer_id,orders,promotions,consent_version) VALUES($1,$2,$3,'notifications-v1')`,
          [who.customer_id, next.orders, next.promotions],
        );
      if (!next.orders)
        await db.query(
          `UPDATE customer_push_deliveries SET state='discarded',lease_id=NULL,lease_until=NULL WHERE notification_id IN (SELECT id FROM customer_notifications WHERE customer_id=$1) AND state IN ('pending','sending')`,
          [who.customer_id],
        );
      return next;
    });
  }
  private seal(id: string, token: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.options.encryptionKey!, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString('base64url')).join('.');
  }
  unseal(id: string, value: string) {
    const [iv, tag, body] = value.split('.').map((v) => Buffer.from(v, 'base64url'));
    if (!iv || !tag || !body) throw new NotificationError('SERVICE_UNAVAILABLE');
    const cipher = createDecipheriv('aes-256-gcm', this.options.encryptionKey!, iv);
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8');
  }
  async register(token: string, input: unknown) {
    const body = parse(PushDeviceSchema, input);
    if (!this.options[body.provider]) throw new NotificationError('SERVICE_UNAVAILABLE');
    const nativeToken = body.provider === 'apns' ? body.token.toLowerCase() : body.token;
    const tokenHash = hash(`${body.provider}:${body.environment}:${body.bundleId}:${nativeToken}`);
    return transaction(this.pool, async (db) => {
      const who = await this.authorized(db, token);
      // Serializes registration on this account; the token is additionally globally unique.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,41874))', [who.customer_id]);
      const existing = (
        await db.query<{ id: string }>(
          'SELECT id FROM customer_push_devices WHERE customer_id=$1 AND installation_id=$2',
          [who.customer_id, body.installationId],
        )
      ).rows[0];
      const count = (
        await db.query<{ count: string }>(
          'SELECT count(*) FROM customer_push_devices WHERE customer_id=$1 AND disabled_at IS NULL',
          [who.customer_id],
        )
      ).rows[0]!;
      if (!existing && Number(count.count) >= 10) throw new NotificationError('RATE_LIMITED');
      // A token returned by the OS can move to a new signed-in account, never fan out to both.
      await db.query(
        'DELETE FROM customer_push_devices WHERE token_hash=$1 AND (customer_id<>$2 OR installation_id<>$3)',
        [tokenHash, who.customer_id, body.installationId],
      );
      const id = existing?.id ?? randomUUID();
      await db.query(
        `INSERT INTO customer_push_devices(id,customer_id,session_id,installation_id,provider,environment,bundle_id,token_hash,token_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(customer_id,installation_id) DO UPDATE SET session_id=EXCLUDED.session_id,provider=EXCLUDED.provider,environment=EXCLUDED.environment,bundle_id=EXCLUDED.bundle_id,token_hash=EXCLUDED.token_hash,token_cipher=EXCLUDED.token_cipher,disabled_at=NULL,updated_at=clock_timestamp()`,
        [
          id,
          who.customer_id,
          who.id,
          body.installationId,
          body.provider,
          body.environment,
          body.bundleId,
          tokenHash,
          this.seal(id, nativeToken),
        ],
      );
      return { registered: true };
    });
  }
  async unregister(token: string, installationId: string) {
    if (!/^[a-f0-9-]{36}$/i.test(installationId)) throw new NotificationError('INVALID_REQUEST');
    return transaction(this.pool, async (db) => {
      const who = await this.authorized(db, token);
      await db.query(
        'UPDATE customer_push_devices SET disabled_at=clock_timestamp(),token_cipher=NULL WHERE customer_id=$1 AND installation_id=$2',
        [who.customer_id, installationId],
      );
      return { registered: false };
    });
  }
  async inbox(token: string) {
    return transaction(this.pool, async (db) => {
      const who = await this.authorized(db, token);
      const locale =
        (
          await db.query<Preferences>(
            'SELECT locale FROM customer_notification_preferences WHERE customer_id=$1',
            [who.customer_id],
          )
        ).rows[0]?.locale ?? 'ru';
      const rows = await db.query<{
        id: string;
        order_id: string;
        kind: OrderNotificationKind;
        created_at: Date;
        read_at: Date | null;
      }>(
        'SELECT id,order_id,kind,created_at,read_at FROM customer_notifications WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
        [who.customer_id],
      );
      return {
        items: rows.rows.map((row) => ({
          id: row.id,
          orderId: row.order_id,
          kind: row.kind,
          ...notificationText(row.kind, locale),
          createdAt: row.created_at.toISOString(),
          readAt: row.read_at?.toISOString() ?? null,
        })),
      };
    });
  }
  async read(token: string, id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new NotificationError('INVALID_REQUEST');
    return transaction(this.pool, async (db) => {
      const who = await this.authorized(db, token);
      const result = await db.query(
        'UPDATE customer_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=$1 AND customer_id=$2',
        [id, who.customer_id],
      );
      if (!result.rowCount) throw new NotificationError('NOT_FOUND');
      return { read: true };
    });
  }
  /** Called only by the server observer after reading the authoritative checkout projection. */
  async observe(customerId: string, orderId: string, kind: OrderNotificationKind) {
    return transaction(this.pool, async (db) => {
      const eligible = await db.query(
        `SELECT 1 FROM customer_notification_preferences p JOIN identity_customers c ON c.id=p.customer_id JOIN commerce_orders o ON o.customer_id=p.customer_id AND o.principal_id=p.customer_id WHERE p.customer_id=$1 AND o.id=$2 AND o.snapshot->>'channel'='mobile' AND p.orders AND c.deleted_at IS NULL AND o.created_at>=p.orders_enabled_at FOR SHARE OF p,c`,
        [customerId, orderId],
      );
      if (!eligible.rowCount) return;
      const id = randomUUID();
      const inserted = await db.query(
        `INSERT INTO customer_notifications(id,customer_id,order_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT(customer_id,order_id,kind) DO NOTHING RETURNING id`,
        [id, customerId, orderId, kind],
      );
      if (!inserted.rowCount) return;
      // Only the newest observed state is useful as a banner; the inbox retains every observed state.
      await db.query(
        `UPDATE customer_push_deliveries SET state='discarded',lease_id=NULL,lease_until=NULL WHERE state IN ('pending','sending') AND notification_id IN(SELECT id FROM customer_notifications WHERE order_id=$1 AND id<>$2)`,
        [orderId, id],
      );
      await db.query(
        `INSERT INTO customer_push_deliveries(notification_id,device_id) SELECT $1,d.id FROM customer_push_devices d JOIN identity_sessions s ON s.id=d.session_id WHERE d.customer_id=$2 AND d.disabled_at IS NULL AND d.token_cipher IS NOT NULL AND s.revoked_at IS NULL AND s.refresh_hash IS NOT NULL`,
        [id, customerId],
      );
    });
  }
  async deliver(send?: (target: PushTarget, message: PushMessage) => Promise<DeliveryResult>) {
    if (!this.options.enabled) return 0;
    const providers = new PushProviders(this.options);
    const dispatch =
      send ?? ((target: PushTarget, message: PushMessage) => providers.send(target, message));
    await this.pool.query(
      "UPDATE customer_push_deliveries SET state='failed',last_code='attempts_exhausted' WHERE state='sending' AND lease_until<clock_timestamp() AND attempts>=10",
    );
    const lease = randomUUID();
    const jobs = await transaction(
      this.pool,
      async (db) =>
        (
          await db.query<{ notification_id: string; device_id: string; attempts: number }>(
            `WITH candidates AS(SELECT notification_id,device_id FROM customer_push_deliveries WHERE ((state='pending' AND available_at<=clock_timestamp()) OR (state='sending' AND lease_until<clock_timestamp())) AND attempts<10 ORDER BY available_at LIMIT 10 FOR UPDATE SKIP LOCKED) UPDATE customer_push_deliveries d SET state='sending',attempts=d.attempts+1,lease_id=$1,lease_until=clock_timestamp()+interval '3 minutes' FROM candidates c WHERE d.notification_id=c.notification_id AND d.device_id=c.device_id RETURNING d.notification_id,d.device_id,d.attempts`,
            [lease],
          )
        ).rows,
    );
    for (const job of jobs) {
      const row = (
        await this.pool.query<{
          id: string;
          token_cipher: string;
          token_hash: string;
          provider: 'apns' | 'fcm';
          environment: 'development' | 'production';
          bundle_id: string;
          locale: NotificationLocale;
          order_id: string;
          kind: OrderNotificationKind;
        }>(
          `SELECT d.*,p.locale,n.order_id,n.kind FROM customer_push_devices d JOIN identity_sessions s ON s.id=d.session_id JOIN identity_customers c ON c.id=d.customer_id JOIN customer_notification_preferences p ON p.customer_id=d.customer_id JOIN customer_notifications n ON n.id=$1 AND n.customer_id=d.customer_id JOIN customer_push_deliveries q ON q.notification_id=n.id AND q.device_id=d.id WHERE d.id=$2 AND d.disabled_at IS NULL AND d.token_cipher IS NOT NULL AND s.revoked_at IS NULL AND s.refresh_hash IS NOT NULL AND c.deleted_at IS NULL AND p.orders AND n.created_at>clock_timestamp()-interval '30 minutes' AND q.state='sending' AND q.lease_id=$3`,
          [job.notification_id, job.device_id, lease],
        )
      ).rows[0];
      let result: DeliveryResult = { state: 'failed', code: 'no_longer_eligible' };
      if (row) {
        try {
          result = await dispatch(
            {
              token: this.unseal(row.id, row.token_cipher),
              provider: row.provider,
              environment: row.environment,
              bundleId: row.bundle_id,
            },
            {
              ...notificationText(row.kind, row.locale),
              notificationId: job.notification_id,
              orderId: row.order_id,
            },
          );
        } catch {
          result = { state: 'retry', code: 'transport_unavailable' };
        }
      }
      const state =
        result.state === 'accepted'
          ? 'accepted'
          : result.state === 'retry' && job.attempts < 10
            ? 'pending'
            : result.state === 'invalid' || !row
              ? 'discarded'
              : 'failed';
      await transaction(this.pool, async (db) => {
        await db.query(
          `UPDATE customer_push_deliveries SET state=$4,last_code=$5,lease_id=NULL,lease_until=NULL,available_at=clock_timestamp()+($6*interval '1 second'),updated_at=clock_timestamp() WHERE notification_id=$1 AND device_id=$2 AND lease_id=$3`,
          [
            job.notification_id,
            job.device_id,
            lease,
            state,
            result.code,
            Math.min(1800, 60 * 2 ** (job.attempts - 1)),
          ],
        );
        if (row && result.state === 'invalid')
          await db.query(
            'UPDATE customer_push_devices SET disabled_at=clock_timestamp(),token_cipher=NULL WHERE id=$1 AND token_hash=$2',
            [row.id, row.token_hash],
          );
      });
    }
    // Deleted accounts and revoked sessions cannot remain reachable even when the app is offline.
    await this.pool.query(
      `UPDATE customer_push_devices d SET disabled_at=clock_timestamp(),token_cipher=NULL WHERE d.token_cipher IS NOT NULL AND (d.updated_at<clock_timestamp()-interval '90 days' OR EXISTS(SELECT 1 FROM identity_sessions s JOIN identity_customers c ON c.id=s.customer_id WHERE s.id=d.session_id AND (s.revoked_at IS NOT NULL OR c.deleted_at IS NOT NULL)))`,
    );
    await this.pool.query(
      "DELETE FROM customer_notifications WHERE created_at<clock_timestamp()-interval '90 days'",
    );
    return jobs.length;
  }
}
