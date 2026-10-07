import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { transaction, type DatabasePool } from '@pickchick/database';
import { z } from 'zod';
import { CommerceError } from './model.js';
const Login = z.string().regex(/^[A-Za-z0-9_.-]{3,64}$/);
const Input = z.strictObject({
  login: Login,
  password: z.string().min(12).max(128),
  requestId: z.uuid(),
});
const digest = (key: string) => createHash('sha256').update(key).digest('hex');
const aad = (d: { deviceId: string; organizationId: string; branchId: string; login: string }) =>
  Buffer.from(
    JSON.stringify([
      d.deviceId.toLowerCase(),
      d.organizationId.toLowerCase(),
      d.branchId.toLowerCase(),
      d.login,
    ]),
  );
const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (e, key) =>
      e ? reject(e) : resolve(key),
    );
  });
export function kioskEnrollmentKey(env: NodeJS.ProcessEnv): Buffer | null {
  const value = env.KIOSK_ENROLLMENT_KEY;
  if (!value) return null;
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid KIOSK_ENROLLMENT_KEY');
  return Buffer.from(value, 'hex');
}
/** Offline provisioning only. The plaintext device token is never stored by this module. */
export async function createKioskEnrollmentMaterial(
  input: {
    login: string;
    password: string;
    deviceId: string;
    organizationId: string;
    branchId: string;
    key: string;
  },
  encryptionKey: Buffer,
) {
  Input.parse({ login: input.login, password: input.password, requestId: input.deviceId });
  z.uuid().parse(input.organizationId);
  z.uuid().parse(input.branchId);
  if (!/^[0-9a-f]{64}$/.test(input.key) || encryptionKey.length !== 32)
    throw new CommerceError('INVALID');
  const salt = randomBytes(16),
    nonce = randomBytes(12);
  const verifier = await derive(input.password, salt);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(aad(input));
  const ciphertext = Buffer.concat([cipher.update(input.key, 'utf8'), cipher.final()]);
  return {
    salt,
    verifier,
    nonce,
    ciphertext,
    tag: cipher.getAuthTag(),
    tokenHash: digest(input.key),
  };
}
/** One process has a fixed bounded scrypt budget, including unknown aliases. */
export class KioskEnrollment {
  private active = 0;
  private readonly dummySalt = randomBytes(16);
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: {
      encryptionKey: Buffer;
      organizationId: string;
      branchId: string;
    },
  ) {
    if (options.encryptionKey.length !== 32) throw new CommerceError('INVALID');
  }
  async exchange(value: unknown): Promise<{ deviceId: string; key: string }> {
    const parsed = Input.safeParse(value);
    if (!parsed.success || this.active >= 4) throw new CommerceError('FORBIDDEN');
    this.active++;
    try {
      const input = { ...parsed.data, requestId: parsed.data.requestId.toLowerCase() };
      const result = await transaction(this.pool, async (db) => {
        const row = (
          await db.query(
            `SELECT *, expires_at>clock_timestamp() live,
          locked_until>clock_timestamp() locked FROM kiosk_enrollment_aliases WHERE login=$1 FOR UPDATE`,
            [input.login],
          )
        ).rows[0];
        const supplied = await derive(input.password, row?.password_salt ?? this.dummySalt);
        if (!row) return null;
        if (
          row.organization_id !== this.options.organizationId.toLowerCase() ||
          row.branch_id !== this.options.branchId.toLowerCase() ||
          !row.active ||
          !row.live ||
          row.locked
        )
          return null;
        if (!timingSafeEqual(supplied, row.password_verifier)) {
          await db.query(
            `UPDATE kiosk_enrollment_aliases SET
            failed_attempts=CASE WHEN failed_attempts>=4 THEN 0 ELSE failed_attempts+1 END,
            locked_until=CASE WHEN failed_attempts>=4 THEN clock_timestamp()+interval '15 minutes' ELSE locked_until END
            WHERE login=$1`,
            [input.login],
          );
          return null;
        }
        if (row.request_id && row.request_id !== input.requestId) return null;
        const device = (
          await db.query(
            `SELECT token_hash FROM kiosk_devices WHERE id=$1 AND organization_id=$2 AND branch_id=$3 AND active FOR SHARE`,
            [row.device_id, row.organization_id, row.branch_id],
          )
        ).rows[0];
        if (!device) return null;
        let key: string;
        try {
          const cipher = createDecipheriv(
            'aes-256-gcm',
            this.options.encryptionKey,
            row.token_nonce,
          );
          cipher.setAAD(
            aad({
              deviceId: row.device_id,
              organizationId: row.organization_id,
              branchId: row.branch_id,
              login: row.login,
            }),
          );
          cipher.setAuthTag(row.token_tag);
          key = Buffer.concat([cipher.update(row.token_ciphertext), cipher.final()]).toString(
            'utf8',
          );
        } catch {
          return null;
        }
        if (!/^[0-9a-f]{64}$/.test(key) || digest(key) !== device.token_hash) return null;
        await db.query(
          'UPDATE kiosk_enrollment_aliases SET request_id=$2,failed_attempts=0,locked_until=NULL WHERE login=$1',
          [input.login, input.requestId],
        );
        return { deviceId: row.device_id as string, key };
      });
      if (!result) throw new CommerceError('FORBIDDEN');
      return result;
    } finally {
      this.active--;
    }
  }
}
