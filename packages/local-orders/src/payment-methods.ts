import {
  POS_APPROVAL_TTL_SECONDS,
  POS_PAYMENT_METHOD_POLICY,
  PosConfigSchema,
  PosPaymentMethodSchema,
  SalesChannelSchema,
} from '@pickchick/contracts';
import type { PosConfig, PosFiscalPolicy, PosPaymentMethod } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { authenticateStaff, requirePermission } from './staff.js';
import type { StaffAuth } from './staff.js';
import { posSalesInstalled } from './approvals.js';
import { OrderError } from './errors.js';

/** One operator-managed payment method of the branch (edge schema026 pos_payment_methods). */
export interface PosPaymentMethodRow {
  code: PosPaymentMethod;
  enabled: boolean;
  requires_approval: boolean;
  allow_in_mix: boolean;
  fiscal_policy: PosFiscalPolicy;
}
/** The branch's methods in the contract order (cutover-enums); the runtime only reads them. */
export async function loadPaymentMethods(client: DatabaseClient, branchId: string) {
  const rows = (
    await client.query<PosPaymentMethodRow>(
      'SELECT code,enabled,requires_approval,allow_in_mix,fiscal_policy FROM pos_payment_methods WHERE branch_id=$1',
      [branchId],
    )
  ).rows;
  const byCode = new Map(rows.map((row) => [row.code, row]));
  return PosPaymentMethodSchema.options.flatMap((code) => {
    const row = byCode.get(code);
    return row ? [row] : [];
  });
}

/** Client build a cash desk may report on GET pos/config (schema026 pos_config_fetches). */
const CLIENT_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

/**
 * GET pos/config (contracts 5.1): the service mode, the eight methods with their operator state
 * and pinned policy, the channels (a channel is enabled while one of its methods is), the manual
 * Webkassa mode, the approval TTL and the desk number of this terminal (schema028, else null).
 * Every fetch records this cash desk's last fetch (staff and optional client build), so the
 * operator enables pos_sale only after every desk runs the new POS. 404 on an edge without
 * schema026 (the POS then keeps its unpaid UI).
 */
export async function readPosConfig(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  clientVersion?: string,
): Promise<PosConfig> {
  // A repeated query key arrives as an array: refused like any other malformed build.
  if (
    clientVersion !== undefined &&
    (typeof clientVersion !== 'string' || !CLIENT_VERSION.test(clientVersion))
  )
    throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    if (!(await posSalesInstalled(client))) throw new OrderError('NOT_FOUND');
    const branch = (
      await client.query<{ pos_service_mode: string }>(
        'SELECT pos_service_mode FROM branch_config WHERE id=$1',
        [branchId],
      )
    ).rows[0];
    if (!branch) throw new OrderError('BRANCH_UNAVAILABLE');
    const methods = await loadPaymentMethods(client, branchId);
    const enabled = new Set(methods.filter((method) => method.enabled).map((m) => m.code));
    await client.query(
      `INSERT INTO pos_config_fetches(terminal_id,branch_id,staff_id,client_version) VALUES($1,$2,$3,$4)
       ON CONFLICT(terminal_id) DO UPDATE SET staff_id=EXCLUDED.staff_id,
         client_version=EXCLUDED.client_version,last_fetched_at=clock_timestamp()`,
      [actor.terminal_id, branchId, actor.staff_id, clientVersion ?? null],
    );
    const time = (await client.query<{ time: Date }>('SELECT clock_timestamp() AS time')).rows[0]!
      .time;
    // Schema028 desk number of the session's terminal. The row read through to_jsonb names no
    // column, so the same statement answers null on an edge without 028 (runtime: table SELECT).
    const desk = (
      await client.query<{ desk_number: number | null }>(
        `SELECT to_jsonb(t)->'desk_number' AS desk_number FROM local_terminals t
         WHERE t.id=$1 AND t.branch_id=$2`,
        [actor.terminal_id, branchId],
      )
    ).rows[0];
    return PosConfigSchema.parse({
      mode: branch.pos_service_mode,
      methods: methods.map(({ code, enabled, requires_approval, allow_in_mix, fiscal_policy }) => ({
        code,
        enabled,
        requires_approval,
        allow_in_mix,
        fiscal_policy,
      })),
      channels: SalesChannelSchema.options.map((code) => ({
        code,
        enabled: [...enabled].some((method) =>
          POS_PAYMENT_METHOD_POLICY[method].channels.includes(code),
        ),
      })),
      fiscal_mode: 'manual_webkassa',
      approval_ttl_seconds: POS_APPROVAL_TTL_SECONDS,
      server_time: time.toISOString(),
      desk_number: desk?.desk_number ?? null,
    });
  });
}
