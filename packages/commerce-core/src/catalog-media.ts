import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { DatabasePool } from '@pickchick/database';
import { catalogMediaEntries } from '@pickchick/catalog-admin';
import {
  CatalogMediaMapSchema,
  CatalogPayloadSchema,
  stripStorefrontPayload,
} from '@pickchick/catalog-admin/contracts';
import type { CatalogMediaMap, CatalogPayload } from '@pickchick/catalog-admin/contracts';
import { CommerceError } from './model.js';

/** Response header carrying the head catalog version on every storefront availability read. */
export const CATALOG_VERSION_HEADER = 'X-Catalog-Version';
/** Response header carrying the availability signature (the kiosk body has no signature field). */
export const AVAILABILITY_SIGNATURE_HEADER = 'X-Availability-Signature';
export const AvailabilityAfterSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** `?version=N`, a positive catalog publication version sent as a query string. */
const VersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/)
  .transform((value) => Number(value));

export function parseCatalogMediaVersion(value: unknown): number {
  const result = VersionSchema.safeParse(value);
  if (!result.success) throw new CommerceError('INVALID');
  return result.data;
}

/**
 * Storefront payload for installed strict clients (kiosk build 7, mobile TestFlight): the
 * unified-menu product fields (uploaded photo ref, kitchen route) are removed; new clients read
 * the photos from the separate media map instead.
 */
export function storefrontPayload(payload: CatalogPayload): CatalogPayload {
  return stripStorefrontPayload(payload);
}

export interface CatalogMediaScope {
  organizationId: string;
  branchId: string;
}
export interface CatalogMediaMapOptions {
  /** CATALOG_MEDIA_UPLOAD_ENABLED. Off: the map is empty, so clients keep their bundled photos. */
  mediaEnabled: boolean;
}
const undefinedTable = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42P01';

/**
 * Photo map of the head publication for new storefront clients. `version` must be the head
 * version (a client holding an older publication gets CONFLICT and reloads the catalog first).
 * Only products whose uploaded photo still resolves to all three stored renditions are listed;
 * anything else falls back to the bundled `image_asset_key` on the client.
 */
export async function catalogMediaMap(
  db: Pick<DatabasePool, 'query'>,
  scope: CatalogMediaScope,
  version: unknown,
  options: CatalogMediaMapOptions,
): Promise<CatalogMediaMap> {
  const requested = parseCatalogMediaVersion(version);
  const head = (
    await db.query<{ version: number; payload: unknown }>(
      `SELECT p.version,p.payload FROM catalog_branch_heads h
       JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.organization_id=h.organization_id
        AND p.version=h.published_version
       WHERE h.branch_id=$1 AND h.organization_id=$2`,
      [scope.branchId, scope.organizationId],
    )
  ).rows[0];
  if (!head) throw new CommerceError('NOT_READY');
  if (head.version !== requested) throw new CommerceError('CONFLICT');
  if (!options.mediaEnabled)
    return CatalogMediaMapSchema.parse({ version: head.version, products: {} });
  const payload = CatalogPayloadSchema.parse(head.payload);
  let products: CatalogMediaMap['products'] = {};
  try {
    products = await catalogMediaEntries(db, scope.organizationId, payload);
  } catch (error) {
    // Before cloud migration 047 there is no asset store: every client keeps bundled photos.
    if (!undefinedTable(error)) throw error;
  }
  return CatalogMediaMapSchema.parse({ version: head.version, products });
}

export interface AvailabilityPollOptions {
  /** Upper bound of one long-poll request (the clients time out at 32 s). */
  timeoutMs?: number;
  /** Database re-check interval. */
  intervalMs?: number;
  /** True once the HTTP client went away; the loop then stops re-reading. */
  cancelled?: () => boolean;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
}

/**
 * Long-poll shared by both storefront channels: without `after` it reads once; otherwise it
 * re-reads every second while the signature still equals `after`, for at most 25 s.
 */
export async function pollAvailability<T extends { signature: string }>(
  read: () => Promise<T>,
  after: string | undefined,
  options: AvailabilityPollOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now,
    wait = options.wait ?? sleep,
    deadline = now() + (options.timeoutMs ?? 25_000),
    interval = options.intervalMs ?? 1_000;
  let state = await read();
  while (after && state.signature === after && now() < deadline && !options.cancelled?.()) {
    await wait(interval);
    state = await read();
  }
  return state;
}
