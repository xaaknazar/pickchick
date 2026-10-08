import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CatalogProjectionError,
  projectCatalogMenu,
  publishMenuInTransaction,
  readCatalogMenuDelivery,
  SyncError,
} from '@pickchick/menu-sync';
import { transaction } from '@pickchick/database';
import type { DatabasePool, DatabaseClient } from '@pickchick/database';
import {
  CatalogAdminError,
  CatalogBranchesSchema,
  CatalogCredentialSchema,
  CatalogManagerInputSchema,
  CatalogPayloadSchema,
  CatalogPublishSchema,
  CatalogPublicSchema,
  CatalogSaveSchema,
  CatalogSeedSchema,
  CatalogStateSchema,
  parseCatalogInput,
  assertCatalogPublishable,
} from './contracts.js';
import type { CatalogCredential, CatalogPayload, CatalogState } from './contracts.js';
import { authenticateCatalogActor, authorizeCatalog } from './auth.js';
import type { CatalogActor, CatalogBranch } from './auth.js';
import { mockupCatalogDraft } from './seed.js';
import { assertCatalogAssets } from './assets.js';
export * from './contracts.js';
export * from './auth.js';
export * from './assets.js';
export { readCatalogMenuDelivery } from '@pickchick/menu-sync';
export const CATALOG_ADMIN = Symbol('CATALOG_ADMIN');
export const catalogHash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface CatalogAdminOptions {
  enabled: boolean;
  mobileStorefrontBranchId?: string;
  edgePublicationBranchId?: string;
  /** Branch served by the iPad kiosk storefront (publication_support.kiosk). */
  kioskBranchId?: string;
  /** bo_access_grants role check: analyst reads only, manager writes. Off by default. */
  enforceRoles?: boolean;
}
export function catalogAdminOptions(
  env: Readonly<Record<string, string | undefined>> = {},
): CatalogAdminOptions {
  const value = env['CATALOG_ADMIN_ENABLED'] ?? 'false';
  if (!['true', 'false'].includes(value)) throw new Error('CATALOG_ADMIN_CONFIGURATION_INVALID');
  const mobile = env['CATALOG_MOBILE_STOREFRONT_ENABLED'] ?? 'false';
  if (!['true', 'false'].includes(mobile))
    throw new Error('CATALOG_MOBILE_STOREFRONT_CONFIGURATION_INVALID');
  const branchId = env['CUSTOMER_KASPI_BRANCH_ID'];
  if (
    mobile === 'true' &&
    (!z.uuid().safeParse(branchId).success || env['CUSTOMER_KASPI_PILOT_ENABLED'] !== 'true')
  )
    throw new Error('CATALOG_MOBILE_STOREFRONT_CONFIGURATION_INVALID');
  const edge = env['CATALOG_EDGE_PUBLICATION_ENABLED'] ?? 'false';
  const edgeBranch = env['CATALOG_EDGE_PUBLICATION_BRANCH_ID'];
  if (
    !['true', 'false'].includes(edge) ||
    (edge === 'true' && !z.uuid().safeParse(edgeBranch).success)
  )
    throw new Error('CATALOG_EDGE_PUBLICATION_CONFIGURATION_INVALID');
  const roles = env['CATALOG_ACCESS_ROLES_ENABLED'] ?? 'false';
  if (!['true', 'false'].includes(roles))
    throw new Error('CATALOG_ACCESS_ROLES_CONFIGURATION_INVALID');
  // Informational only; kiosk checkout validates its own configuration.
  const kioskBranch =
    env['KIOSK_CHECKOUT_ENABLED'] === 'true' ? env['KIOSK_CHECKOUT_BRANCH_ID'] : undefined;
  return {
    enabled: value === 'true',
    ...(edge === 'true' ? { edgePublicationBranchId: edgeBranch! } : {}),
    ...(mobile === 'true' ? { mobileStorefrontBranchId: branchId! } : {}),
    ...(z.uuid().safeParse(kioskBranch).success ? { kioskBranchId: kioskBranch! } : {}),
    ...(roles === 'true' ? { enforceRoles: true } : {}),
  };
}
type Actor = CatalogActor;
type Branch = CatalogBranch;
interface Head {
  draft_revision: number | null;
  published_version: number | null;
}
interface DraftRow {
  revision: number;
  base_version: number | null;
  payload: CatalogPayload;
  payload_hash: string;
  actor_id: string;
  created_at: Date;
}
interface PublicationRow {
  version: number;
  payload: CatalogPayload;
  actor_id: string;
  published_at: Date;
}
const failure = (...args: ConstructorParameters<typeof CatalogAdminError>) =>
  new CatalogAdminError(...args);
function validId(value: string) {
  return parseCatalogInput(z.uuid(), value);
}
/** Trusted operator function, no public issuance route. Issued token exists only in this return value. */
export async function provisionCatalogManager(
  pool: DatabasePool,
  input: unknown,
): Promise<CatalogCredential> {
  const body = parseCatalogInput(CatalogManagerInputSchema, input);
  return transaction(pool, async (db) => {
    const branches = await db.query(
      'SELECT id FROM branches WHERE organization_id=$1 AND id=ANY($2::uuid[]) FOR KEY SHARE',
      [body.organization_id, body.branch_ids],
    );
    if (branches.rowCount !== body.branch_ids.length) throw failure('FORBIDDEN');
    const actorId = randomUUID(),
      token = randomBytes(32).toString('hex');
    const issued = (
      await db.query<{ issued_at: Date }>(
        'INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,$3,$4) RETURNING issued_at',
        [actorId, body.organization_id, body.name, catalogHash(token)],
      )
    ).rows[0]!.issued_at;
    for (const branch of body.branch_ids)
      await db.query(
        'INSERT INTO catalog_manager_branches(actor_id,organization_id,branch_id) VALUES($1,$2,$3)',
        [actorId, body.organization_id, branch],
      );
    await db.query(
      "INSERT INTO catalog_manager_audit(id,actor_id,action) VALUES($1,$2,'provisioned')",
      [randomUUID(), actorId],
    );
    return CatalogCredentialSchema.parse({
      ...body,
      actor_id: actorId,
      token,
      issued_at: issued.toISOString(),
    });
  });
}
export async function revokeCatalogManager(pool: DatabasePool, actorId: string): Promise<void> {
  validId(actorId);
  await transaction(pool, async (db) => {
    const changed = await db.query(
      'UPDATE catalog_managers SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL RETURNING id',
      [actorId],
    );
    if (changed.rowCount)
      await db.query(
        "INSERT INTO catalog_manager_audit(id,actor_id,action) VALUES($1,$2,'revoked')",
        [randomUUID(), actorId],
      );
  });
}
export class CatalogAdmin {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: CatalogAdminOptions = { enabled: false },
  ) {}
  private actor(db: DatabaseClient, token: string): Promise<Actor> {
    return authenticateCatalogActor(db, token, this.options);
  }
  private async state(db: DatabaseClient, branch: Branch): Promise<CatalogState> {
    const head = (
      await db.query<Head>(
        'SELECT draft_revision,published_version FROM catalog_branch_heads WHERE branch_id=$1',
        [branch.id],
      )
    ).rows[0];
    const draft = head?.draft_revision
      ? (
          await db.query<DraftRow>(
            'SELECT * FROM catalog_draft_versions WHERE branch_id=$1 AND revision=$2',
            [branch.id, head.draft_revision],
          )
        ).rows[0]
      : null;
    const published = head?.published_version
      ? (
          await db.query<PublicationRow>(
            'SELECT * FROM catalog_publications WHERE branch_id=$1 AND version=$2',
            [branch.id, head.published_version],
          )
        ).rows[0]
      : null;
    return CatalogStateSchema.parse({
      publication_support: {
        mobile: this.options.mobileStorefrontBranchId === branch.id,
        pos: this.options.edgePublicationBranchId === branch.id,
        kiosk: this.options.kioskBranchId === branch.id,
      },
      ...(this.options.edgePublicationBranchId === branch.id
        ? {
            edge_delivery: published
              ? await readCatalogMenuDelivery(db, branch.id, published.version)
              : null,
          }
        : {}),
      branch: { id: branch.id, code: branch.code, name: branch.name },
      draft: draft
        ? {
            revision: draft.revision,
            base_version: draft.base_version ?? 0,
            updated_at: draft.created_at.toISOString(),
            updated_by: draft.actor_id,
            payload: draft.payload,
          }
        : null,
      published: published
        ? {
            version: published.version,
            published_at: published.published_at.toISOString(),
            published_by: published.actor_id,
            payload: published.payload,
          }
        : null,
    });
  }
  async branches(token: string) {
    return transaction(this.pool, async (db) => {
      const actor = await this.actor(db, token);
      const rows = (
        await db.query(
          'SELECT b.id,b.code,b.name FROM branches b JOIN catalog_manager_branches s ON s.branch_id=b.id AND s.organization_id=b.organization_id WHERE s.actor_id=$1 AND s.organization_id=$2 ORDER BY b.code,b.id',
          [actor.id, actor.organization_id],
        )
      ).rows;
      return CatalogBranchesSchema.parse({
        actor: { id: actor.id, name: actor.name },
        branches: rows,
      });
    });
  }
  async read(token: string, branchId: string): Promise<CatalogState> {
    return transaction(this.pool, async (db) => {
      const { branch } = await authorizeCatalog(
        db,
        token,
        branchId,
        { write: false },
        this.options,
      );
      return this.state(db, branch);
    });
  }
  async publicCatalog(branchId: string) {
    if (!this.options.enabled) throw failure('SERVICE_UNAVAILABLE');
    validId(branchId);
    return transaction(this.pool, async (db) => {
      const row = (
        await db.query<PublicationRow>(
          'SELECT p.* FROM catalog_branch_heads h JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.version=h.published_version WHERE h.branch_id=$1',
          [branchId],
        )
      ).rows[0];
      if (!row) throw failure('NOT_FOUND');
      return CatalogPublicSchema.parse({
        branch_id: branchId,
        version: row.version,
        published_at: row.published_at.toISOString(),
        payload: row.payload,
      });
    });
  }
  private async command(
    token: string,
    branchId: string,
    kind: 'seed' | 'save' | 'publish',
    input: unknown,
  ): Promise<CatalogState> {
    const body =
      kind === 'seed'
        ? parseCatalogInput(CatalogSeedSchema, input)
        : kind === 'save'
          ? parseCatalogInput(CatalogSaveSchema, input)
          : parseCatalogInput(CatalogPublishSchema, input);
    validId(branchId);
    const hash = catalogHash(JSON.stringify({ branch_id: branchId, kind, body }));
    return transaction(this.pool, async (db) => {
      const { actor, branch } = await authorizeCatalog(
        db,
        token,
        branchId,
        { write: true },
        this.options,
      );
      // A request key is unique for an actor across branches and commands; lock before lookup.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 909001))', [
        `${actor.id}:${body.request_id}`,
      ]);
      const receipt = (
        await db.query<{ request_hash: string; response: unknown }>(
          'SELECT request_hash,response FROM catalog_command_receipts WHERE actor_id=$1 AND request_id=$2',
          [actor.id, body.request_id],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.request_hash !== hash) throw failure('CONFLICT');
        return CatalogStateSchema.parse(receipt.response);
      }
      if (this.options.edgePublicationBranchId === branch.id)
        await db.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [branch.id]);
      await db.query(
        'INSERT INTO catalog_branch_heads(branch_id,organization_id) VALUES($1,$2) ON CONFLICT(branch_id) DO NOTHING',
        [branch.id, branch.organization_id],
      );
      const head = (
        await db.query<Head>(
          'SELECT draft_revision,published_version FROM catalog_branch_heads WHERE branch_id=$1 FOR UPDATE',
          [branch.id],
        )
      ).rows[0]!;
      const before = head.draft_revision
        ? (
            await db.query<DraftRow>(
              'SELECT * FROM catalog_draft_versions WHERE branch_id=$1 AND revision=$2',
              [branch.id, head.draft_revision],
            )
          ).rows[0]
        : undefined;
      if ((head.draft_revision ?? 0) !== body.expected_revision) throw failure('CONFLICT');
      let payload: CatalogPayload,
        publication: number | null = head.published_version;
      if (kind === 'seed') {
        if (before || head.published_version || this.options.mobileStorefrontBranchId === branch.id)
          throw failure('CONFLICT');
        payload = CatalogPayloadSchema.parse(mockupCatalogDraft);
      } else if (kind === 'save') {
        if (!before || !('payload' in body)) throw failure('CONFLICT');
        payload = body.payload;
        await assertCatalogAssets(db, branch.organization_id, payload);
      } else {
        if (
          !before ||
          !('expected_published_version' in body) ||
          (head.published_version ?? 0) !== body.expected_published_version ||
          !before.payload.content_reviewed
        )
          throw failure('CONFLICT');
        payload = CatalogPayloadSchema.parse(before.payload);
        const edgePublication = this.options.edgePublicationBranchId === branch.id;
        assertCatalogPublishable(
          payload,
          !edgePublication && this.options.mobileStorefrontBranchId === branch.id,
        );
        await assertCatalogAssets(db, branch.organization_id, payload);
        publication = (head.published_version ?? 0) + 1;
        await db.query(
          'INSERT INTO catalog_publications(branch_id,organization_id,version,source_revision,payload,payload_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            branch.id,
            branch.organization_id,
            publication,
            before.revision,
            payload,
            before.payload_hash,
            actor.id,
          ],
        );
        if (edgePublication) {
          const device = (
            await db.query<{ id: string }>(
              "SELECT id FROM devices WHERE branch_id=$1 AND kind='edge' AND status='active' FOR SHARE",
              [branch.id],
            )
          ).rows[0];
          if (!device) throw failure('CONFLICT', 'EDGE_DEVICE_INACTIVE');
          // The edge may already serve a newer local menu than cloud history (installed v2).
          const edge = (
            await db.query<{ active_version: number }>(
              'SELECT active_version FROM edge_menu_state WHERE branch_id=$1 AND device_id=$2',
              [branch.id, device.id],
            )
          ).rows[0];
          if (!edge) throw failure('CONFLICT', 'EDGE_MENU_STATE_UNKNOWN');
          const latest = (
            await db.query<{ version: number }>(
              'SELECT GREATEST(COALESCE(max(version),0),$2::int)::int version FROM menu_releases WHERE branch_id=$1',
              [branch.id, edge.active_version],
            )
          ).rows[0]!;
          let menu;
          try {
            menu = projectCatalogMenu(
              payload,
              branch.id,
              latest.version + 1,
              new Date().toISOString(),
            );
          } catch (error) {
            throw error instanceof CatalogProjectionError
              ? failure('CONFLICT', error.code)
              : failure('CONFLICT');
          }
          try {
            await publishMenuInTransaction(db, menu, { floorVersion: edge.active_version });
          } catch (error) {
            if (error instanceof SyncError) throw failure('CONFLICT');
            throw error;
          }
          await db.query(
            'INSERT INTO catalog_menu_deliveries(branch_id,catalog_version,release_id,device_id) VALUES($1,$2,$3,$4)',
            [branch.id, publication, menu.release_id, device.id],
          );
        }
      }
      const revision = (head.draft_revision ?? 0) + 1,
        payloadHash = catalogHash(JSON.stringify(payload));
      await db.query(
        'INSERT INTO catalog_draft_versions(branch_id,organization_id,revision,base_version,payload,payload_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [branch.id, branch.organization_id, revision, publication, payload, payloadHash, actor.id],
      );
      await db.query(
        'UPDATE catalog_branch_heads SET draft_revision=$2,published_version=$3 WHERE branch_id=$1',
        [branch.id, revision, publication],
      );
      await db.query(
        'INSERT INTO catalog_audit(id,branch_id,organization_id,actor_id,action,from_revision,to_revision,published_version,before_hash,after_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          randomUUID(),
          branch.id,
          branch.organization_id,
          actor.id,
          { seed: 'seeded', save: 'saved', publish: 'published' }[kind],
          head.draft_revision ?? 0,
          revision,
          publication,
          before?.payload_hash ?? null,
          payloadHash,
        ],
      );
      const response = await this.state(db, branch);
      await db.query(
        'INSERT INTO catalog_command_receipts(actor_id,request_id,request_hash,response) VALUES($1,$2,$3,$4)',
        [actor.id, body.request_id, hash, response],
      );
      return response;
    });
  }
  seed(token: string, branchId: string, input: unknown) {
    return this.command(token, branchId, 'seed', input);
  }
  save(token: string, branchId: string, input: unknown) {
    return this.command(token, branchId, 'save', input);
  }
  publish(token: string, branchId: string, input: unknown) {
    return this.command(token, branchId, 'publish', input);
  }
}
