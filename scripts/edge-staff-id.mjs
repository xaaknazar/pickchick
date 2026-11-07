#!/usr/bin/env node
// Edge staff id of a back-office employee (lane bo-ui, design-bo-ui.md 5.7; runbook
// docs/operations/backoffice-p1-cutover.md «Касса в бэк-офисе»).
//
// The cashier edge and the cloud know cashiers only by uuid. Give the edge account the id this
// tool prints and «Касса» in the back office names the person (cashier, approver, who recorded a
// Webkassa number). The id is pure computation (no database, no network); only --list reads the
// employee cards of the cloud database (one SELECT). Nothing is ever written.
//
//   node scripts/edge-staff-id.mjs --employee <uuid> --role cashier|shift_manager|kitchen
//     -> {"employee_id","role","staff_id"}
//   node scripts/edge-staff-id.mjs --employee <uuid> --role <role> --terminal <uuid> --name <text>
//     -> the StaffSetupSchema JSON for scripts/staff-setup.mjs (staff_id, terminal_id, name, role)
//   CLOUD_DATABASE_URL=... node scripts/edge-staff-id.mjs --list --branch <uuid>
//     -> every employee card of the branch with its three edge ids (read only, one SELECT)
//
// The employee id is the id of the card in the back office «Сотрудники» (--list prints them).
// Same bytes as edgeStaffId in packages/backoffice-core/src/edge-staff.ts; EDGE_STAFF_ID_VECTOR
// there pins both (tests/backoffice/edge-staff-id.test.mjs).
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ROLES = Object.freeze(['cashier', 'shift_manager', 'kitchen']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function edgeStaffId(employeeId, role) {
  if (typeof employeeId !== 'string' || !UUID.test(employeeId)) throw new Error('INVALID_EMPLOYEE');
  if (!ROLES.includes(role)) throw new Error('INVALID_ROLE');
  const hash = createHash('sha256')
    .update(`pickchick-edge-staff-v1:${employeeId.toLowerCase()}:${role}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hash[12] = '8';
  hash[16] = (8 | (parseInt(hash[16], 16) & 3)).toString(16);
  const h = hash.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const USAGE =
  'Usage: node scripts/edge-staff-id.mjs --employee UUID --role cashier|shift_manager|kitchen' +
  ' [--terminal UUID --name TEXT]\n   or: node scripts/edge-staff-id.mjs --list --branch UUID' +
  ' (CLOUD_DATABASE_URL)';

/** The employee cards of a branch (bo_records kind employee) with their edge ids. */
export function rosterRows(employees) {
  return employees.map((e) => ({
    employee_id: e.id.toLowerCase(),
    name: e.name,
    card_role: e.role ?? null,
    active: e.active !== false && e.deleted !== true,
    ...Object.fromEntries(ROLES.map((role) => [role, edgeStaffId(e.id, role)])),
  }));
}
async function list(branch) {
  if (!UUID.test(branch ?? '')) throw new Error(USAGE);
  const url = process.env.CLOUD_DATABASE_URL;
  if (!url) throw new Error('CLOUD_DATABASE_URL required');
  const { createPool } = await import('@pickchick/database');
  const pool = createPool(url);
  try {
    const rows = (
      await pool.query(
        `SELECT id::text AS id,payload->>'name' AS name,payload->>'role' AS role,
           (payload->>'active')::boolean AS active,(payload->>'deleted')::boolean AS deleted
         FROM bo_records WHERE branch_id=$1 AND kind='employee' ORDER BY payload->>'name',id`,
        [branch],
      )
    ).rows;
    return rosterRows(rows);
  } finally {
    await pool.end();
  }
}

export function run(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--employee', '--role', '--terminal', '--name'].includes(key) || args.has(key))
      throw new Error(USAGE);
    if (argv[i + 1] === undefined) throw new Error(USAGE);
    args.set(key, argv[i + 1]);
  }
  const employee = args.get('--employee');
  const role = args.get('--role');
  if (!employee || !role) throw new Error(USAGE);
  const staffId = edgeStaffId(employee, role);
  if (!args.has('--terminal') && !args.has('--name'))
    return { employee_id: employee.toLowerCase(), role, staff_id: staffId };
  const terminal = args.get('--terminal');
  const name = (args.get('--name') ?? '').trim();
  if (!terminal || !UUID.test(terminal)) throw new Error('INVALID_TERMINAL');
  if (name.length < 1 || name.length > 100) throw new Error('INVALID_NAME');
  // Exactly the StaffSetupSchema keys of packages/contracts (staff-setup.mjs input).
  return { staff_id: staffId, terminal_id: terminal.toLowerCase(), name, role };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === '--list') {
      if (argv.length !== 3 || argv[1] !== '--branch') throw new Error(USAGE);
      for (const row of await list(argv[2])) console.log(JSON.stringify(row));
    } else console.log(JSON.stringify(run(argv)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : USAGE);
    process.exitCode = 2;
  }
}
