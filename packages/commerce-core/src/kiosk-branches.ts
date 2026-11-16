import type { DatabaseClient, DatabasePool } from '@pickchick/database';

/**
 * ADR-0019: kiosks on more points. With KIOSK_MULTI_BRANCH_ENABLED=true the kiosk API serves the
 * env point (KIOSK_CHECKOUT_BRANCH_ID, unchanged) and every point of the same organization whose
 * manager switched «Киоски на этой точке» on (kiosk_branch_settings.enabled, migration 081).
 * Those points pay on the kiosk's own Kaspi terminal only (ADR-0018): no QR, no phone invoice.
 * Off (the default), nothing here is read and the API answers exactly as before.
 */
export function kioskMultiBranchEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.KIOSK_MULTI_BRANCH_ENABLED;
  if (flag === undefined || flag === 'false') return false;
  if (flag !== 'true') throw new Error('INVALID_KIOSK_MULTI_BRANCH_FLAG');
  return true;
}

export type KioskBranchSetting = {
  enabled: boolean;
  /** The point's 'kaspi-pos' payment account; null means the env terminal account. */
  terminalAccountId: string | null;
  version: number;
};
type Db = DatabasePool | DatabaseClient;

/** 081 is applied and readable by this role (the grants script resets it with the flag). */
export async function kioskBranchSettingsAvailable(db: Db) {
  return !!(
    await db.query<{ ok: boolean }>(
      `SELECT CASE WHEN to_regclass('kiosk_branch_settings') IS NULL THEN false
        ELSE has_table_privilege('kiosk_branch_settings','SELECT') END ok`,
    )
  ).rows[0]?.ok;
}

/** The point's setting, or null (no row, or 081 unreadable: the point is simply not served). */
export async function readKioskBranchSetting(
  db: Db,
  organizationId: string,
  branchId: string,
  lock = false,
): Promise<KioskBranchSetting | null> {
  if (!(await kioskBranchSettingsAvailable(db))) return null;
  const row = (
    await db.query<{
      enabled: boolean;
      terminal_payment_account_id: string | null;
      version: number;
    }>(
      `SELECT enabled,terminal_payment_account_id,version FROM kiosk_branch_settings
       WHERE organization_id=$1 AND branch_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [organizationId.toLowerCase(), branchId.toLowerCase()],
    )
  ).rows[0];
  return row
    ? {
        enabled: row.enabled,
        terminalAccountId: row.terminal_payment_account_id,
        version: row.version,
      }
    : null;
}
