import { createHash, randomUUID } from 'node:crypto';
import type { Metadata, OutputInfo } from 'sharp';
import { z } from 'zod';
import { authenticateDevice } from '@pickchick/menu-sync';
import type { DeviceAuth } from '@pickchick/menu-sync';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { authorizeCatalog } from './auth.js';
import type { CatalogAuthOptions } from './auth.js';
import { CatalogAdminError, CatalogMediaEntrySchema, parseCatalogInput } from './contracts.js';
import type { CatalogErrorReason, CatalogMediaEntry, CatalogPayload } from './contracts.js';

export const CATALOG_MEDIA = Symbol('CATALOG_MEDIA');
/** Upload cap, also enforced by the API raw parser and the gateway request_body limit. */
export const CATALOG_ASSET_MAX_BYTES = 10 * 1024 * 1024;
/** Decompression-bomb guard: sharp refuses to decode anything with more pixels. */
export const CATALOG_ASSET_MAX_PIXELS = 40_000_000;
export const CATALOG_ASSET_MIN_SIDE = 32;
/** Same cap as the database CHECK and the edge menu_media cache. */
export const CATALOG_ASSET_VARIANT_MAX_BYTES = 1_500_000;
export const CATALOG_ASSET_QUALITY = 82;
/** Longest edge of each WebP rendition; smaller sources are never enlarged. */
export const CATALOG_ASSET_VARIANTS = { card: 640, hero: 1280, thumb: 240 } as const;
export type CatalogAssetVariantName = keyof typeof CATALOG_ASSET_VARIANTS;
const VARIANT_NAMES = Object.keys(CATALOG_ASSET_VARIANTS) as CatalogAssetVariantName[];
/** Per-actor upload rate limit (receipt replays do not count). */
export const CATALOG_ASSET_RATE_LIMIT = { uploads: 30, windowSeconds: 600 } as const;
/** Content types the API body parser accepts on the upload route; sniffing decides the rest. */
export const CATALOG_ASSET_CONTENT_TYPE = /^image\/(?:jpeg|png|webp|heic|heif)(?:;|$)/i;
export const CATALOG_ASSET_UPLOAD_ROUTE =
  /^\/v1\/admin\/catalog\/branches\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/assets\/?$/;
/** `<variant sha256>.<variant>.webp` (media map form) or `<variant sha256>.webp`. */
export const CATALOG_MEDIA_FILE = /^([a-f0-9]{64})(?:\.(card|hero|thumb))?\.webp$/;
export const catalogMediaUrl = (sha256: string, variant: CatalogAssetVariantName) =>
  `/v1/media/catalog/${sha256}.${variant}.webp`;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Dimension = z.int().positive();
export const CatalogAssetVariantSchema = z.strictObject({
  sha256: Sha256,
  url: z.string().regex(/^\/v1\/media\/catalog\/[a-f0-9]{64}\.(?:card|hero|thumb)\.webp$/),
  width: Dimension,
  height: Dimension,
  bytes: z.int().positive().max(CATALOG_ASSET_VARIANT_MAX_BYTES),
});
export const CatalogAssetSchema = z.strictObject({
  asset_id: z.uuid(),
  /** Canonical hero WebP hash; equal photos share one asset per organisation. */
  sha256: Sha256,
  source_sha256: Sha256,
  width: Dimension,
  height: Dimension,
  uploaded_by: z.uuid(),
  created_at: z.iso.datetime(),
  /** Ready-made product.image reference: the card rendition hash is what POS and edge use. */
  image: z.strictObject({ asset_id: z.uuid(), sha256: Sha256 }),
  variants: z.strictObject({
    card: CatalogAssetVariantSchema,
    hero: CatalogAssetVariantSchema,
    thumb: CatalogAssetVariantSchema,
  }),
});
export type CatalogAsset = z.infer<typeof CatalogAssetSchema>;
export const CatalogAssetListSchema = z.strictObject({ assets: z.array(CatalogAssetSchema) });
export type CatalogAssetList = z.infer<typeof CatalogAssetListSchema>;

export interface CatalogMediaOptions extends CatalogAuthOptions {
  /** CATALOG_MEDIA_UPLOAD_ENABLED: upload, list and both media routes. Off by default. */
  mediaEnabled?: boolean;
}
export function catalogMediaOptions(env: Readonly<Record<string, string | undefined>> = {}): {
  mediaEnabled: boolean;
} {
  const value = env['CATALOG_MEDIA_UPLOAD_ENABLED'] ?? 'false';
  if (!['true', 'false'].includes(value))
    throw new Error('CATALOG_MEDIA_UPLOAD_CONFIGURATION_INVALID');
  return { mediaEnabled: value === 'true' };
}

const failure = (code: CatalogAdminError['code'], reason?: CatalogErrorReason) =>
  reason ? new CatalogAdminError(code, reason) : new CatalogAdminError(code);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export type CatalogImageType = 'jpeg' | 'png' | 'webp' | 'heif';
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
/** Magic-byte sniffing. Only JPEG, PNG, WebP and HEIC/HEIF containers are recognised. */
export function sniffCatalogImage(bytes: Uint8Array): CatalogImageType | null {
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString('latin1');
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  )
    return 'png';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(8, 12))) return 'heif';
  return null;
}

// Long, case-insensitive markers: a random compressed image contains one with negligible odds.
const ACTIVE_CONTENT = ['<script', '<!doctype', '<html', '<svg xmlns', '<?php', '<iframe'].map(
  (marker) => Buffer.from(marker, 'latin1'),
);
/** Markup or script embedded in an image (an image/HTML/SVG polyglot). */
export function containsActiveContent(bytes: Uint8Array): boolean {
  const lower = Buffer.from(bytes);
  for (let i = 0; i < lower.length; i += 1) {
    const value = lower[i]!;
    if (value >= 0x41 && value <= 0x5a) lower[i] = value + 0x20;
  }
  return ACTIVE_CONTENT.some((marker) => lower.includes(marker));
}

export interface EncodedCatalogVariant {
  sha256: string;
  bytes: Buffer;
  width: number;
  height: number;
}
export interface EncodedCatalogImage {
  source_sha256: string;
  type: CatalogImageType;
  /** Upright source dimensions (after EXIF orientation). */
  width: number;
  height: number;
  variants: Record<CatalogAssetVariantName, EncodedCatalogVariant>;
}

type SharpModule = typeof import('sharp');
let sharpModule: Promise<SharpModule['default']> | undefined;
/**
 * libvips is loaded on first use, so a host without the native binary still boots the API;
 * uploads then fail closed with SERVICE_UNAVAILABLE.
 */
async function loadSharp() {
  sharpModule ??= import('sharp').then(({ default: sharp }) => {
    // No libvips operation cache: uploads are rare and the API container is small.
    sharp.cache(false);
    return sharp;
  });
  try {
    return await sharpModule;
  } catch {
    sharpModule = undefined;
    throw failure('SERVICE_UNAVAILABLE');
  }
}
async function decoder(bytes: Buffer) {
  const sharp = await loadSharp();
  return sharp(bytes, {
    limitInputPixels: CATALOG_ASSET_MAX_PIXELS,
    failOn: 'error',
    animated: false,
    sequentialRead: true,
  });
}

/**
 * Validates and re-encodes one uploaded photo. The content is kept as supplied: the image is
 * only turned upright by its EXIF orientation, resized down and re-compressed to WebP. All
 * metadata (EXIF, GPS, XMP, ICC) is dropped. Throws CatalogAdminError with a stable reason.
 */
export async function encodeCatalogImage(input: Uint8Array): Promise<EncodedCatalogImage> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.length) throw failure('INVALID_REQUEST', 'ASSET_UNSUPPORTED_TYPE');
  if (bytes.length > CATALOG_ASSET_MAX_BYTES) throw failure('INVALID_REQUEST', 'ASSET_TOO_LARGE');
  const type = sniffCatalogImage(bytes);
  if (!type || containsActiveContent(bytes))
    throw failure('INVALID_REQUEST', 'ASSET_UNSUPPORTED_TYPE');
  const image = () => decoder(bytes);
  let metadata: Metadata;
  try {
    metadata = await (await image()).metadata();
  } catch (error) {
    if (error instanceof CatalogAdminError) throw error;
    throw failure('INVALID_REQUEST', 'ASSET_INVALID_IMAGE');
  }
  // The decoder must agree with the container the magic bytes claimed.
  if (metadata.format !== type) throw failure('INVALID_REQUEST', 'ASSET_UNSUPPORTED_TYPE');
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (
    !width ||
    !height ||
    width * height > CATALOG_ASSET_MAX_PIXELS ||
    Math.min(width, height) < CATALOG_ASSET_MIN_SIDE
  )
    throw failure('INVALID_REQUEST', 'ASSET_INVALID_IMAGE');
  const variants = {} as Record<CatalogAssetVariantName, EncodedCatalogVariant>;
  for (const name of VARIANT_NAMES) {
    const edge = CATALOG_ASSET_VARIANTS[name];
    let output: { data: Buffer; info: OutputInfo };
    try {
      output = await (
        await image()
      )
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: CATALOG_ASSET_QUALITY, effort: 4, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      if (error instanceof CatalogAdminError) throw error;
      throw failure('INVALID_REQUEST', 'ASSET_INVALID_IMAGE');
    }
    if (output.data.length > CATALOG_ASSET_VARIANT_MAX_BYTES)
      throw failure('INVALID_REQUEST', 'ASSET_TOO_LARGE');
    variants[name] = {
      sha256: sha256(output.data),
      bytes: output.data,
      width: output.info.width,
      height: output.info.height,
    };
  }
  return { source_sha256: sha256(bytes), type, width, height, variants };
}

/** One encode at a time per process; a short queue, then fail fast (retryable 503). */
class EncodeGate {
  private active = false;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly maxWaiting: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active) {
      if (this.waiting.length >= this.maxWaiting) throw failure('SERVICE_UNAVAILABLE');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active = true;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active = false;
    }
  }
}

interface AssetRow {
  id: string;
  sha256: string;
  source_sha256: string;
  width: number;
  height: number;
  uploaded_by: string;
  created_at: Date;
  variants: {
    variant: CatalogAssetVariantName;
    sha256: string;
    width: number;
    height: number;
    bytes: number;
  }[];
}
const ASSET_SELECT = `SELECT a.id,a.sha256,a.source_sha256,a.width,a.height,a.uploaded_by,a.created_at,
  (SELECT json_agg(json_build_object('variant',v.variant,'sha256',v.sha256,'width',v.width,
     'height',v.height,'bytes',octet_length(v.bytes)) ORDER BY v.variant)
   FROM catalog_asset_variants v WHERE v.asset_id=a.id) variants
  FROM catalog_assets a`;
function assetResponse(row: AssetRow): CatalogAsset {
  const variants = Object.fromEntries(
    (row.variants ?? []).map((v) => [
      v.variant,
      {
        sha256: v.sha256,
        url: catalogMediaUrl(v.sha256, v.variant),
        width: v.width,
        height: v.height,
        bytes: v.bytes,
      },
    ]),
  ) as CatalogAsset['variants'];
  return CatalogAssetSchema.parse({
    asset_id: row.id,
    sha256: row.sha256,
    source_sha256: row.source_sha256,
    width: row.width,
    height: row.height,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at.toISOString(),
    image: { asset_id: row.id, sha256: variants.card?.sha256 },
    variants,
  });
}

/** Every product.image must name an asset of this organisation whose card hash matches. */
export async function assertCatalogAssets(
  db: Pick<DatabaseClient, 'query'>,
  organizationId: string,
  payload: CatalogPayload,
): Promise<void> {
  const refs = payload.products.flatMap((product) => (product.image ? [product.image] : []));
  if (!refs.length) return;
  const table = await db.query<{ present: boolean }>(
    "SELECT to_regclass('catalog_asset_variants') IS NOT NULL present",
  );
  if (!table.rows[0]?.present) throw failure('CONFLICT', 'ASSET_MISSING');
  const found = await db.query<{ id: string; sha256: string }>(
    `SELECT a.id,v.sha256 FROM catalog_assets a
     JOIN catalog_asset_variants v ON v.asset_id=a.id AND v.variant='card'
     WHERE a.organization_id=$1 AND a.id=ANY($2::uuid[])`,
    [organizationId, [...new Set(refs.map((ref) => ref.asset_id))]],
  );
  const cards = new Map(found.rows.map((row) => [row.id, row.sha256]));
  if (refs.some((ref) => cards.get(ref.asset_id) !== ref.sha256))
    throw failure('CONFLICT', 'ASSET_MISSING');
}

/**
 * Media map entries (all three renditions) for products whose image ref resolves to an
 * existing asset of the organisation; unresolved refs are left out. Keyed by product id.
 */
export async function catalogMediaEntries(
  db: Pick<DatabaseClient, 'query'>,
  organizationId: string,
  payload: CatalogPayload,
): Promise<Record<string, CatalogMediaEntry>> {
  const refs = payload.products.flatMap((product) =>
    product.image ? [{ id: product.id, image: product.image }] : [],
  );
  if (!refs.length) return {};
  const rows = await db.query<{
    asset_id: string;
    variant: CatalogAssetVariantName;
    sha256: string;
  }>(
    `SELECT v.asset_id,v.variant,v.sha256 FROM catalog_asset_variants v
     JOIN catalog_assets a ON a.id=v.asset_id
     WHERE a.organization_id=$1 AND a.id=ANY($2::uuid[])`,
    [organizationId, [...new Set(refs.map((ref) => ref.image.asset_id))]],
  );
  const byAsset = new Map<string, Partial<Record<CatalogAssetVariantName, string>>>();
  for (const row of rows.rows)
    byAsset.set(row.asset_id, { ...byAsset.get(row.asset_id), [row.variant]: row.sha256 });
  const entries: Record<string, CatalogMediaEntry> = {};
  for (const { id, image } of refs) {
    const variants = byAsset.get(image.asset_id);
    if (!variants?.card || !variants.hero || !variants.thumb || variants.card !== image.sha256)
      continue;
    entries[id] = CatalogMediaEntrySchema.parse({
      sha256: image.sha256,
      card: catalogMediaUrl(variants.card, 'card'),
      hero: catalogMediaUrl(variants.hero, 'hero'),
      thumb: catalogMediaUrl(variants.thumb, 'thumb'),
      ...(image.tile_color ? { tile_color: image.tile_color } : {}),
      ...(image.cutout !== undefined ? { cutout: image.cutout } : {}),
    });
  }
  return entries;
}

export interface CatalogMediaFile {
  sha256: string;
  bytes: Buffer;
}
function mediaFile(file: string) {
  const match = CATALOG_MEDIA_FILE.exec(file);
  if (!match) return null;
  return { sha256: match[1]!, variant: (match[2] ?? null) as CatalogAssetVariantName | null };
}

export class CatalogMedia {
  private readonly gate = new EncodeGate(4);
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: CatalogMediaOptions = { enabled: false },
  ) {}

  private requireEnabled() {
    if (!this.options.mediaEnabled || !this.options.enabled) throw failure('SERVICE_UNAVAILABLE');
  }

  /**
   * Manager-only photo upload. Authorises before any decoding, replays a receipt for the same
   * request id, enforces the per-actor rate limit and stores the renditions content-addressed.
   */
  async upload(
    token: string,
    branchId: string,
    input: unknown,
    requestId: unknown,
  ): Promise<CatalogAsset> {
    this.requireEnabled();
    const request = parseCatalogInput(z.uuid(), requestId);
    if (!(input instanceof Uint8Array)) throw failure('INVALID_REQUEST', 'ASSET_UNSUPPORTED_TYPE');
    if (input.byteLength > CATALOG_ASSET_MAX_BYTES)
      throw failure('INVALID_REQUEST', 'ASSET_TOO_LARGE');
    const source = sha256(input);
    const hash = sha256(JSON.stringify({ branch_id: branchId, kind: 'asset', source }));
    // Cheap pass: authorisation, lost-response replay and rate limit before CPU-heavy decoding.
    const replay = await transaction(this.pool, async (db) => {
      const { actor } = await authorizeCatalog(db, token, branchId, { write: true }, this.options);
      return (await this.receipt(db, actor.id, request, hash)) ?? (await this.limit(db, actor.id));
    });
    if (replay) return replay;
    const encoded = await this.gate.run(() => encodeCatalogImage(input));
    return transaction(this.pool, async (db) => {
      const { actor, branch } = await authorizeCatalog(
        db,
        token,
        branchId,
        { write: true },
        this.options,
      );
      // Serialises one actor's uploads so the receipt check and the rate count are exact.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 909002))', [
        `catalog-asset:${actor.id}`,
      ]);
      const again =
        (await this.receipt(db, actor.id, request, hash)) ?? (await this.limit(db, actor.id));
      if (again) return again;
      // Same canonical rendition in this organisation: reuse it (identical photo re-uploaded).
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 909003))', [
        `catalog-asset:${branch.organization_id}:${encoded.variants.hero.sha256}`,
      ]);
      let assetId = (
        await db.query<{ id: string }>(
          'SELECT id FROM catalog_assets WHERE organization_id=$1 AND sha256=$2',
          [branch.organization_id, encoded.variants.hero.sha256],
        )
      ).rows[0]?.id;
      const action = assetId ? 'reused' : 'uploaded';
      if (!assetId) {
        assetId = randomUUID();
        await db.query(
          'INSERT INTO catalog_assets(id,organization_id,sha256,source_sha256,width,height,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            assetId,
            branch.organization_id,
            encoded.variants.hero.sha256,
            encoded.source_sha256,
            encoded.width,
            encoded.height,
            actor.id,
          ],
        );
        for (const name of VARIANT_NAMES) {
          const variant = encoded.variants[name];
          await db.query(
            "INSERT INTO catalog_asset_variants(asset_id,variant,sha256,mime,width,height,bytes) VALUES($1,$2,$3,'image/webp',$4,$5,$6)",
            [assetId, name, variant.sha256, variant.width, variant.height, variant.bytes],
          );
        }
      }
      await db.query(
        'INSERT INTO catalog_asset_audit(id,organization_id,branch_id,actor_id,asset_id,request_id,action,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          branch.organization_id,
          branch.id,
          actor.id,
          assetId,
          request,
          action,
          encoded.source_sha256,
        ],
      );
      const response = await this.asset(db, branch.organization_id, assetId);
      await db.query(
        'INSERT INTO catalog_command_receipts(actor_id,request_id,request_hash,response) VALUES($1,$2,$3,$4)',
        [actor.id, request, hash, response],
      );
      return response;
    });
  }

  private async receipt(
    db: DatabaseClient,
    actorId: string,
    requestId: string,
    hash: string,
  ): Promise<CatalogAsset | null> {
    const row = (
      await db.query<{ request_hash: string; response: unknown }>(
        'SELECT request_hash,response FROM catalog_command_receipts WHERE actor_id=$1 AND request_id=$2',
        [actorId, requestId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_hash !== hash) throw failure('CONFLICT');
    return CatalogAssetSchema.parse(row.response);
  }

  private async limit(db: DatabaseClient, actorId: string): Promise<null> {
    const count = (
      await db.query<{ uploads: number }>(
        `SELECT count(*)::int uploads FROM catalog_asset_audit
         WHERE actor_id=$1 AND occurred_at > clock_timestamp() - make_interval(secs => $2)`,
        [actorId, CATALOG_ASSET_RATE_LIMIT.windowSeconds],
      )
    ).rows[0]!.uploads;
    if (count >= CATALOG_ASSET_RATE_LIMIT.uploads)
      throw failure('RATE_LIMITED', 'ASSET_RATE_LIMITED');
    return null;
  }

  private async asset(db: DatabaseClient, organizationId: string, id: string) {
    const row = (
      await db.query<AssetRow>(`${ASSET_SELECT} WHERE a.organization_id=$1 AND a.id=$2`, [
        organizationId,
        id,
      ])
    ).rows[0];
    if (!row) throw failure('NOT_FOUND');
    return assetResponse(row);
  }

  /** Newest first; any role with read access to a branch sees its organisation's photos. */
  async list(token: string, branchId: string): Promise<CatalogAssetList> {
    this.requireEnabled();
    return transaction(this.pool, async (db) => {
      const { branch } = await authorizeCatalog(
        db,
        token,
        branchId,
        { write: false },
        this.options,
      );
      const rows = await db.query<AssetRow>(
        `${ASSET_SELECT} WHERE a.organization_id=$1 ORDER BY a.created_at DESC, a.id LIMIT 200`,
        [branch.organization_id],
      );
      return CatalogAssetListSchema.parse({ assets: rows.rows.map(assetResponse) });
    });
  }

  /** Public immutable rendition by its own hash. Unknown names are NOT_FOUND. */
  async media(file: string): Promise<CatalogMediaFile> {
    if (!this.options.mediaEnabled) throw failure('NOT_FOUND');
    const wanted = mediaFile(file);
    if (!wanted) throw failure('NOT_FOUND');
    const row = (
      await this.pool.query<{ bytes: Buffer }>(
        `SELECT bytes FROM catalog_asset_variants WHERE sha256=$1 AND ($2::text IS NULL OR variant=$2)
         LIMIT 1`,
        [wanted.sha256, wanted.variant],
      )
    ).rows[0];
    if (!row) throw failure('NOT_FOUND');
    return { sha256: wanted.sha256, bytes: row.bytes };
  }

  /**
   * Private edge download (device bearer, the menu-sync identity). A device only reaches
   * renditions of its own organisation. Throws SyncError UNAUTHORIZED for a bad credential.
   */
  async edgeMedia(auth: DeviceAuth, file: string): Promise<CatalogMediaFile> {
    if (!this.options.mediaEnabled) throw failure('NOT_FOUND');
    return transaction(this.pool, async (db) => {
      const branchId = await authenticateDevice(db, auth);
      const wanted = mediaFile(file);
      if (!wanted) throw failure('NOT_FOUND');
      const row = (
        await db.query<{ bytes: Buffer }>(
          `SELECT v.bytes FROM catalog_asset_variants v
           JOIN catalog_assets a ON a.id=v.asset_id
           JOIN branches b ON b.organization_id=a.organization_id
           WHERE b.id=$1 AND v.sha256=$2 AND ($3::text IS NULL OR v.variant=$3) LIMIT 1`,
          [branchId, wanted.sha256, wanted.variant],
        )
      ).rows[0];
      if (!row) throw failure('NOT_FOUND');
      return { sha256: wanted.sha256, bytes: row.bytes };
    });
  }
}
