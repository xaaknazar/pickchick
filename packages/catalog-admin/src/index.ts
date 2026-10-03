import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
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
import { mockupCatalogDraft } from './seed.js';
export * from './contracts.js';
export const CATALOG_ADMIN = Symbol('CATALOG_ADMIN');
export const catalogHash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface CatalogAdminOptions {
  enabled: boolean;
  mobileStorefrontBranchId?: string;
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
  return {
    enabled: value === 'true',
    ...(mobile === 'true' ? { mobileStorefrontBranchId: branchId! } : {}),
  };
}
interface Actor {
  id: string;
  organization_id: string;
  name: string;
}
interface Branch {
  id: string;
  organization_id: string;
  code: string;
  name: string;
}
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
const failure = (code: ConstructorParameters<typeof CatalogAdminError>[0]) =>
  new CatalogAdminError(code);
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
  private async actor(db: DatabaseClient, token: string): Promise<Actor> {
    if (!this.options.enabled) throw failure('SERVICE_UNAVAILABLE');
    if (!/^[a-f0-9]{64}$/.test(token)) throw failure('UNAUTHORIZED');
    const actor = (
      await db.query<Actor>(
        'SELECT id,organization_id,name FROM catalog_managers WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE',
        [catalogHash(token)],
      )
    ).rows[0];
    if (!actor) throw failure('UNAUTHORIZED');
    return actor;
  }
  private async branch(db: DatabaseClient, actor: Actor, id: string): Promise<Branch> {
    validId(id);
    const row = (
      await db.query<Branch>(
        'SELECT b.id,b.organization_id,b.code,b.name FROM branches b JOIN catalog_manager_branches s ON s.branch_id=b.id AND s.organization_id=b.organization_id WHERE b.id=$1 AND s.actor_id=$2 AND b.organization_id=$3 FOR SHARE OF s',
        [id, actor.id, actor.organization_id],
      )
    ).rows[0];
    if (!row) throw failure('FORBIDDEN');
    return row;
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
        pos: false,
        kiosk: false,
      },
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
    return transaction(this.pool, async (db) =>
      this.state(db, await this.branch(db, await this.actor(db, token), branchId)),
    );
  }
  async publicCatalog(branchId: string) {
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
      const actor = await this.actor(db, token),
        branch = await this.branch(db, actor, branchId);
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
      } else {
        if (
          !before ||
          !('expected_published_version' in body) ||
          (head.published_version ?? 0) !== body.expected_published_version ||
          !before.payload.content_reviewed
        )
          throw failure('CONFLICT');
        payload = CatalogPayloadSchema.parse(before.payload);
        assertCatalogPublishable(payload, this.options.mobileStorefrontBranchId === branch.id);
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
