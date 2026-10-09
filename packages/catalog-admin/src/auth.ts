import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { CatalogAdminError, parseCatalogInput } from './contracts.js';

export interface CatalogActor {
  id: string;
  organization_id: string;
  name: string;
}
export interface CatalogBranch {
  id: string;
  organization_id: string;
  code: string;
  name: string;
}
export type CatalogRole = 'manager' | 'analyst';
export interface CatalogAuthorization {
  actor: CatalogActor;
  branch: CatalogBranch;
  /** Null only when role enforcement is off (legacy token-scope access). */
  role: CatalogRole | null;
}
export interface CatalogAuthOptions {
  enabled: boolean;
  /** Require a bo_access_grants role per branch: manager may write, analyst may only read. */
  enforceRoles?: boolean;
}

const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Token must be an unrevoked catalog credential. Locks the credential for the transaction. */
export async function authenticateCatalogActor(
  db: DatabaseClient,
  token: string,
  options: CatalogAuthOptions,
): Promise<CatalogActor> {
  if (!options.enabled) throw new CatalogAdminError('SERVICE_UNAVAILABLE');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new CatalogAdminError('UNAUTHORIZED');
  const actor = (
    await db.query<CatalogActor>(
      'SELECT id,organization_id,name FROM catalog_managers WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE',
      [tokenHash(token)],
    )
  ).rows[0];
  if (!actor) throw new CatalogAdminError('UNAUTHORIZED');
  return actor;
}

/**
 * Branch scope plus, when enforced, the same bo_access_grants role convention as the
 * back-office core: no grant is FORBIDDEN, and writes require role='manager'.
 */
export async function authorizeCatalogBranch(
  db: DatabaseClient,
  actor: CatalogActor,
  branchId: string,
  access: { write: boolean },
  options: CatalogAuthOptions,
): Promise<CatalogAuthorization> {
  parseCatalogInput(z.uuid(), branchId);
  const branch = (
    await db.query<CatalogBranch>(
      'SELECT b.id,b.organization_id,b.code,b.name FROM branches b JOIN catalog_manager_branches s ON s.branch_id=b.id AND s.organization_id=b.organization_id WHERE b.id=$1 AND s.actor_id=$2 AND b.organization_id=$3 FOR SHARE OF s',
      [branchId, actor.id, actor.organization_id],
    )
  ).rows[0];
  if (!branch) throw new CatalogAdminError('FORBIDDEN');
  if (!options.enforceRoles) return { actor, branch, role: null };
  const grant = (
    await db.query<{ role: CatalogRole }>(
      'SELECT g.role FROM bo_access_grants g JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id WHERE g.actor_id=$1 AND g.branch_id=$2 AND s.organization_id=$3 FOR SHARE OF g,s',
      [actor.id, branch.id, actor.organization_id],
    )
  ).rows[0];
  if (!grant || (access.write && grant.role !== 'manager'))
    throw new CatalogAdminError('FORBIDDEN');
  return { actor, branch, role: grant.role };
}

export async function authorizeCatalog(
  db: DatabaseClient,
  token: string,
  branchId: string,
  access: { write: boolean },
  options: CatalogAuthOptions,
): Promise<CatalogAuthorization> {
  const actor = await authenticateCatalogActor(db, token, options);
  return authorizeCatalogBranch(db, actor, branchId, access, options);
}
