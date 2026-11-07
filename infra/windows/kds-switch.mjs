import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KDS_FUNCTION_KIND,
  KDS_FUNCTION_UNITS,
  KdsFunctionSchema,
  KdsLayoutSchema,
  KdsUnitSchema,
  UuidSchema,
} from '@pickchick/contracts';
import { createPool, transaction } from '@pickchick/database';
import {
  KDS_STATIONS,
  digest,
  kdsStationId,
  provisionKdsStations,
} from '@pickchick/edge-fulfillment';
import { edgeInstallConfig } from '../../scripts/edge-migrate.mjs';
import { RUNTIME_PRIVILEGES, WORKER_PRIVILEGES } from './kds-grants.mjs';

/**
 * Owner tool of the edge KDS layout (cutover 19.11.2026, lane kds; contracts sections 5.4, 6).
 * Runs on the point server with the protected owner environment, without WAN:
 *
 *   node --env-file=<owner.env> infra/windows/kds-switch.mjs status
 *   ... layout-build --tsv <chef.tsv> [--terminals <screens.tsv>] --out <layout.json>
 *   ... layout-apply --file <layout.json> --reason "<3-300>"
 *   ... enable --reason "<3-300>"     (new orders get KDS tasks; needs the runtime and worker rights)
 *   ... disable --reason "<3-300>"    (new orders go to the old stations again)
 *   ... provision --reason "<3-300>"  (the six stations to the `kitchen` login enrolled after 027)
 *
 * Chef TSV columns: product_slug, function, unit, count (unit and count both empty or both set).
 * Screens TSV columns: function, terminal_id. Every change of kds_settings is a new version with
 * its kds_setting_changes audit row in the same transaction (the schema enforces both).
 */
export const KDS_SWITCH_COMMANDS = Object.freeze([
  'status',
  'layout-build',
  'layout-apply',
  'enable',
  'disable',
  'provision',
]);
const USAGE =
  'Usage: kds-switch.mjs status | layout-build --tsv <file> [--terminals <file>] --out <file> | layout-apply --file <file> --reason <text> | enable --reason <text> | disable --reason <text> | provision --reason <text>';
const FLAGS = {
  status: { required: [], optional: [] },
  'layout-build': { required: ['--tsv', '--out'], optional: ['--terminals'] },
  'layout-apply': { required: ['--file', '--reason'], optional: [] },
  enable: { required: ['--reason'], optional: [] },
  disable: { required: ['--reason'], optional: [] },
  provision: { required: ['--reason'], optional: [] },
};
/**
 * Database roles of the fulfillment transport worker, which runs the cloud admission of app and
 * kiosk orders (acceptCloud -> buildKitchenPlan) and must read the switch and the layout
 * (WORKER_PRIVILEGES of kds-grants.mjs, CR kds-3). pickchick_fulfillment_sync is the login the
 * native Windows worker requires (native-fulfillment-worker.mjs); pickchick_fulfillment_worker
 * is the default of cashier-reports-upgrade-db.mjs. Every one of them that exists is checked.
 */
export const KDS_WORKER_ROLES = Object.freeze([
  'pickchick_fulfillment_sync',
  'pickchick_fulfillment_worker',
]);
const WORKER_GRANTS_TEXT =
  'У воркера fulfillment нет прав чтения раскладки KDS - заказы приложения и киоска уйдут на старые станции';
/**
 * Database role of the edge runtime (services/edge: the kitchen API and the cashier admission).
 * It reads the switch and the layout too, and writes the courier journals (RUNTIME_PRIVILEGES).
 * Without them the kitchen screens and the cashier stay on the old stations while the worker
 * already sends app and kiosk orders to the KDS stations, and a courier handover fails.
 */
export const KDS_RUNTIME_ROLES = Object.freeze(['pickchick_edge_runtime']);
const RUNTIME_GRANTS_TEXT =
  'У рантайма edge нет прав на таблицы KDS - экраны кухни и касса останутся на старых станциях, передача курьеру не запишется';
const MAX_FILE_BYTES = 256 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAMES = Object.fromEntries(KDS_STATIONS.map((station) => [station.function, station.name]));
const FUNCTIONS = KdsFunctionSchema.options;

/** Operator-facing failure: code for scripts, Russian text and details for the operator. */
export class KdsSwitchError extends Error {
  constructor(code, message, errors = []) {
    super(message);
    this.code = code;
    this.errors = errors;
  }
}
const problem = (code, message) => ({ code, message });
const reject = (code, message, errors) => {
  throw new KdsSwitchError(code, message, errors);
};

export function parseKdsSwitchArgs(argv) {
  const [command, ...rest] = argv;
  const spec = FLAGS[command];
  if (!spec) reject('USAGE', USAGE);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (
      ![...spec.required, ...spec.optional].includes(flag) ||
      flag in options ||
      typeof value !== 'string' ||
      !value ||
      value.startsWith('--')
    )
      reject('USAGE', USAGE);
    options[flag] = value;
  }
  if (spec.required.some((flag) => !(flag in options))) reject('USAGE', USAGE);
  const result = {
    command,
    ...(options['--tsv'] ? { tsv: options['--tsv'] } : {}),
    ...(options['--terminals'] ? { terminals: options['--terminals'] } : {}),
    ...(options['--out'] ? { out: options['--out'] } : {}),
    ...(options['--file'] ? { file: options['--file'] } : {}),
  };
  if ('--reason' in options) result.reason = checkedReason(options['--reason']);
  return result;
}

export function checkedReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (reason.length < 3 || reason.length > 300 || /[\u0000-\u001f\u007f]/.test(reason))
    reject('REASON_INVALID', 'Причина - от 3 до 300 символов в одну строку');
  return reason;
}

/** Same owner binding as scripts/local-pos-service.mjs: local owner of pickchick_edge only. */
export function kdsSwitchConfig(env = process.env) {
  const config = edgeInstallConfig(env),
    url = new URL(config.databaseUrl);
  if (
    config.environment !== 'local' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    decodeURIComponent(url.username) !== 'pickchick_edge_owner'
  )
    reject('OWNER_REQUIRED', 'Нужна защищённая среда владельца базы точки (owner env)');
  return config;
}

const lines = (text) =>
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, number: index + 1 }))
    .filter((line) => line.raw.trim() && !line.raw.trimStart().startsWith('#'));
/** Tab-separated cells; trailing empty cells (spreadsheet export) are dropped. */
const cells = (raw) => {
  const values = raw.split('\t').map((cell) => cell.trim());
  while (values.length && !values.at(-1)) values.pop();
  return values;
};

/** Chef layout TSV -> rows. Collects every problem with its line number before failing. */
export function parseChefTsv(text) {
  if (typeof text !== 'string') reject('TSV_INVALID', 'Файл шефа не прочитан');
  const [header, ...body] = lines(text);
  const errors = [];
  if (!header || cells(header.raw).join('\t') !== 'product_slug\tfunction\tunit\tcount')
    reject('TSV_INVALID', 'Ошибки в файле шефа', [
      problem('TSV_HEADER', 'Первая строка: колонки product_slug, function, unit, count через Tab'),
    ]);
  if (body.length > 2000)
    reject('TSV_INVALID', 'Ошибки в файле шефа', [problem('TSV_TOO_LARGE', 'Больше 2000 строк')]);
  const rows = [],
    seen = new Map();
  for (const line of body) {
    const values = cells(line.raw);
    const at = `Строка ${line.number}: `;
    if (values.length < 2 || values.length > 4) {
      errors.push(problem('TSV_COLUMNS', at + 'нужно от 2 до 4 колонок через Tab'));
      continue;
    }
    const [slug, fn, unit = '', count = ''] = values;
    let valid = true;
    if (!SLUG.test(slug)) {
      errors.push(problem('TSV_SLUG', at + `неверный slug «${slug}»`));
      valid = false;
    }
    if (!FUNCTIONS.includes(fn)) {
      errors.push(
        problem(
          'TSV_FUNCTION',
          at + `неизвестная функция «${fn}» (допустимо: ${FUNCTIONS.join(', ')})`,
        ),
      );
      continue;
    }
    if (!unit !== !count) {
      errors.push(problem('TSV_COUNT', at + 'единица и количество указываются вместе'));
      valid = false;
    } else if (unit) {
      if (!KdsUnitSchema.options.includes(unit) || !KDS_FUNCTION_UNITS[fn].includes(unit)) {
        const allowed = KDS_FUNCTION_UNITS[fn];
        errors.push(
          problem(
            'TSV_UNIT',
            at +
              `единица «${unit}» не подходит для функции ${fn}` +
              (allowed.length ? ` (допустимо: ${allowed.join(', ')})` : ' (без количества)'),
          ),
        );
        valid = false;
      }
      if (!/^[1-9][0-9]{0,2}$/.test(count) || Number(count) > 100) {
        errors.push(problem('TSV_COUNT', at + 'количество - целое число от 1 до 100'));
        valid = false;
      }
    }
    const key = fn + '\t' + slug;
    if (seen.has(key)) {
      errors.push(
        problem(
          'TSV_DUPLICATE',
          at + `позиция «${slug}» уже указана для функции ${fn} (строка ${seen.get(key)})`,
        ),
      );
      continue;
    }
    seen.set(key, line.number);
    if (valid)
      rows.push({
        line: line.number,
        product_slug: slug,
        function: fn,
        ...(unit ? { unit, count: Number(count) } : {}),
      });
  }
  if (errors.length) reject('TSV_INVALID', 'Ошибки в файле шефа', errors);
  return rows;
}

/** Screens TSV (function, terminal_id) -> terminal ids per function. */
export function parseTerminalsTsv(text) {
  if (typeof text !== 'string') reject('TSV_INVALID', 'Файл экранов не прочитан');
  const [header, ...body] = lines(text);
  if (!header || cells(header.raw).join('\t') !== 'function\tterminal_id')
    reject('TSV_INVALID', 'Ошибки в файле экранов', [
      problem('TSV_HEADER', 'Первая строка: колонки function, terminal_id через Tab'),
    ]);
  const result = new Map(),
    errors = [];
  for (const line of body) {
    const [fn, terminal, ...extra] = cells(line.raw);
    const at = `Строка ${line.number}: `;
    if (extra.length || !FUNCTIONS.includes(fn) || !UuidSchema.safeParse(terminal).success) {
      errors.push(problem('TSV_TERMINAL', at + 'нужны функция KDS и id экрана (uuid)'));
      continue;
    }
    const list = result.get(fn) ?? [];
    if (list.includes(terminal)) {
      errors.push(problem('TSV_DUPLICATE', at + `экран ${terminal} уже указан для ${fn}`));
      continue;
    }
    result.set(fn, [...list, terminal]);
  }
  if (errors.length) reject('TSV_INVALID', 'Ошибки в файле экранов', errors);
  return result;
}

async function readiness(client) {
  return (
    await client.query(
      `SELECT to_regclass('kds_settings') IS NOT NULL AND to_regclass('kds_layouts') IS NOT NULL
         AND to_regclass('kds_setting_changes') IS NOT NULL AS ready`,
    )
  ).rows[0].ready;
}
async function requireBranch(client, branchId) {
  UuidSchema.parse(branchId);
  if (!(await readiness(client)))
    reject('SCHEMA_NOT_READY', 'Миграция 027 не установлена - сначала обновите базу точки');
  const branches = (await client.query('SELECT id FROM branch_config')).rows;
  if (branches.length !== 1 || branches[0].id !== branchId)
    reject('BRANCH_MISMATCH', 'База принадлежит другой точке');
}
async function lockSettings(client, branchId) {
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'pickchick-kds-switch:' + branchId,
  ]);
  const settings = (
    await client.query('SELECT * FROM kds_settings WHERE branch_id=$1 FOR UPDATE', [branchId])
  ).rows[0];
  if (!settings)
    reject('NOT_PROVISIONED', 'Станции KDS не созданы - сначала обновите базу точки (027)');
  return settings;
}
async function activeMenu(client, branchId) {
  const row = (
    await client.query(
      'SELECT s.payload FROM active_menu a JOIN menu_snapshots s ON s.id=a.release_id AND s.branch_id=a.branch_id WHERE a.branch_id=$1',
      [branchId],
    )
  ).rows[0];
  if (!row) return null;
  return (Array.isArray(row.payload?.items) ? row.payload.items : []).map((item) => ({
    slug: typeof item?.source_id === 'string' && SLUG.test(item.source_id) ? item.source_id : null,
    name: typeof item?.name?.ru === 'string' ? item.name.ru : String(item?.product_id ?? ''),
  }));
}

/**
 * Existing roles among `roles` (pg_roles is cluster-wide) and whether each holds every privilege
 * of `privileges` (a kds-grants.mjs map: 'SELECT', or 'UPDATE(a, b)' for columns) on the KDS
 * tables of this schema, with USAGE on the schema. A missing right is false, never NULL.
 */
async function rolesWithKdsRights(client, roles, privileges) {
  if (!roles.length) return [];
  const checks = Object.entries(privileges).flatMap(([table, list]) =>
    list.flatMap((privilege) => {
      const [, action, columns] = /^(SELECT|INSERT|UPDATE)(?:\(([a-z_, ]+)\))?$/.exec(privilege);
      return columns
        ? columns.split(',').map((column) => ({ table, column: column.trim(), action }))
        : [{ table, column: null, action }];
    }),
  );
  // An empty check list would group to no rows and hide every role.
  if (!checks.length) throw new TypeError('KDS privileges');
  return (
    await client.query(
      `SELECT r.rolname AS role,
         coalesce(has_schema_privilege(r.rolname,
           (SELECT relnamespace FROM pg_class WHERE oid=to_regclass('kds_settings')),'USAGE'),false)
         AND bool_and(coalesce(CASE WHEN c.col IS NULL
           THEN has_table_privilege(r.rolname,to_regclass(c.tbl),c.act)
           ELSE has_column_privilege(r.rolname,to_regclass(c.tbl),c.col,c.act) END,false)) AS ok
       FROM pg_roles r CROSS JOIN unnest($2::text[],$3::text[],$4::text[]) AS c(tbl,col,act)
       WHERE r.rolname=ANY($1::text[]) GROUP BY r.rolname ORDER BY r.rolname`,
      [roles, checks.map((c) => c.table), checks.map((c) => c.column), checks.map((c) => c.action)],
    )
  ).rows;
}
/**
 * Fulfillment worker roles that exist and whether each can read the switch and the active layout
 * (WORKER_PRIVILEGES). readKdsLayout reports the layout as off to a role without these rights,
 * so the cloud admission would silently keep the old stations.
 */
async function workerLayoutAccess(client, roles) {
  return (await rolesWithKdsRights(client, roles, WORKER_PRIVILEGES)).map((row) => ({
    role: row.role,
    layout_read: row.ok,
  }));
}
/** Edge runtime roles that exist and whether each holds RUNTIME_PRIVILEGES of kds-grants.mjs. */
async function runtimeKdsAccess(client, roles) {
  return (await rolesWithKdsRights(client, roles, RUNTIME_PRIVILEGES)).map((row) => ({
    role: row.role,
    kds_rights: row.ok,
  }));
}
/**
 * Live orders whose finishing station is not a KDS station: admitted on the old stations. After
 * enable a kitchen login on a KDS screen sees only its tabs, so the shift manager finishes them
 * with the station switcher; the aggregator ones are then handed over with the three marks.
 */
async function ordersOnOldStations(client, branchId) {
  const kds = KDS_STATIONS.map((spec) => kdsStationId(branchId, spec.function));
  return (
    await client.query(
      `SELECT count(*)::int AS orders,count(*) FILTER (WHERE r.snapshot ? 'delivery')::int AS delivery
       FROM fulfillment_reservations r WHERE r.branch_id=$1
         AND r.state IN ('accepted','in_production','ready','cancel_requested')
         AND NOT r.assembly_station_id=ANY($2::uuid[])`,
      [branchId, kds],
    )
  ).rows[0];
}
const oldStationsText = ({ orders, delivery }) =>
  `Открытых заказов на старых станциях: ${orders}` +
  (delivery ? ` (из них агрегаторов: ${delivery})` : '') +
  ' - их завершает начальник смены через переключатель станций';

/**
 * Checks a schema-valid layout against this edge: its KDS stations, the active menu and the
 * kitchen screens. `strict` adds the conditions to switch it on: the kitchen login can open
 * every station, every station with work has a screen, the fulfillment worker can read the
 * layout and the edge runtime holds its KDS rights.
 */
async function checkLayout(
  client,
  branchId,
  layout,
  { strict = false, workerRoles = KDS_WORKER_ROLES, runtimeRoles = KDS_RUNTIME_ROLES } = {},
) {
  const errors = [],
    warnings = [];
  if (layout.branch_id !== branchId)
    errors.push(problem('BRANCH_MISMATCH', 'Раскладка составлена для другой точки'));
  const stations = new Map(
    (
      await client.query('SELECT id,kind,name FROM fulfillment_stations WHERE branch_id=$1', [
        branchId,
      ])
    ).rows.map((row) => [row.id, row]),
  );
  for (const station of layout.stations) {
    const name = NAMES[station.function];
    if (station.edge_station_id !== kdsStationId(branchId, station.function))
      errors.push(problem('STATION_MISMATCH', `${name}: станция не совпадает со станцией KDS`));
    else if (stations.get(station.edge_station_id)?.kind !== KDS_FUNCTION_KIND[station.function])
      errors.push(problem('STATION_MISSING', `${name}: станция KDS не создана на сервере точки`));
  }
  const menu = await activeMenu(client, branchId);
  if (!menu) errors.push(problem('MENU_MISSING', 'На сервере точки нет активного меню'));
  const slugs = new Set((menu ?? []).map((item) => item.slug).filter(Boolean));
  for (const station of layout.stations) {
    const unknown = station.product_ids.filter((slug) => !slugs.has(slug));
    if (menu && unknown.length) {
      const problemText = `${NAMES[station.function]}: нет в активном меню - ${unknown.join(', ')}`;
      if (strict) warnings.push(problem('UNKNOWN_PRODUCT', problemText));
      else errors.push(problem('UNKNOWN_PRODUCT', problemText));
    }
  }
  // A product has a place when a table or the issue counter shows it (contracts section 5.4).
  const placed = new Set(
    layout.stations
      .filter((s) => ['assembly_hall', 'assembly_delivery', 'issue'].includes(s.function))
      .flatMap((s) => s.product_ids),
  );
  const unmapped = (menu ?? [])
    .filter((item) => !item.slug || !placed.has(item.slug))
    .map((item) => item.slug ?? item.name);
  const terminalIds = [...new Set(layout.stations.flatMap((s) => s.terminal_ids))];
  const terminals = new Map(
    (
      await client.query(
        `SELECT t.id,t.active,t.device_access_managed,r.mode,r.state FROM local_terminals t
         LEFT JOIN terminal_access_registry r ON r.terminal_id=t.id AND r.branch_id=t.branch_id
         WHERE t.branch_id=$1 AND t.id=ANY($2::uuid[])`,
        [branchId, terminalIds],
      )
    ).rows.map((row) => [row.id, row]),
  );
  for (const station of layout.stations)
    for (const id of station.terminal_ids) {
      const terminal = terminals.get(id),
        name = NAMES[station.function],
        kind = KDS_FUNCTION_KIND[station.function];
      if (!terminal?.active)
        errors.push(problem('UNKNOWN_TERMINAL', `${name}: экран ${id} не найден или выключен`));
      else if (terminal.state === 'revoked')
        errors.push(problem('TERMINAL_REVOKED', `${name}: экран ${id} отключён в «Устройствах»`));
      else if (terminal.mode && terminal.mode !== kind)
        errors.push(
          problem(
            'TERMINAL_MODE_MISMATCH',
            `${name}: экран ${id} подключён в режиме ${terminal.mode}, станции нужен ${kind}`,
          ),
        );
      else if (terminal.device_access_managed && terminal.state !== 'paired')
        warnings.push(problem('TERMINAL_NOT_PAIRED', `${name}: экран ${id} ещё не подключён`));
    }
  const withWork = layout.stations.filter(
    (s) => KDS_FUNCTION_KIND[s.function] === 'assembly' || s.product_ids.length,
  );
  const unscreened = withWork.filter((s) => !s.terminal_ids.length).map((s) => NAMES[s.function]);
  if (unscreened.length)
    (strict ? errors : warnings).push(
      problem('STATION_WITHOUT_SCREEN', `У станций нет экрана: ${unscreened.join(', ')}`),
    );
  const kitchen = (
    await client.query(
      `SELECT s.id FROM local_staff s JOIN local_staff_passwords p ON p.staff_id=s.id AND p.branch_id=s.branch_id
       WHERE s.branch_id=$1 AND s.active AND s.role='kitchen' AND p.login='kitchen'`,
      [branchId],
    )
  ).rows[0];
  const granted = new Set(
    kitchen
      ? (
          await client.query(
            'SELECT station_id FROM fulfillment_station_grants WHERE branch_id=$1 AND staff_id=$2',
            [branchId, kitchen.id],
          )
        ).rows.map((row) => row.station_id)
      : [],
  );
  const closed = layout.stations
    .filter((s) => !granted.has(s.edge_station_id))
    .map((s) => NAMES[s.function]);
  if (closed.length)
    (strict ? errors : warnings).push(
      problem(
        'KITCHEN_GRANTS_MISSING',
        kitchen
          ? `У входа kitchen нет доступа к станциям: ${closed.join(', ')}`
          : 'Нет активного входа kitchen для экранов кухни',
      ),
    );
  // Only to switch on: grants are installed by kds-upgrade-db, a draft layout may come first.
  const blind = strict
    ? (await workerLayoutAccess(client, workerRoles)).filter((r) => !r.layout_read)
    : [];
  if (blind.length)
    errors.push(
      problem(
        'WORKER_GRANTS_MISSING',
        `${WORKER_GRANTS_TEXT} (роль ${blind.map((r) => r.role).join(', ')})`,
      ),
    );
  const runtimeBlind = strict
    ? (await runtimeKdsAccess(client, runtimeRoles)).filter((r) => !r.kds_rights)
    : [];
  if (runtimeBlind.length)
    errors.push(
      problem(
        'RUNTIME_GRANTS_MISSING',
        `${RUNTIME_GRANTS_TEXT} (роль ${runtimeBlind.map((r) => r.role).join(', ')})`,
      ),
    );
  return { errors, warnings, unmapped };
}

function parsedLayout(value) {
  const result = KdsLayoutSchema.safeParse(value);
  if (!result.success)
    reject(
      'LAYOUT_INVALID',
      'Файл раскладки не соответствует схеме KDS',
      result.error.issues.map((issue) =>
        problem('LAYOUT_INVALID', `${issue.path.join('.') || 'layout'}: ${issue.message}`),
      ),
    );
  return result.data;
}
const nextVersion = async (client, branchId) =>
  (
    await client.query(
      'SELECT COALESCE(max(version),0)+1 AS next FROM kds_layouts WHERE branch_id=$1',
      [branchId],
    )
  ).rows[0].next;

/**
 * Owner decision (contracts section 9, q.15): the courier counter (3) is a tab on the screen of
 * table 2. A screens file without delivery_handover lines puts station 3 on every table-2 screen
 * that still has room for a second tab (a terminal opens at most two stations). Explicit lines
 * and screens carried over from the active layout are kept as they are.
 */
function defaultHandoverScreens(terminalsOf, fromFile) {
  const explicit = terminalsOf('delivery_handover');
  if (!fromFile || explicit.length) return { ids: explicit, defaulted: false };
  const tabs = (id) => FUNCTIONS.filter((fn) => terminalsOf(fn).includes(id)).length;
  const ids = terminalsOf('assembly_delivery').filter((id) => tabs(id) < 2);
  return { ids, defaulted: ids.length > 0 };
}

/** layout-build: chef TSV (+ screens) -> the next layout version and the operator report. */
export async function buildKdsLayout(pool, { branchId, tsv, terminalsTsv }) {
  const rows = parseChefTsv(tsv);
  const screens = terminalsTsv === undefined ? null : parseTerminalsTsv(terminalsTsv);
  return transaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await requireBranch(client, branchId);
    const settings = (
      await client.query('SELECT * FROM kds_settings WHERE branch_id=$1', [branchId])
    ).rows[0];
    if (!settings)
      reject('NOT_PROVISIONED', 'Станции KDS не созданы - сначала обновите базу точки (027)');
    const active =
      settings.active_layout_version === null
        ? null
        : (
            await client.query('SELECT layout FROM kds_layouts WHERE branch_id=$1 AND version=$2', [
              branchId,
              settings.active_layout_version,
            ])
          ).rows[0].layout;
    const terminalsOf = (fn) =>
      screens
        ? (screens.get(fn) ?? [])
        : (active?.stations.find((s) => s.function === fn)?.terminal_ids ?? []);
    const handoverScreens = defaultHandoverScreens(terminalsOf, Boolean(screens));
    const layout = parsedLayout({
      schema_version: 1,
      branch_id: branchId,
      version: await nextVersion(client, branchId),
      stations: KDS_STATIONS.map((spec) => {
        const own = rows.filter((row) => row.function === spec.function);
        const counts = own
          .filter((row) => row.unit)
          .map((row) => ({ product_id: row.product_slug, unit: row.unit, count: row.count }));
        return {
          edge_station_id: kdsStationId(branchId, spec.function),
          function: spec.function,
          terminal_ids:
            spec.function === 'delivery_handover'
              ? handoverScreens.ids
              : terminalsOf(spec.function),
          product_ids: own.map((row) => row.product_slug),
          ...(counts.length ? { counts } : {}),
        };
      }),
    });
    const checked = await checkLayout(client, branchId, layout);
    if (checked.errors.length) reject('LAYOUT_REJECTED', 'Раскладка не принята', checked.errors);
    return {
      layout,
      report: {
        version: layout.version,
        stations: layout.stations.map((station) => ({
          function: station.function,
          name: NAMES[station.function],
          products: station.product_ids.length,
          counted: station.counts?.length ?? 0,
          screens: station.terminal_ids.length,
        })),
        unmapped: checked.unmapped,
        warnings: checked.warnings,
        terminalsFrom: screens ? 'file' : active ? 'active_layout' : 'none',
        handoverOnTable2: handoverScreens.defaulted,
      },
    };
  });
}

export function formatBuildReport(report, out) {
  return [
    `Раскладка KDS: версия ${report.version}`,
    ...report.stations.map(
      (s) => `${s.name}: позиций ${s.products}, с количеством ${s.counted}, экранов ${s.screens}`,
    ),
    `Позиции меню без раскладки: ${report.unmapped.length}`,
    ...report.unmapped.map((name) => `  - ${name}`),
    ...(report.terminalsFrom === 'active_layout' ? ['Экраны взяты из действующей раскладки'] : []),
    ...(report.handoverOnTable2
      ? [`${NAMES.delivery_handover}: вкладка на экране стола 2 (по умолчанию)`]
      : []),
    ...(report.warnings.length
      ? ['Предупреждения:', ...report.warnings.map((w) => `  - ${w.message}`)]
      : []),
    ...(out
      ? [
          `Файл раскладки: ${out}`,
          `Применение: kds-switch.mjs layout-apply --file ${out} --reason "<причина>"`,
        ]
      : []),
  ].join('\n');
}

async function recordChange(client, branchId, settings, field, value, reason) {
  const version = settings.version + 1;
  await client.query(
    `INSERT INTO kds_setting_changes(command_id,branch_id,version,field,value,actor,reason,request_hash)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,'operator',$5,$6)`,
    [branchId, version, field, value, reason, digest({ branchId, version, field, value, reason })],
  );
  return version;
}

/** layout-apply: validate and store the next immutable layout version and make it active. */
export async function applyKdsLayout(pool, { branchId, layout: input, reason: rawReason }) {
  const reason = checkedReason(rawReason);
  const layout = parsedLayout(input);
  const checksum = digest(layout);
  return transaction(pool, async (client) => {
    await requireBranch(client, branchId);
    const settings = await lockSettings(client, branchId);
    const existing = (
      await client.query('SELECT checksum FROM kds_layouts WHERE branch_id=$1 AND version=$2', [
        branchId,
        layout.version,
      ])
    ).rows[0];
    if (existing) {
      if (existing.checksum === checksum && settings.active_layout_version === layout.version)
        return {
          applied: false,
          replayed: true,
          version: layout.version,
          checksum,
          layout_enabled: settings.layout_enabled,
          settings_version: settings.version,
        };
      reject(
        'VERSION_CONFLICT',
        `Версия раскладки ${layout.version} уже применялась - соберите новую (layout-build)`,
      );
    }
    const expected = await nextVersion(client, branchId);
    if (layout.version !== expected)
      reject('VERSION_NOT_NEXT', `Версия раскладки должна быть ${expected}`);
    const checked = await checkLayout(client, branchId, layout);
    if (checked.errors.length) reject('LAYOUT_REJECTED', 'Раскладка не принята', checked.errors);
    await client.query(
      "INSERT INTO kds_layouts(branch_id,version,layout,checksum,source,reason) VALUES($1,$2,$3,$4,'operator',$5)",
      [branchId, layout.version, layout, checksum, reason],
    );
    const version = await recordChange(
      client,
      branchId,
      settings,
      'active_layout_version',
      String(layout.version),
      reason,
    );
    await client.query(
      'UPDATE kds_settings SET active_layout_version=$2,version=$3,updated_at=clock_timestamp() WHERE branch_id=$1',
      [branchId, layout.version, version],
    );
    return {
      applied: true,
      replayed: false,
      version: layout.version,
      checksum,
      layout_enabled: settings.layout_enabled,
      settings_version: version,
      unmapped: checked.unmapped,
      warnings: checked.warnings,
    };
  });
}

/**
 * enable|disable. Enabling re-checks the active layout strictly (including the runtime and
 * worker rights) and warns about open orders on the old stations; disabling always works.
 */
export async function setKdsLayoutEnabled(
  pool,
  {
    branchId,
    enabled,
    reason: rawReason,
    workerRoles = KDS_WORKER_ROLES,
    runtimeRoles = KDS_RUNTIME_ROLES,
  },
) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled');
  const reason = checkedReason(rawReason);
  return transaction(pool, async (client) => {
    await requireBranch(client, branchId);
    const settings = await lockSettings(client, branchId);
    if (settings.layout_enabled === enabled)
      return {
        changed: false,
        layout_enabled: enabled,
        active_layout_version: settings.active_layout_version,
        settings_version: settings.version,
      };
    let warnings = [];
    if (enabled) {
      if (settings.active_layout_version === null)
        reject('NO_LAYOUT', 'Раскладка не применена - сначала layout-apply');
      const stored = (
        await client.query('SELECT layout FROM kds_layouts WHERE branch_id=$1 AND version=$2', [
          branchId,
          settings.active_layout_version,
        ])
      ).rows[0].layout;
      const checked = await checkLayout(client, branchId, parsedLayout(stored), {
        strict: true,
        workerRoles,
        runtimeRoles,
      });
      if (checked.errors.length)
        reject('ENABLE_REJECTED', 'Раскладку нельзя включить', checked.errors);
      warnings = checked.warnings;
      const old = await ordersOnOldStations(client, branchId);
      if (old.orders)
        warnings = [...warnings, problem('OPEN_ORDERS_ON_OLD_STATIONS', oldStationsText(old))];
    }
    const version = await recordChange(
      client,
      branchId,
      settings,
      'layout_enabled',
      String(enabled),
      reason,
    );
    await client.query(
      'UPDATE kds_settings SET layout_enabled=$2,version=$3,updated_at=clock_timestamp() WHERE branch_id=$1',
      [branchId, enabled, version],
    );
    return {
      changed: true,
      layout_enabled: enabled,
      active_layout_version: settings.active_layout_version,
      settings_version: version,
      warnings,
    };
  });
}

/**
 * provision: repeats the trusted station provisioning of kds-upgrade-db apply for a shared
 * `kitchen` login enrolled (or replaced) after 027, without which enable is refused with
 * KITCHEN_GRANTS_MISSING. Same idempotent provisionKdsStations: adds only missing KDS stations
 * and the missing station grants of the active `kitchen` login; never changes the switch, the
 * layouts, the old stations, their routes or grants, or any order. A run that adds something is
 * one audited settings version (field `provisioned`); a run that adds nothing writes nothing.
 * Refused, with nothing written, while there is no active `kitchen` login.
 */
export async function provisionKds(pool, { branchId, reason: rawReason }) {
  const reason = checkedReason(rawReason);
  return transaction(pool, async (client) => {
    await requireBranch(client, branchId);
    const settings = await lockSettings(client, branchId);
    const result = await provisionKdsStations(client, branchId);
    if (!result.kitchenStaffId)
      reject(
        'KITCHEN_LOGIN_MISSING',
        'Нет активного общего входа kitchen - заведите его и повторите provision',
      );
    const changed = result.stationsAdded + result.grantsAdded > 0;
    let version = settings.version;
    if (changed) {
      version = await recordChange(client, branchId, settings, 'provisioned', null, reason);
      await client.query(
        'UPDATE kds_settings SET version=$2,updated_at=clock_timestamp() WHERE branch_id=$1',
        [branchId, version],
      );
    }
    return {
      changed,
      stations_added: result.stationsAdded,
      grants_added: result.grantsAdded,
      kitchen_login: result.kitchenStaffId,
      layout_enabled: settings.layout_enabled,
      settings_version: version,
    };
  });
}

/**
 * status: read-only view of the switch, the active layout, the stations, the worker and runtime
 * rights, the open orders on the old stations and the audit.
 */
export async function kdsStatus(
  pool,
  { branchId, workerRoles = KDS_WORKER_ROLES, runtimeRoles = KDS_RUNTIME_ROLES },
) {
  return transaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    UuidSchema.parse(branchId);
    if (!(await readiness(client)))
      return {
        schema_ready: false,
        provisioned: false,
        summary: ['Миграция 027 не установлена: KDS выключен, работает прежняя кухня'],
      };
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId)
      reject('BRANCH_MISMATCH', 'База принадлежит другой точке');
    const settings = (
      await client.query('SELECT * FROM kds_settings WHERE branch_id=$1', [branchId])
    ).rows[0];
    const kitchen = (
      await client.query(
        `SELECT s.id FROM local_staff s JOIN local_staff_passwords p ON p.staff_id=s.id AND p.branch_id=s.branch_id
         WHERE s.branch_id=$1 AND s.active AND s.role='kitchen' AND p.login='kitchen'`,
        [branchId],
      )
    ).rows[0];
    const stationRows = new Map(
      (
        await client.query(
          `SELECT f.id,f.kind,f.name,EXISTS(SELECT 1 FROM fulfillment_station_grants g
             WHERE g.branch_id=f.branch_id AND g.station_id=f.id AND g.staff_id=$2) AS kitchen
           FROM fulfillment_stations f WHERE f.branch_id=$1`,
          [branchId, kitchen?.id ?? null],
        )
      ).rows.map((row) => [row.id, row]),
    );
    const stations = KDS_STATIONS.map((spec) => {
      const id = kdsStationId(branchId, spec.function),
        row = stationRows.get(id);
      return {
        function: spec.function,
        id,
        name: spec.name,
        present: Boolean(row && row.kind === spec.kind && row.name === spec.name),
        kitchen_access: Boolean(row?.kitchen),
      };
    });
    const active =
      settings?.active_layout_version == null
        ? null
        : (
            await client.query(
              'SELECT version,layout,checksum,source,applied_at,reason FROM kds_layouts WHERE branch_id=$1 AND version=$2',
              [branchId, settings.active_layout_version],
            )
          ).rows[0];
    const changes = (
      await client.query(
        'SELECT version,field,value,actor,reason,recorded_at FROM kds_setting_changes WHERE branch_id=$1 ORDER BY version DESC LIMIT 10',
        [branchId],
      )
    ).rows.map((row) => ({ ...row, recorded_at: row.recorded_at.toISOString() }));
    const present = stations.filter((s) => s.present).length,
      access = stations.filter((s) => s.kitchen_access).length;
    const workers = await workerLayoutAccess(client, workerRoles);
    const blind = workers.filter((w) => !w.layout_read);
    const runtimes = await runtimeKdsAccess(client, runtimeRoles);
    const runtimeBlind = runtimes.filter((r) => !r.kds_rights);
    const old = await ordersOnOldStations(client, branchId);
    return {
      schema_ready: true,
      provisioned: Boolean(settings),
      settings: settings
        ? {
            layout_enabled: settings.layout_enabled,
            active_layout_version: settings.active_layout_version,
            shift_mode: settings.shift_mode,
            version: settings.version,
            updated_at: settings.updated_at.toISOString(),
          }
        : null,
      active_layout: active
        ? {
            version: active.version,
            checksum: active.checksum,
            source: active.source,
            applied_at: active.applied_at.toISOString(),
            reason: active.reason,
            stations: active.layout.stations.map((s) => ({
              function: s.function,
              products: s.product_ids.length,
              counted: s.counts?.length ?? 0,
              screens: s.terminal_ids.length,
            })),
          }
        : null,
      stations,
      kitchen_login: kitchen?.id ?? null,
      worker_roles: workers,
      runtime_roles: runtimes,
      orders_on_old_stations: old,
      changes,
      summary: [
        settings
          ? `Раскладка KDS: ${settings.layout_enabled ? 'включена' : 'выключена'}`
          : 'Станции KDS не созданы',
        active ? `Активная раскладка: версия ${active.version}` : 'Активной раскладки нет',
        `Станции KDS: ${present} из ${stations.length}, доступ входа kitchen: ${access} из ${stations.length}`,
        blind.length
          ? `${WORKER_GRANTS_TEXT} (роль ${blind.map((w) => w.role).join(', ')})`
          : workers.length
            ? 'Воркер fulfillment читает раскладку KDS'
            : 'Роль воркера fulfillment на сервере точки не найдена',
        runtimeBlind.length
          ? `${RUNTIME_GRANTS_TEXT} (роль ${runtimeBlind.map((r) => r.role).join(', ')})`
          : runtimes.length
            ? 'Рантайм edge читает раскладку KDS и пишет журналы передачи'
            : 'Роль рантайма edge на сервере точки не найдена',
        oldStationsText(old),
      ],
    };
  });
}

async function readBounded(path) {
  const file = await open(path, 'r').catch(() =>
    reject('FILE_INVALID', `Файл ${path}: не найден или нет доступа`),
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      reject('FILE_INVALID', `Файл ${path}: нужен обычный файл до 256 КБ`);
    return (await file.readFile()).toString('utf8');
  } finally {
    await file.close();
  }
}

export async function runKdsSwitch(argv, env = process.env, output = console.log) {
  const command = parseKdsSwitchArgs(argv);
  const config = kdsSwitchConfig(env);
  const branchId = config.branchId;
  const pool = createPool(config.databaseUrl, 1);
  try {
    if (command.command === 'status') {
      output(JSON.stringify({ event: 'kds_status', ...(await kdsStatus(pool, { branchId })) }));
    } else if (command.command === 'layout-build') {
      const result = await buildKdsLayout(pool, {
        branchId,
        tsv: await readBounded(command.tsv),
        ...(command.terminals ? { terminalsTsv: await readBounded(command.terminals) } : {}),
      });
      await writeFile(command.out, JSON.stringify(result.layout, null, 2) + '\n', {
        flag: 'wx',
      }).catch(() => reject('FILE_EXISTS', `Файл ${command.out} уже существует или недоступен`));
      output(formatBuildReport(result.report, command.out));
    } else if (command.command === 'layout-apply') {
      let layout;
      try {
        layout = JSON.parse(await readBounded(command.file));
      } catch (error) {
        if (error instanceof KdsSwitchError) throw error;
        reject('FILE_INVALID', `Файл ${command.file}: не JSON`);
      }
      const result = await applyKdsLayout(pool, { branchId, layout, reason: command.reason });
      output(JSON.stringify({ event: 'kds_layout_applied', ...result }));
    } else if (command.command === 'provision') {
      const result = await provisionKds(pool, { branchId, reason: command.reason });
      output(JSON.stringify({ event: 'kds_provisioned', ...result }));
    } else {
      const result = await setKdsLayoutEnabled(pool, {
        branchId,
        enabled: command.command === 'enable',
        reason: command.reason,
      });
      output(JSON.stringify({ event: 'kds_layout_switched', ...result }));
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runKdsSwitch(process.argv.slice(2)).catch((error) => {
    // Known failures carry operator text; anything else stays generic (no URLs or SQL in logs).
    console.error(
      JSON.stringify(
        error instanceof KdsSwitchError
          ? {
              event: 'kds_switch_failed',
              code: error.code,
              message: error.message,
              errors: error.errors,
            }
          : {
              event: 'kds_switch_failed',
              code: 'UNEXPECTED',
              message: 'Остановлено, база не изменена',
            },
      ),
    );
    process.exitCode = 1;
  });
