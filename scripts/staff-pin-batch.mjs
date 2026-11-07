#!/usr/bin/env node
// PINs of the cashier staff, one person after another (lane bo-ui step 6, design-bo-ui.md 5.7;
// runbook docs/operations/backoffice-p1-cutover.md «Состав кассы»). Run on the branch server
// after scripts/staff-roster-apply.mjs, with the same roster file:
//
//   node scripts/staff-pin-batch.mjs --file roster.json [--digits 4|6] [--replace] [--employee UUID]
//
// For every card of the roster with cashier access (or only --employee) the screen shows the
// name and the role; the operator hands the keyboard to that person, who types the PIN twice in
// hidden input (scripts/hidden-password.mjs: an interactive terminal only, never argv,
// environment or redirected input). An empty PIN skips the person. The PIN is set by the
// existing operator function setStaffPin with the bootstrap session that staff-roster-apply
// saved in .local/staff-<id>.json, exactly as scripts/staff-pin-setup.mjs does for one person.
// No PIN is ever printed, logged or written to a file; only the staff id and role of each result.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readRosterFile } from './staff-roster-apply.mjs';

const ROLE_LABEL = Object.freeze({ cashier: 'кассир', shift_manager: 'начальник смены' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Attempts per person before the person is skipped (mismatch, wrong length, PIN taken). */
export const PIN_ATTEMPTS = 3;

/**
 * Asks each person of the roster for a PIN. `readPin(prompt)` returns the hidden input (the CLI
 * uses readHiddenPassword); `say` shows a line to the person at the keyboard; `log` gets one
 * event per person (never the PIN). Returns the events.
 */
export async function runPinBatch({
  pool,
  branchId,
  roster,
  store,
  setStaffPin,
  readPin,
  say = () => {},
  log = () => {},
  digits = 4,
  replace = false,
  employee = null,
}) {
  if (![4, 6].includes(digits)) throw new Error('USAGE');
  const format = new RegExp(`^[0-9]{${digits}}$`);
  const people = roster.staff
    .filter((s) => s.role !== null && (!employee || s.employee_id === employee.toLowerCase()))
    .sort(
      (a, b) => a.name.localeCompare(b.name, 'ru') || a.employee_id.localeCompare(b.employee_id),
    );
  const accounts = new Map(
    (
      await pool.query(
        `SELECT s.id::text AS id,s.role,s.active,EXISTS(SELECT 1 FROM local_staff_pins p WHERE p.staff_id=s.id) AS has_pin
         FROM local_staff s WHERE s.branch_id=$1`,
        [branchId],
      )
    ).rows.map((r) => [r.id.toLowerCase(), r]),
  );
  const events = [];
  const done = (person, outcome) => {
    const event = {
      event: outcome === 'saved' ? 'staff_pin_saved' : 'staff_pin_skipped',
      staff_id: person.edge_staff_id,
      role: person.role,
      ...(outcome === 'saved' ? {} : { reason: outcome }),
    };
    events.push(event);
    log(event);
  };
  for (const person of people) {
    const account = accounts.get(person.edge_staff_id);
    if (!account || !account.active || account.role !== person.role) {
      done(person, 'not_on_edge');
      continue;
    }
    if (account.has_pin && !replace) {
      done(person, 'pin_exists');
      continue;
    }
    let credential;
    try {
      credential = await store.readStaffCredential(person.edge_staff_id);
    } catch {
      done(person, 'no_bootstrap');
      continue;
    }
    if (credential.branch_id !== branchId || credential.staff_id !== person.edge_staff_id) {
      done(person, 'no_bootstrap');
      continue;
    }
    say(`Сотрудник: ${person.name} (${ROLE_LABEL[person.role]}). Передайте клавиатуру сотруднику.`);
    let outcome = 'pin_failed';
    for (let attempt = 0; attempt < PIN_ATTEMPTS; attempt++) {
      // The PIN lives only in this attempt's constants and goes straight to setStaffPin.
      const pin = await readPin(`PIN, ${digits} цифр (скрыт; пусто - пропустить): `);
      if (!pin) {
        outcome = 'skipped';
        break;
      }
      const confirmed = (await readPin('Повторите PIN (скрыт): ')) === pin;
      if (!format.test(pin) || !confirmed) {
        say(`PIN не совпал или не ${digits} цифр. Попробуйте ещё раз.`);
        continue;
      }
      try {
        await setStaffPin(
          pool,
          branchId,
          { sessionId: credential.session_id, token: credential.token },
          pin,
          replace && account.has_pin,
        );
        outcome = 'saved';
        break;
      } catch (error) {
        const code = error && typeof error === 'object' ? error.code : null;
        if (code === 'UNAUTHORIZED') {
          outcome = 'bootstrap_expired';
          break;
        }
        // CONFLICT: the PIN is taken by another person of the branch (or changed meanwhile).
        say('Этот PIN не подходит. Введите другой.');
      }
    }
    done(person, outcome);
  }
  return events;
}

const MESSAGES = {
  USAGE:
    'Usage: node scripts/staff-pin-batch.mjs --file roster.json [--digits 4|6] [--replace] [--employee UUID]',
  ROSTER_FORMAT: 'The roster file is not a back-office roster (download it again).',
  ROSTER_DIGEST: 'The roster file was changed after the download (sha256 differs).',
  ROSTER_OTHER_BRANCH: 'The roster belongs to another branch.',
  OWNER_REQUIRED: 'Local edge owner connection and matching branch required.',
};
async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      digits: { type: 'string', default: '4' },
      replace: { type: 'boolean', default: false },
      employee: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.file || !['4', '6'].includes(values.digits)) throw new Error('USAGE');
  if (values.employee && !UUID.test(values.employee)) throw new Error('USAGE');
  const [{ createPool }, { loadConfig }, local, store, hidden] = await Promise.all([
    import('@pickchick/database'),
    import('@pickchick/platform'),
    import('@pickchick/local-orders'),
    import('./staff-credential.mjs'),
    import('./hidden-password.mjs'),
  ]);
  const config = loadConfig('edge');
  const database = new URL(config.databaseUrl);
  // The same guard as staff-pin-setup.mjs: only the local protected owner connection.
  if (
    database.hostname !== '127.0.0.1' ||
    database.port !== '55433' ||
    database.pathname !== '/pickchick_edge'
  )
    throw new Error('OWNER_REQUIRED');
  const roster = await readRosterFile(values.file, config.branchId);
  const pool = createPool(config.databaseUrl);
  try {
    const owner = await pool.query(
      "SELECT pg_get_userbyid(relowner)=current_user AS allowed FROM pg_class WHERE oid='local_staff_pins'::regclass",
    );
    if (owner.rows[0]?.allowed !== true) throw new Error('OWNER_REQUIRED');
    const events = await runPinBatch({
      pool,
      branchId: config.branchId,
      roster,
      store,
      setStaffPin: local.setStaffPin,
      readPin: (prompt) => hidden.readHiddenPassword(prompt),
      say: (line) => process.stdout.write(line + '\n'),
      log: (event) => console.log(JSON.stringify(event)),
      digits: Number(values.digits),
      replace: values.replace,
      employee: values.employee ?? null,
    });
    console.log(
      JSON.stringify({
        event: 'staff_pin_batch_done',
        saved: events.filter((e) => e.event === 'staff_pin_saved').length,
        skipped: events.filter((e) => e.event === 'staff_pin_skipped').length,
      }),
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    // Never print a PIN, input, credentials or connection strings.
    const code = error instanceof Error ? error.message : '';
    console.error(
      MESSAGES[code] ??
        'Staff PIN batch failed. Use the local protected owner configuration and the roster of this branch. No PIN is printed or saved in a file.',
    );
    process.exitCode = code === 'USAGE' ? 2 : 1;
  });
}
