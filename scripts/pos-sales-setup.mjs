import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PosFiscalPolicySchema, PosPaymentMethodSchema } from '@pickchick/contracts';
import { createPool, transaction } from '@pickchick/database';
import { edgeInstallConfig } from './edge-migrate.mjs';

/**
 * Owner-only switch of paid POS sales on the edge (cutover 2026-11, contracts 00 p.1, 2.4, 6.1,
 * 6.2; docs/operations/pos-sales.md). Changes only edge database rows: branch_config.pos_service_mode
 * and pos_payment_methods (enabled, fiscal_policy). Every change writes its pos_sales_setting_changes
 * audit row (before/after, reason) first; schema026 refuses any change without it. No network:
 * the cloud and the cash desks are judged only by what they recorded in this database.
 *
 *   node scripts/pos-sales-setup.mjs status
 *   node scripts/pos-sales-setup.mjs enable --methods cash,kaspi_terminal,... --reason "..."
 *   node scripts/pos-sales-setup.mjs disable --reason "..."
 *   node scripts/pos-sales-setup.mjs fiscal-policy --method <code> --policy manual_webkassa|not_required --reason "..."
 */
export const POS_SALES_MIGRATION = '026_edge_pos_sales.sql';
/** The posSales sender records every answered probe or batch; older than this is unsupported. */
export const CLOUD_SUPPORT_HOURS = 24;
/** A cash desk: a terminal with a cash shift or a cashier/shift manager login in this window. */
export const DESK_ACTIVITY_DAYS = 30;
export const POS_METHODS = PosPaymentMethodSchema.options;
const POLICIES = PosFiscalPolicySchema.options;

const MESSAGES = {
  INVALID_ARGUMENTS: 'Неверные аргументы: см. docs/operations/pos-sales.md',
  NOT_INSTALLED: 'На сервере точки нет миграции 026 - сначала pos-sales-upgrade-db',
  NOT_OWNER: 'Нужен владелец базы edge (owner-подключение)',
  BRANCH_MISSING: 'Точка EDGE_BRANCH_ID не найдена в branch_config',
  PRECONDITIONS: 'Включать нельзя: не выполнены предусловия (blockers)',
  SALES_SHIFT_OPEN: 'Выключать нельзя: открыта смена продаж - закройте смены (Z) на всех кассах',
};
const BLOCKERS = {
  OPEN_SHIFTS: 'Открыты кассовые смены - закройте их на всех кассах',
  CLOUD_NOT_SUPPORTED: `Облако не подтвердило приём продаж (posSales) за последние ${CLOUD_SUPPORT_HOURS} ч`,
  MENU_NOT_APPLIED: 'На точке нет применённого меню',
  NO_CASH_DESKS: 'Не найдено ни одной кассы (нет смен и входов кассиров за 30 дней)',
  DESKS_NOT_UPDATED:
    'Не все кассы получили новую настройку GET pos/config - обновите и запустите их',
};

export class PosSalesSetupError extends Error {
  constructor(code, details = {}) {
    super(MESSAGES[code] ?? code);
    this.code = code;
    this.details = details;
  }
}

const reasonOf = (value) => {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 3 || reason.length > 300) throw new PosSalesSetupError('INVALID_ARGUMENTS');
  return reason;
};

/** argv after the script name -> {command, ...options}; each option exactly once. */
export function parsePosSalesSetupArgs(argv) {
  const [command, ...rest] = argv;
  const allowed = {
    status: [],
    enable: ['methods', 'reason'],
    disable: ['reason'],
    'fiscal-policy': ['method', 'policy', 'reason'],
  }[command];
  if (!allowed) throw new PosSalesSetupError('INVALID_ARGUMENTS');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = /^--([a-z]+)$/.exec(rest[i] ?? '')?.[1];
    if (!name || !allowed.includes(name) || name in options || typeof rest[i + 1] !== 'string')
      throw new PosSalesSetupError('INVALID_ARGUMENTS');
    options[name] = rest[i + 1];
  }
  if (allowed.some((name) => !(name in options))) throw new PosSalesSetupError('INVALID_ARGUMENTS');
  if (command === 'status') return { command };
  const reason = reasonOf(options.reason);
  if (command === 'disable') return { command, reason };
  if (command === 'enable') {
    const methods = options.methods.split(',').map((code) => code.trim());
    if (
      !methods.length ||
      new Set(methods).size !== methods.length ||
      methods.some((code) => !POS_METHODS.includes(code))
    )
      throw new PosSalesSetupError('INVALID_ARGUMENTS');
    return { command, methods: POS_METHODS.filter((code) => methods.includes(code)), reason };
  }
  if (!POS_METHODS.includes(options.method) || !POLICIES.includes(options.policy))
    throw new PosSalesSetupError('INVALID_ARGUMENTS');
  return { command, method: options.method, policy: options.policy, reason };
}

async function requireInstalled(client, branchId, lock) {
  const ready = (
    await client.query(
      `SELECT to_regclass('pos_payment_methods') IS NOT NULL AND to_regclass('pos_sales_setting_changes') IS NOT NULL
         AND EXISTS(SELECT 1 FROM schema_migrations WHERE scope='edge' AND version=$1) AS installed`,
      [POS_SALES_MIGRATION],
    )
  ).rows[0].installed;
  if (!ready) throw new PosSalesSetupError('NOT_INSTALLED');
  const owner = (
    await client.query(
      `SELECT bool_and(pg_get_userbyid(relowner)=current_user) AS owner FROM pg_class
       WHERE oid IN ('pos_payment_methods'::regclass,'pos_sales_setting_changes'::regclass)`,
    )
  ).rows[0].owner;
  if (owner !== true) throw new PosSalesSetupError('NOT_OWNER');
  // The same branch lock as every cashier command: no shift opens while this runs.
  const branch = (
    await client.query(
      `SELECT id,pos_service_mode,ordering_enabled FROM branch_config WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [branchId],
    )
  ).rows[0];
  if (!branch) throw new PosSalesSetupError('BRANCH_MISSING');
  return branch;
}

async function readState(client, branchId, lock = false) {
  const branch = await requireInstalled(client, branchId, lock);
  const methods = new Map(
    (
      await client.query(
        `SELECT code,enabled,fiscal_policy FROM pos_payment_methods WHERE branch_id=$1${lock ? ' FOR UPDATE' : ''}`,
        [branchId],
      )
    ).rows.map((row) => [row.code, row]),
  );
  const shifts = (
    await client.query(
      `SELECT count(*)::int AS open,count(*) FILTER(WHERE sales_mode)::int AS sales
       FROM local_cash_shifts WHERE branch_id=$1 AND state='open'`,
      [branchId],
    )
  ).rows[0];
  const sync = (
    await client.query(
      `SELECT last_supported_at,last_error,
         last_supported_at>clock_timestamp()-make_interval(hours=>$2) AS supported
       FROM pos_sale_sync_state WHERE branch_id=$1`,
      [branchId, CLOUD_SUPPORT_HOURS],
    )
  ).rows[0];
  const menuRow = (
    await client.query(
      `SELECT a.release_id,s.version,s.applied_at,s.payload->'items' AS items FROM active_menu a
       JOIN menu_snapshots s ON s.id=a.release_id AND s.branch_id=a.branch_id WHERE a.branch_id=$1`,
      [branchId],
    )
  ).rows[0];
  const items = Array.isArray(menuRow?.items) ? menuRow.items : [];
  const priced = (channel) =>
    items.filter((item) => typeof item?.aggregator_prices_minor?.[channel] === 'string').length;
  // Cash desks: active terminals outside device access (kitchen screens and the display are
  // paired there) that held a cash shift or a cashier/shift manager login lately.
  const managed = (
    await client.query("SELECT to_regclass('terminal_access_registry') IS NOT NULL AS ready")
  ).rows[0].ready;
  const desks = (
    await client.query(
      `SELECT t.id AS terminal_id,f.last_fetched_at,f.client_version FROM local_terminals t
       LEFT JOIN pos_config_fetches f ON f.terminal_id=t.id AND f.branch_id=t.branch_id
       WHERE t.branch_id=$1 AND t.active AND NOT t.device_access_managed
         ${managed ? 'AND NOT EXISTS(SELECT 1 FROM terminal_access_registry r WHERE r.terminal_id=t.id)' : ''}
         AND (EXISTS(SELECT 1 FROM local_cash_shifts c WHERE c.terminal_id=t.id AND c.branch_id=t.branch_id
                AND (c.state='open' OR c.opened_at>clock_timestamp()-make_interval(days=>$2)))
           OR EXISTS(SELECT 1 FROM staff_sessions s JOIN local_staff p ON p.id=s.staff_id AND p.branch_id=s.branch_id
                WHERE s.terminal_id=t.id AND s.branch_id=t.branch_id AND p.active
                  AND p.role IN ('cashier','shift_manager')
                  AND s.expires_at>clock_timestamp()-make_interval(days=>$2)))
       ORDER BY t.id`,
      [branchId, DESK_ACTIVITY_DAYS],
    )
  ).rows;
  const outbox = (
    await client.query(
      `SELECT count(*) FILTER(WHERE acknowledged_at IS NULL)::int AS pending,
         min(occurred_at) FILTER(WHERE acknowledged_at IS NULL) AS oldest_pending_at,
         count(*) FILTER(WHERE acknowledged_at IS NULL AND last_error IS NOT NULL)::int AS failing
       FROM pos_sale_outbox WHERE branch_id=$1`,
      [branchId],
    )
  ).rows[0];
  const changes = (
    await client.query(
      `SELECT subject,before,after,actor,reason,recorded_at FROM pos_sales_setting_changes
       WHERE branch_id=$1 ORDER BY change_sequence DESC LIMIT 10`,
      [branchId],
    )
  ).rows;
  const blockers = [];
  if (shifts.open > 0) blockers.push('OPEN_SHIFTS');
  if (sync?.supported !== true) blockers.push('CLOUD_NOT_SUPPORTED');
  if (!menuRow) blockers.push('MENU_NOT_APPLIED');
  if (!desks.length) blockers.push('NO_CASH_DESKS');
  else if (desks.some((desk) => desk.last_fetched_at === null)) blockers.push('DESKS_NOT_UPDATED');
  return {
    branch,
    methods,
    view: {
      branch_id: branchId,
      mode: branch.pos_service_mode,
      ordering_enabled: branch.ordering_enabled,
      methods: POS_METHODS.flatMap((code) => {
        const row = methods.get(code);
        return row ? [{ code, enabled: row.enabled, fiscal_policy: row.fiscal_policy }] : [];
      }),
      open_shifts: shifts.open,
      open_sales_shifts: shifts.sales,
      cloud: {
        supported: sync?.supported === true,
        last_supported_at: sync?.last_supported_at?.toISOString() ?? null,
        last_error: sync?.last_error ?? null,
      },
      menu: menuRow
        ? {
            release_id: menuRow.release_id,
            version: menuRow.version,
            applied_at: menuRow.applied_at.toISOString(),
            items: items.length,
            yandex_eda_prices: priced('yandex_eda'),
            glovo_prices: priced('glovo'),
          }
        : null,
      cash_desks: desks.map((desk) => ({
        terminal_id: desk.terminal_id,
        config_fetched: desk.last_fetched_at !== null,
        last_fetched_at: desk.last_fetched_at?.toISOString() ?? null,
        client_version: desk.client_version ?? null,
      })),
      pos_sales_outbox: {
        pending: outbox.pending,
        failing: outbox.failing,
        oldest_pending_at: outbox.oldest_pending_at?.toISOString() ?? null,
      },
      blockers: blockers.map((code) => ({ code, message: BLOCKERS[code] })),
      ready_to_enable: blockers.length === 0,
      recent_changes: changes.map((row) => ({
        ...row,
        recorded_at: row.recorded_at.toISOString(),
      })),
    },
  };
}

/** The audit row comes first; schema026 checks the UPDATE against it. */
async function audited(client, branchId, subject, before, after, reason, update) {
  await client.query(
    `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
     VALUES($1,$2,$3,$4,$5,'operator',$6)`,
    [randomUUID(), branchId, subject, before, after, reason],
  );
  await update();
  return { subject, before, after };
}
async function setMode(client, branchId, from, to, reason) {
  return audited(
    client,
    branchId,
    'pos_service_mode',
    { pos_service_mode: from },
    { pos_service_mode: to },
    reason,
    () => client.query('UPDATE branch_config SET pos_service_mode=$2 WHERE id=$1', [branchId, to]),
  );
}
async function setMethod(client, branchId, row, change, reason) {
  const before = { enabled: row.enabled, fiscal_policy: row.fiscal_policy };
  const after = { ...before, ...change };
  if (before.enabled === after.enabled && before.fiscal_policy === after.fiscal_policy) return null;
  return audited(client, branchId, row.code, before, after, reason, () =>
    client.query(
      'UPDATE pos_payment_methods SET enabled=$3,fiscal_policy=$4 WHERE branch_id=$1 AND code=$2',
      [branchId, row.code, after.enabled, after.fiscal_policy],
    ),
  );
}

export async function posSalesStatus(pool, branchId) {
  return transaction(pool, async (client) => (await readState(client, branchId)).view);
}

/**
 * pos_sale with exactly the named methods on (the others off). Refused unless every cash shift
 * is closed, the cloud answered posSales within 24 h, a menu is applied and every cash desk
 * fetched the new GET pos/config. Rerunning with the same methods changes nothing.
 */
export async function enablePosSales(pool, branchId, { methods, reason }) {
  return transaction(pool, async (client) => {
    const state = await readState(client, branchId, true);
    if (state.view.blockers.length)
      throw new PosSalesSetupError('PRECONDITIONS', {
        blockers: state.view.blockers,
        cash_desks: state.view.cash_desks.filter((desk) => !desk.config_fetched),
      });
    const changes = [];
    if (state.branch.pos_service_mode !== 'pos_sale')
      changes.push(
        await setMode(client, branchId, state.branch.pos_service_mode, 'pos_sale', reason),
      );
    for (const code of POS_METHODS) {
      const row = state.methods.get(code);
      if (!row) throw new PosSalesSetupError('NOT_INSTALLED');
      const change = await setMethod(
        client,
        branchId,
        row,
        { enabled: methods.includes(code) },
        reason,
      );
      if (change) changes.push(change);
    }
    return { ...(await readState(client, branchId)).view, changes };
  });
}

/**
 * Back to the mode the branch had before its last switch into pos_sale (unpaid_service when
 * unknown), every method off. Refused while a shift is open in pos_sale mode (a sales shift).
 */
export async function disablePosSales(pool, branchId, { reason }) {
  return transaction(pool, async (client) => {
    const state = await readState(client, branchId, true);
    const changes = [];
    if (state.branch.pos_service_mode === 'pos_sale') {
      if (state.view.open_shifts > 0)
        throw new PosSalesSetupError('SALES_SHIFT_OPEN', {
          open_shifts: state.view.open_shifts,
          open_sales_shifts: state.view.open_sales_shifts,
        });
      const previous = (
        await client.query(
          `SELECT before->>'pos_service_mode' AS mode FROM pos_sales_setting_changes
           WHERE branch_id=$1 AND subject='pos_service_mode' AND after->>'pos_service_mode'='pos_sale'
           ORDER BY change_sequence DESC LIMIT 1`,
          [branchId],
        )
      ).rows[0]?.mode;
      const target = ['payment_required', 'unpaid_service'].includes(previous)
        ? previous
        : 'unpaid_service';
      changes.push(await setMode(client, branchId, 'pos_sale', target, reason));
    }
    for (const code of POS_METHODS) {
      const row = state.methods.get(code);
      const change = row && (await setMethod(client, branchId, row, { enabled: false }, reason));
      if (change) changes.push(change);
    }
    return { ...(await readState(client, branchId)).view, changes };
  });
}

/** The receipt policy of one method (the accountant's decision, contracts 00 p.1). New sales
 * only: receipts already written keep their state. */
export async function setPosFiscalPolicy(pool, branchId, { method, policy, reason }) {
  return transaction(pool, async (client) => {
    const state = await readState(client, branchId, true);
    const row = state.methods.get(method);
    if (!row) throw new PosSalesSetupError('NOT_INSTALLED');
    const change = await setMethod(client, branchId, row, { fiscal_policy: policy }, reason);
    return { ...(await readState(client, branchId)).view, changes: change ? [change] : [] };
  });
}

export async function runPosSalesSetup(pool, branchId, args) {
  if (args.command === 'status') return posSalesStatus(pool, branchId);
  if (args.command === 'enable') return enablePosSales(pool, branchId, args);
  if (args.command === 'disable') return disablePosSales(pool, branchId, args);
  return setPosFiscalPolicy(pool, branchId, args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool;
  let command = 'unknown';
  try {
    const args = parsePosSalesSetupArgs(process.argv.slice(2));
    command = args.command;
    const config = edgeInstallConfig(process.env);
    pool = createPool(config.databaseUrl, 1);
    const result = await runPosSalesSetup(pool, config.branchId, args);
    console.log(
      JSON.stringify({ event: `pos_sales_${command.replace('-', '_')}`, ...result }, null, 2),
    );
  } catch (error) {
    if (error instanceof PosSalesSetupError)
      console.error(
        JSON.stringify(
          {
            event: 'pos_sales_setup_refused',
            command,
            code: error.code,
            message: error.message,
            ...error.details,
          },
          null,
          2,
        ),
      );
    // Anything else (connection, configuration) stays opaque: no URL or credential is printed.
    else console.error(JSON.stringify({ event: 'pos_sales_setup_failed', command }));
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
