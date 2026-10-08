import { createHash } from 'node:crypto';
import { DeviceIdentitySchema, MenuSha256Schema } from '@pickchick/contracts';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { SyncError } from './common.js';
import { deviceRequest, localCloudOrigin } from './device-http.js';

export const MENU_MEDIA_MAX_BYTES = 1_500_000;
const MAX_MEDIA_PER_CALL = 10_000;

/**
 * Private cloud route for the card variant of an uploaded catalog photo. The hash in the
 * path is the SHA-256 of the card WebP bytes, the same value the snapshot carries in
 * item.image.sha256 (WP-F serves it with device bearer auth on the private port).
 */
export const menuMediaPath = (sha256: string) => `/internal/v1/edge/media/${sha256}.card.webp`;

/** RIFF....WEBP container header; the bytes are served back as image/webp with nosniff. */
export function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 16 &&
    Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('latin1') === 'WEBP'
  );
}

function uniqueShas(shas: readonly string[]): string[] {
  const unique = [...new Set(shas)];
  if (
    unique.length > MAX_MEDIA_PER_CALL ||
    unique.some((sha) => !MenuSha256Schema.safeParse(sha).success)
  )
    throw new SyncError('INVALID_REQUEST');
  return unique;
}

/** Image hashes from a menu snapshot, de-duplicated in item order. */
export function menuImageShas(menu: {
  items: readonly { image?: { sha256: string } | undefined }[];
}) {
  return [...new Set(menu.items.flatMap((item) => (item.image ? [item.image.sha256] : [])))];
}

export async function missingMenuMedia(
  db: Pick<DatabaseClient | DatabasePool, 'query'>,
  shas: readonly string[],
): Promise<string[]> {
  const wanted = uniqueShas(shas);
  if (!wanted.length) return [];
  const present = await db.query<{ sha256: string }>(
    'SELECT sha256 FROM menu_media WHERE sha256 = ANY($1::text[])',
    [wanted],
  );
  const have = new Set(present.rows.map((row) => row.sha256));
  return wanted.filter((sha) => !have.has(sha));
}

/**
 * Downloads, verifies and caches card photos. Each body must hash to its requested SHA-256
 * and be a WebP container; stored rows are immutable and keyed by content, so a retry or a
 * concurrent download is a no-op. Every hash is attempted; the first failure is rethrown.
 */
export async function fetchMenuMedia(
  pool: DatabasePool,
  originInput: string,
  identityInput: unknown,
  shas: readonly string[],
): Promise<{ fetched: number }> {
  const origin = localCloudOrigin(originInput);
  const identity = DeviceIdentitySchema.parse(identityInput);
  let fetched = 0;
  let failure: unknown;
  for (const sha of uniqueShas(shas)) {
    try {
      const bytes = await deviceRequest(origin, menuMediaPath(sha), identity, {
        maxBytes: MENU_MEDIA_MAX_BYTES,
        accept: 'image/webp',
      });
      if (createHash('sha256').update(bytes).digest('hex') !== sha)
        throw new Error('Menu media hash mismatch');
      if (!isWebp(bytes)) throw new Error('Menu media is not WebP');
      await pool.query(
        `INSERT INTO menu_media(sha256, mime, bytes) VALUES ($1, 'image/webp', $2)
        ON CONFLICT (sha256) DO NOTHING`,
        [sha, bytes],
      );
      fetched += 1;
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  return { fetched };
}
