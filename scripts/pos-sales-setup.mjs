import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PosFiscalPolicySchema, PosPaymentMethodSchema } from '@pickchick/contracts';
import { createPool, transaction } from '@pickchick/database';
import { edgeInstallConfig } from './edge-migrate.mjs';

/**
 * Owner-only switch of paid POS sales on the edge (cutover 2026-11, contracts 00 p.1, 2.4, 6.1,
 * 6.2; docs/operations/pos-sales.md). Changes only edge database rows: branch_config.pos_service_mode
 * and pos_payment_methods (enabled, fiscal_policy), and with schema028 the desk number of a cash
 * desk (local_terminals.desk_number; lead decision 07.11 (1), CR pos-7). Every change writes its
 * pos_sales_setting_changes audit row (before/after, reason) first; schema026/028 refuse any change
 * without it. No network: the cloud and the cash desks are judged only by what they recorded in
 * this database.
 *
 *   node scripts/pos-sales-setup.mjs status
 *   node scripts/pos-sales-setup.mjs enable --methods cash,kaspi_terminal,... --reason "..."
 *   node scripts/pos-sales-setup.mjs disable --reason "..."
 *   node scripts/pos-sales-setup.mjs fiscal-policy --method <code> --policy manual_webkassa|not_required --reason "..."
 *   node scripts/pos-sales-setup.mjs desk --terminal <uuid> --number <1..99> --reason "..."
 *   node scripts/pos-sales-setup.mjs desk --terminal <uuid> --clear --reason "..."
 */
export const POS_SALES_MIGRATION = '026_edge_pos_sales.sql';
/** Edge schema028: local_terminals.desk_number and its audit subject 'desk_number'. */
export const DESK_NUMBER_MIGRATION = '028_edge_pos_desk_number.sql';
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
  DESK_NOT_INSTALLED:
    'На сервере точки нет миграции 028 (номер кассы) - сначала обновление базы из папки поставки RC-edge',
  TERMINAL_UNKNOWN:
    'Терминала --terminal нет на этой точке: возьмите terminalId из config.json кассы',
  TERMINAL_INACTIVE: 'Терминал выключен (active = false): номер кассы ему не ставится',
  TERMINAL_NOT_DESK: 'Это кухонный экран или табло (доступ устройств), а не касса',
  DESK_NUMBER_TAKEN:
    'Этот номер уже у другой активной кассы точки: сначала снимите его там (desk --clear)',
};
/** What `desk` reports when it changed nothing (a rerun) and when it wrote the number. */
const DESK_RESULTS = {
  set: 'Номер кассы записан',
  cleared: 'Номер кассы снят',
  same: 'Ничего не изменено: у кассы уже этот номер',
  none: 'Ничего не изменено: у кассы нет номера',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

/**
 * argv after the script name -> {command, ...options}; each option exactly once. `desk` takes
 * --terminal and --reason, and exactly one of --number <1..99> or the bare flag --clear.
 */
export function parsePosSalesSetupArgs(argv) {
  const [command, ...rest] = argv;
  const allowed = {
    status: [],
    enable: ['methods', 'reason'],
    disable: ['reason'],
    'fiscal-policy': ['method', 'policy', 'reason'],
    desk: ['terminal', 'number', 'reason'],
  }[command];
  if (!allowed) throw new PosSalesSetupError('INVALID_ARGUMENTS');
  const flags = command === 'desk' ? ['clear'] : [];
  const options = {};
  for (let i = 0; i < rest.length;) {
    const name = /^--([a-z]+)$/.exec(rest[i] ?? '')?.[1];
    if (name && flags.includes(name) && !(name in options)) {
      options[name] = true;
      i += 1;
      continue;
    }
    if (!name || !allowed.includes(name) || name in options || typeof rest[i + 1] !== 'string')
      throw new PosSalesSetupError('INVALID_ARGUMENTS');
    options[name] = rest[i + 1];
    i += 2;
  }
  const required = command === 'desk' ? ['terminal', 'reason'] : allowed;
  if (
    required.some((name) => !(name in options)) ||
    (command === 'desk' && 'number' in options === 'clear' in options)
  )
    throw new PosSalesSetupError('INVALID_ARGUMENTS');
  if (command === 'status') return { command };
  const reason = reasonOf(options.reason);
  if (command === 'disable') return { command, reason };
  if (command === 'desk') {
    const terminal = options.terminal.toLowerCase();
    if (!UUID.test(terminal) || ('number' in options && !/^[1-9][0-9]?$/.test(options.number)))
      throw new PosSalesSetupError('INVALID_ARGUMENTS');
    const desk = 'number' in options ? Number(options.number) : null;
    return { command, terminal_id: terminal, desk_number: desk, reason };
  }
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
  // Schema028 (desk numbers) is optional on top of 026: without it every desk shows null.
  const deskNumbers = (
    await client.query(
      `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE scope='edge' AND version=$1)
         AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='local_terminals'::regclass
           AND attname='desk_number' AND NOT attisdropped) AS installed`,
      [DESK_NUMBER_MIGRATION],
    )
  ).rows[0].installed;
  const desks = (
    await client.query(
      `SELECT t.id AS terminal_id,${deskNumbers ? 't.desk_number' : 'NULL::smallint AS desk_number'},
         f.last_fetched_at,f.client_version FROM local_terminals t
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
    deskNumbers,
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
        desk_number: desk.desk_number,
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

/**
 * Schema028: the number of one cash desk (1..99), or none (`desk_number: null`, --clear). Any
 * time, shifts open or not: the number is only what the cash desk shows. Refused for a terminal
 * of another branch or none, an inactive one, a kitchen screen or display (device access), and a
 * number another active desk of the branch holds. The same number again changes nothing.
 */
export async function setDeskNumber(pool, branchId, { terminal_id, desk_number, reason }) {
  return transaction(pool, async (client) => {
    const state = await readState(client, branchId, true);
    if (!state.deskNumbers) throw new PosSalesSetupError('DESK_NOT_INSTALLED');
    const owner = (
      await client.query(
        "SELECT pg_get_userbyid(relowner)=current_user AS owner FROM pg_class WHERE oid='local_terminals'::regclass",
      )
    ).rows[0].owner;
    if (owner !== true) throw new PosSalesSetupError('NOT_OWNER');
    const terminal = (
      await client.query(
        `SELECT t.id::text AS id,t.active,t.device_access_managed,t.desk_number,
           EXISTS(SELECT 1 FROM terminal_access_registry r WHERE r.terminal_id=t.id) AS registered
         FROM local_terminals t WHERE t.id=$1 AND t.branch_id=$2 FOR UPDATE OF t`,
        [terminal_id, branchId],
      )
    ).rows[0];
    if (!terminal) throw new PosSalesSetupError('TERMINAL_UNKNOWN', { terminal_id });
    if (!terminal.active) throw new PosSalesSetupError('TERMINAL_INACTIVE', { terminal_id });
    if (terminal.device_access_managed || terminal.registered)
      throw new PosSalesSetupError('TERMINAL_NOT_DESK', { terminal_id });
    const desk = { terminal_id: terminal.id, desk_number };
    if (terminal.desk_number === desk_number)
      return {
        ...state.view,
        desk,
        changes: [],
        message: DESK_RESULTS[desk_number === null ? 'none' : 'same'],
      };
    const holder =
      desk_number === null
        ? undefined
        : (
            await client.query(
              `SELECT id::text AS terminal_id FROM local_terminals
               WHERE branch_id=$1 AND active AND desk_number=$2 AND id<>$3`,
              [branchId, desk_number, terminal.id],
            )
          ).rows[0];
    if (holder) throw new PosSalesSetupError('DESK_NUMBER_TAKEN', { desk_number, ...holder });
    const change = await audited(
      client,
      branchId,
      'desk_number',
      { terminal_id: terminal.id, desk_number: terminal.desk_number },
      desk,
      reason,
      () =>
        client
          .query('UPDATE local_terminals SET desk_number=$3 WHERE id=$1 AND branch_id=$2', [
            terminal.id,
            branchId,
            desk_number,
          ])
          .catch((error) => {
            // The partial unique index is the last word on a number another desk got meanwhile.
            if (
              error?.code === '23505' &&
              error.constraint === 'local_terminals_active_desk_number'
            )
              throw new PosSalesSetupError('DESK_NUMBER_TAKEN', { desk_number });
            throw error;
          }),
    );
    return {
      ...(await readState(client, branchId)).view,
      desk,
      changes: [change],
      message: DESK_RESULTS[desk_number === null ? 'cleared' : 'set'],
    };
  });
}

export async function runPosSalesSetup(pool, branchId, args) {
  if (args.command === 'status') return posSalesStatus(pool, branchId);
  if (args.command === 'enable') return enablePosSales(pool, branchId, args);
  if (args.command === 'disable') return disablePosSales(pool, branchId, args);
  if (args.command === 'desk') return setDeskNumber(pool, branchId, args);
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
