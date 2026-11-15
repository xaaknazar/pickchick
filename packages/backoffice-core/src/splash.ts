import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { BackofficeError, parse, type BackofficeErrorReason } from './model.js';

/**
 * Video of the mobile app storefront («заставка», owner request 15.11.2026; cloud078), behind
 * BACKOFFICE_APP_SPLASH_ENABLED (default off).
 *
 * The staff portal accepts at most 300 KB per request, so the back office sends an MP4 in parts
 * of at most 256 KiB (`uploadPart`), then asks to assemble it (`finishUpload`); the database
 * re-derives the SHA-256 and checks the MP4 signature. `setSplash` chooses the video of the
 * organization (append-only, the latest row wins; null = the video built into the app). The app
 * reads `splash` in the published content and downloads /v1/media/app/<sha256>.mp4 (`file`,
 * with HTTP ranges, which iOS needs to play a remote MP4).
 */
export const SPLASH_MAX_BYTES = 25 * 1024 * 1024;
export const SPLASH_MIN_BYTES = 1024;
export const SPLASH_PART_BYTES = 256 * 1024;
export const SPLASH_MAX_PARTS = Math.ceil(SPLASH_MAX_BYTES / SPLASH_PART_BYTES);
/** Abandoned uploads are dropped after a day. */
const UPLOAD_TTL = "interval '1 day'";
export const SPLASH_MEDIA_FILE = /^([a-f0-9]{64})\.mp4$/;
export const splashMediaUrl = (sha256: string) => `/v1/media/app/${sha256}.mp4`;
const fail = (
  code: ConstructorParameters<typeof BackofficeError>[0],
  reason?: BackofficeErrorReason,
): never => {
  throw new BackofficeError(code, reason);
};
type Db = Pick<DatabaseClient, 'query'>;
type Actor = { id: string; organization_id: string };

export const SplashPartQuery = z.strictObject({
  total_bytes: z.coerce.number().int().min(SPLASH_MIN_BYTES).max(SPLASH_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const SplashSetBody = z.strictObject({
  video_id: z.uuid().nullable(),
  reason: z.string().trim().min(1).max(500),
});

/** Whether cloud078 is installed (the flag may be on before the migration step). */
export async function splashInstalled(db: Db) {
  return (
    (await db.query("SELECT 1 WHERE to_regclass('app_splash_settings') IS NOT NULL")).rowCount === 1
  );
}

/** Current video and the uploaded ones of the organization (newest first, without bytes). */
export async function readSplash(db: Db, organization: string) {
  const current = (
    await db.query<{ video_id: string | null; created_at: Date; reason: string }>(
      'SELECT video_id,created_at,reason FROM app_splash_settings WHERE organization_id=$1 ORDER BY id DESC LIMIT 1',
      [organization],
    )
  ).rows[0];
  const videos = (
    await db.query<{ id: string; sha256: string; size: number; created_at: Date }>(
      'SELECT id,sha256,octet_length(bytes) size,created_at FROM app_splash_videos WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 20',
      [organization],
    )
  ).rows;
  return {
    current: current?.video_id ?? null,
    changed_at: current?.created_at ?? null,
    videos: videos.map((v) => ({ ...v, url: splashMediaUrl(v.sha256) })),
    limits: { max_bytes: SPLASH_MAX_BYTES, part_bytes: SPLASH_PART_BYTES },
  };
}

/** One part of an upload. Idempotent: the same part again with the same bytes is accepted. */
export async function uploadPart(
  db: Db,
  actor: Actor,
  uploadId: string,
  part: number,
  query: unknown,
  bytes: unknown,
) {
  parse(z.uuid(), uploadId);
  const q = parse(SplashPartQuery, query);
  if (!Number.isSafeInteger(part) || part < 0 || part >= SPLASH_MAX_PARTS) fail('INVALID_REQUEST');
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > SPLASH_PART_BYTES)
    fail('INVALID_REQUEST', 'SPLASH_PART_SIZE');
  const body = bytes as Buffer;
  if (part * SPLASH_PART_BYTES >= q.total_bytes) fail('INVALID_REQUEST', 'SPLASH_PART_SIZE');
  await db.query(
    `DELETE FROM app_splash_uploads WHERE created_at < clock_timestamp() - ${UPLOAD_TTL}`,
  );
  const upload = (
    await db.query<{ organization_id: string; total_bytes: number; sha256: string }>(
      `INSERT INTO app_splash_uploads(id,organization_id,uploaded_by,total_bytes,sha256) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING organization_id,total_bytes,sha256`,
      [uploadId, actor.organization_id, actor.id, q.total_bytes, q.sha256],
    )
  ).rows[0]!;
  if (
    upload.organization_id !== actor.organization_id ||
    upload.total_bytes !== q.total_bytes ||
    upload.sha256 !== q.sha256
  )
    fail('CONFLICT');
  const stored = (
    await db.query<{ same: boolean }>(
      `INSERT INTO app_splash_upload_parts(upload_id,part,bytes) VALUES($1,$2,$3)
       ON CONFLICT(upload_id,part) DO UPDATE SET part=EXCLUDED.part RETURNING bytes=$3 same`,
      [uploadId, part, body],
    )
  ).rows[0]!;
  if (!stored.same) fail('CONFLICT');
  return { upload_id: uploadId, part, received: body.length };
}

/** Assembles the parts into a video (or returns the video already stored with that hash). */
export async function finishUpload(db: Db, actor: Actor, uploadId: string) {
  parse(z.uuid(), uploadId);
  const upload = (
    await db.query<{ total_bytes: number; sha256: string; parts: number; size: number }>(
      `SELECT u.total_bytes,u.sha256,count(p.part)::int parts,coalesce(sum(octet_length(p.bytes)),0)::int size
       FROM app_splash_uploads u LEFT JOIN app_splash_upload_parts p ON p.upload_id=u.id
       WHERE u.id=$1 AND u.organization_id=$2 GROUP BY u.id`,
      [uploadId, actor.organization_id],
    )
  ).rows[0];
  if (!upload) return fail('NOT_FOUND');
  if (
    upload.size !== upload.total_bytes ||
    upload.parts !== Math.ceil(upload.total_bytes / SPLASH_PART_BYTES)
  )
    fail('CONFLICT', 'SPLASH_UPLOAD_INCOMPLETE');
  const existing = await findVideo(db, actor.organization_id, upload.sha256);
  if (!existing) {
    const check = (
      await db.query<{ sha256: string; ftyp: boolean }>(
        `SELECT encode(sha256(b),'hex') sha256, substring(b FROM 5 FOR 4)=decode('66747970','hex') ftyp
         FROM (SELECT string_agg(bytes,''::bytea ORDER BY part) b FROM app_splash_upload_parts WHERE upload_id=$1) v`,
        [uploadId],
      )
    ).rows[0]!;
    if (check.sha256 !== upload.sha256) fail('INVALID_REQUEST', 'SPLASH_HASH_MISMATCH');
    if (!check.ftyp) fail('INVALID_REQUEST', 'SPLASH_NOT_MP4');
    await db.query(
      `INSERT INTO app_splash_videos(id,organization_id,sha256,bytes,uploaded_by)
       SELECT $2,$3,$4,string_agg(bytes,''::bytea ORDER BY part),$5 FROM app_splash_upload_parts WHERE upload_id=$1`,
      [uploadId, randomUUID(), actor.organization_id, upload.sha256, actor.id],
    );
  }
  await db.query('DELETE FROM app_splash_uploads WHERE id=$1', [uploadId]);
  return (await findVideo(db, actor.organization_id, upload.sha256))!;
}
async function findVideo(db: Db, organization: string, sha256: string) {
  const v = (
    await db.query<{ id: string; sha256: string; size: number; created_at: Date }>(
      'SELECT id,sha256,octet_length(bytes) size,created_at FROM app_splash_videos WHERE organization_id=$1 AND sha256=$2',
      [organization, sha256],
    )
  ).rows[0];
  return v ? { ...v, url: splashMediaUrl(v.sha256) } : null;
}

/** Chooses the video of the app (null: the built-in one). */
export async function setSplash(db: Db, actor: Actor, body: unknown) {
  const b = parse(SplashSetBody, body);
  if (
    b.video_id &&
    !(
      await db.query('SELECT 1 FROM app_splash_videos WHERE id=$1 AND organization_id=$2', [
        b.video_id,
        actor.organization_id,
      ])
    ).rowCount
  )
    fail('NOT_FOUND');
  await db.query(
    'INSERT INTO app_splash_settings(organization_id,video_id,set_by,reason) VALUES($1,$2,$3,$4)',
    [actor.organization_id, b.video_id, actor.id, b.reason],
  );
  return readSplash(db, actor.organization_id);
}

/** Published splash of the organization of a branch, for GET /v1/content (null: built-in). */
export async function publishedSplash(db: Db, branch: string) {
  const row = (
    await db.query<{ sha256: string; size: number }>(
      `SELECT v.sha256,octet_length(v.bytes) size FROM branches b
       JOIN LATERAL (SELECT video_id FROM app_splash_settings s WHERE s.organization_id=b.organization_id ORDER BY s.id DESC LIMIT 1) s ON true
       JOIN app_splash_videos v ON v.id=s.video_id WHERE b.id=$1`,
      [branch],
    )
  ).rows[0];
  return row ? { video: splashMediaUrl(row.sha256), sha256: row.sha256, bytes: row.size } : null;
}

export interface SplashFile {
  sha256: string;
  size: number;
  start: number;
  end: number;
  bytes: Buffer;
  partial: boolean;
}
/**
 * Public bytes of a video by its hash, whole or one `bytes=a-b` range (iOS plays a remote MP4
 * only with ranges). Throws NOT_FOUND for an unknown file, INVALID_REQUEST (416) for a bad range.
 */
export async function splashFile(
  pool: DatabasePool,
  file: string,
  range?: string,
): Promise<SplashFile> {
  const sha = SPLASH_MEDIA_FILE.exec(file)?.[1];
  if (!sha) return fail('NOT_FOUND');
  const head = (
    await pool.query<{ size: number }>(
      'SELECT octet_length(bytes) size FROM app_splash_videos WHERE sha256=$1 LIMIT 1',
      [sha],
    )
  ).rows[0];
  if (!head) return fail('NOT_FOUND');
  let start = 0,
    end = head.size - 1,
    partial = false;
  if (range !== undefined) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) return fail('INVALID_REQUEST', 'RANGE');
    if (m[1] === '') {
      start = Math.max(0, head.size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= head.size) return fail('INVALID_REQUEST', 'RANGE');
    partial = true;
  }
  const bytes = (
    await pool.query<{ bytes: Buffer }>(
      'SELECT substring(bytes FROM $2 FOR $3) bytes FROM app_splash_videos WHERE sha256=$1 LIMIT 1',
      [sha, start + 1, end - start + 1],
    )
  ).rows[0]!.bytes;
  return { sha256: sha, size: head.size, start, end, bytes, partial };
}
