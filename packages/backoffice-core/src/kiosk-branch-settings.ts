import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { kioskBranchSettingsAvailable, readKioskBranchSetting } from '@pickchick/commerce-core';
import { BackofficeError, parse } from './model.js';
import type { KioskPairingOptions } from './kiosk-pairing.js';

/**
 * ADR-0019 «Киоски на этой точке» (owner request 16.11.2026): a branch manager switches kiosks
 * on or off for a point in «Устройства». With KIOSK_MULTI_BRANCH_ENABLED the kiosk API then serves
 * that point, paid on the kiosk's own Kaspi terminal (ADR-0018). The env point is always on and
 * is not switched here. Switching on gives the point its own 'kaspi-pos' payment account
 * (kiosk_branch_terminal_account, migration 081) when it has none.
 */
export const KioskBranchRequest = z.strictObject({
  request_id: z.uuid(),
  enabled: z.boolean(),
  /** The version the manager saw (0: never switched); a stale screen is refused. */
  expected_version: z.int().min(0).max(2_000_000_000),
  reason: z.string().trim().min(3).max(500),
});
export type KioskBranchView = {
  /** The env point of the kiosk API: always on, not switched here. */
  primary: boolean;
  enabled: boolean;
  version: number;
  /** The terminal payment account the point's kiosks use; null when none is ready. */
  payment_account: { id: string; reference: string; enabled: boolean } | null;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function account(db: DatabaseClient, id: string | null | undefined, branch: string) {
  if (!id) return null;
  const row = (
    await db.query<{ id: string; external_reference: string; enabled: boolean }>(
      `SELECT id,external_reference,enabled FROM commerce_provider_accounts
       WHERE id=$1 AND branch_id=$2 AND kind='payment' AND provider='kaspi-pos'`,
      [id, branch],
    )
  ).rows[0];
  return row ? { id: row.id, reference: row.external_reference, enabled: row.enabled } : null;
}

/** The point's kiosk state for the device list; null when multi-point kiosks are off. */
export async function kioskBranchView(
  db: DatabaseClient,
  options: KioskPairingOptions | null,
  organizationId: string,
  branch: string,
): Promise<KioskBranchView | null> {
  if (!options?.multiBranch) return null;
  if (organizationId.toLowerCase() !== options.organizationId.toLowerCase()) return null;
  if (branch.toLowerCase() === options.branchId.toLowerCase())
    return {
      primary: true,
      enabled: true,
      version: 0,
      payment_account: await account(db, options.terminalAccountId, branch),
    };
  if (!(await kioskBranchSettingsAvailable(db))) return null;
  const setting = await readKioskBranchSetting(db, organizationId, branch);
  return {
    primary: false,
    enabled: setting?.enabled ?? false,
    version: setting?.version ?? 0,
    payment_account: await account(
      db,
      setting?.terminalAccountId ?? options.terminalAccountId,
      branch,
    ),
  };
}

/** Runs inside the caller's transaction after the manager scope check (write). */
export async function setKioskBranch(
  db: DatabaseClient,
  actor: { id: string; organization_id: string },
  branch: string,
  input: unknown,
  options: KioskPairingOptions | null,
) {
  const req = parse(KioskBranchRequest, input);
  if (!options?.multiBranch || !(await kioskBranchSettingsAvailable(db)))
    throw new BackofficeError('SERVICE_UNAVAILABLE', 'KIOSK_MULTI_BRANCH_DISABLED');
  if (actor.organization_id.toLowerCase() !== options.organizationId.toLowerCase())
    throw new BackofficeError('CONFLICT', 'KIOSK_BRANCH_NOT_SERVED');
  if (branch.toLowerCase() === options.branchId.toLowerCase())
    throw new BackofficeError('CONFLICT', 'KIOSK_BRANCH_PRIMARY');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'bo:actor:' + actor.id + ':' + req.request_id,
  ]);
  const hash = digest({ branch, kind: 'kiosk_branch_settings', ...req });
  const previous = (
    await db.query<{ digest: string; result: KioskBranchView }>(
      'SELECT digest,result FROM bo_commands WHERE actor_id=$1 AND request_id=$2',
      [actor.id, req.request_id],
    )
  ).rows[0];
  if (previous) {
    if (previous.digest !== hash) throw new BackofficeError('CONFLICT');
    return previous.result;
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'kiosk-branch-settings:' + branch.toLowerCase(),
  ]);
  const before = await readKioskBranchSetting(db, actor.organization_id, branch, true);
  if ((before?.version ?? 0) !== req.expected_version)
    throw new BackofficeError('CONFLICT', 'KIOSK_BRANCH_VERSION');
  // The point's own terminal account, created once when kiosks are first switched on.
  const accountId =
    before?.terminalAccountId ??
    (req.enabled
      ? ((
          await db.query<{ id: string | null }>('SELECT kiosk_branch_terminal_account($1,$2) id', [
            actor.organization_id,
            branch,
          ])
        ).rows[0]?.id ?? null)
      : null);
  if (before)
    await db.query(
      `UPDATE kiosk_branch_settings SET enabled=$3,terminal_payment_account_id=$4,updated_by=$5,
        updated_at=clock_timestamp(),version=version+1 WHERE organization_id=$1 AND branch_id=$2`,
      [actor.organization_id, branch, req.enabled, accountId, actor.id],
    );
  else
    await db.query(
      `INSERT INTO kiosk_branch_settings(organization_id,branch_id,enabled,terminal_payment_account_id,updated_by,version)
       VALUES($1,$2,$3,$4,$5,1)`,
      [actor.organization_id, branch, req.enabled, accountId, actor.id],
    );
  const result = JSON.parse(
    JSON.stringify(await kioskBranchView(db, options, actor.organization_id, branch)),
  ) as KioskBranchView;
  await db.query(
    `INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value)
     VALUES($1,$2,$3,$4,$5,'kiosk_branch_settings',$2,$6,$7,$8)`,
    [
      randomUUID(),
      branch,
      actor.organization_id,
      actor.id,
      req.request_id,
      req.reason,
      before
        ? {
            enabled: before.enabled,
            terminal_payment_account_id: before.terminalAccountId,
            version: before.version,
          }
        : null,
      {
        enabled: req.enabled,
        terminal_payment_account_id: accountId,
        version: (before?.version ?? 0) + 1,
      },
    ],
  );
  await db.query(
    'INSERT INTO bo_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
    [actor.id, req.request_id, branch, hash, result],
  );
  return result;
}
