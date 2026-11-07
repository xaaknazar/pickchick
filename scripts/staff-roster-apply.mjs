#!/usr/bin/env node
// Cashier staff of the branch server from the back-office roster (lane bo-ui step 6,
// design-bo-ui.md 5.7; runbook docs/operations/backoffice-p1-cutover.md «Состав кассы»).
//
// The manager downloads the roster in the back office («Сотрудники» -> «Выгрузить состав для
// кассы», GET .../ops/staff-roster). On the branch server the operator runs:
//
//   node scripts/staff-roster-apply.mjs --file roster.json [--terminal UUID]
//     -> the plan (dry run, nothing is written) and its sha256
//   node scripts/staff-roster-apply.mjs --file roster.json [--terminal UUID] --apply --expected-plan H
//     -> applies exactly that plan: refused when the database or the roster changed since
//
// Only the existing operator functions of packages/local-orders write (provisionStaff,
// revokeStaff), as scripts/staff-setup.mjs and staff-revoke.mjs do:
// - a card with cashier access gets the edge account edgeStaffId(employee, role) (the id the
//   back office names in «Касса»); the account gets a bootstrap session on --terminal and its
//   credential file .local/staff-<id>.json (0600, never printed) for staff-pin-batch.mjs;
// - a role is never changed in place (staff.ts refuses it): a new role revokes the old account
//   and provisions the account of the new role;
// - a card without access, not working or removed has its accounts revoked;
// - an account revoked earlier cannot be re-activated by the operator functions: it is reported
//   as blocked (CR bo-ui-6) and nothing is done for it;
// - accounts that are not edge ids of a roster card (the shared kitchen login, accounts set up
//   by hand) are listed and never touched.
// Nothing is printed that is a secret: no token, no PIN, no connection string.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { edgeStaffId } from './edge-staff-id.mjs';

export const ROSTER_ROLES = Object.freeze(['cashier', 'shift_manager']);
const ACCESS = Object.freeze(['none', 'cashier', 'shift_manager']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const ROSTER_KEYS = [
  'schema_version',
  'branch_id',
  'generated_at',
  'positions_version',
  'staff',
  'sha256',
];
const ENTRY_KEYS = [
  'employee_id',
  'name',
  'position_code',
  'pos_access',
  'role',
  'edge_staff_id',
  'active',
];
export const MAX_ROSTER_BYTES = 1_000_000;

const sameKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
/** Same bytes as rosterCanonical in packages/backoffice-core/src/positions.ts (tests pin it). */
export function rosterDigest(branch, staff) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema_version: 1,
        branch_id: branch,
        staff: staff.map((s) => ({
          employee_id: s.employee_id,
          name: s.name,
          position_code: s.position_code,
          pos_access: s.pos_access,
          role: s.role,
          edge_staff_id: s.edge_staff_id,
          active: s.active,
        })),
      }),
    )
    .digest('hex');
}
/**
 * The roster file as the back office wrote it, for this branch: exact keys, the edge ids
 * recomputed, the sha256 of the content. Throws a short error code, never the input.
 */
export function readRoster(value, branchId) {
  if (!sameKeys(value, ROSTER_KEYS) || value.schema_version !== 1) throw new Error('ROSTER_FORMAT');
  if (
    !UUID.test(String(value.branch_id)) ||
    !Array.isArray(value.staff) ||
    value.staff.length > 1000
  )
    throw new Error('ROSTER_FORMAT');
  if (String(value.branch_id).toLowerCase() !== String(branchId).toLowerCase())
    throw new Error('ROSTER_OTHER_BRANCH');
  const seen = new Set();
  for (const s of value.staff) {
    if (
      !sameKeys(s, ENTRY_KEYS) ||
      !UUID.test(String(s.employee_id)) ||
      s.employee_id !== s.employee_id.toLowerCase() ||
      seen.has(s.employee_id) ||
      typeof s.name !== 'string' ||
      !s.name.trim() ||
      s.name.length > 200 ||
      !(s.position_code === null || typeof s.position_code === 'string') ||
      !ACCESS.includes(s.pos_access) ||
      typeof s.active !== 'boolean' ||
      !(s.role === null || ROSTER_ROLES.includes(s.role)) ||
      (s.role !== null && (!s.active || s.role !== s.pos_access)) ||
      s.edge_staff_id !== (s.role ? edgeStaffId(s.employee_id, s.role) : null)
    )
      throw new Error('ROSTER_FORMAT');
    seen.add(s.employee_id);
  }
  if (
    !SHA.test(String(value.sha256)) ||
    rosterDigest(value.branch_id, value.staff) !== value.sha256
  )
    throw new Error('ROSTER_DIGEST');
  return value;
}

/** The edge accounts of the branch (operator owner connection, read only). */
export async function readLocalStaff(pool, branchId) {
  return (
    await pool.query(
      'SELECT id::text AS id,role,active,name FROM local_staff WHERE branch_id=$1 ORDER BY id',
      [branchId],
    )
  ).rows;
}
const edgeName = (name) => name.trim().slice(0, 100).trim();
const byId = (a, b) => a.staff_id.localeCompare(b.staff_id);
/**
 * The plan of the roster against the edge accounts: what to revoke and provision, what stays,
 * what is blocked and what is not managed by the roster. Deterministic, so its hash names it.
 */
export function planRoster(roster, local, terminalId = null) {
  const accounts = new Map(local.map((s) => [s.id.toLowerCase(), s]));
  const managed = new Set();
  const revoke = [],
    provision = [],
    keep = [],
    blocked = [];
  for (const s of roster.staff) {
    for (const role of ROSTER_ROLES) {
      const id = edgeStaffId(s.employee_id, role);
      managed.add(id);
      const account = accounts.get(id);
      const wanted = s.role === role;
      const entry = { staff_id: id, employee_id: s.employee_id, role, name: edgeName(s.name) };
      if (wanted && !account) provision.push(entry);
      else if (wanted && !account.active) blocked.push({ ...entry, reason: 'revoked_earlier' });
      else if (wanted)
        keep.push({
          ...entry,
          name_on_edge: account.name,
          name_differs: account.name !== entry.name,
        });
      else if (account?.active) revoke.push(entry);
    }
  }
  const unmanaged = local
    .filter((s) => !managed.has(s.id.toLowerCase()))
    .map((s) => ({ staff_id: s.id.toLowerCase(), role: s.role, active: s.active }))
    .sort(byId);
  return {
    schema_version: 1,
    branch_id: roster.branch_id,
    roster_sha256: roster.sha256,
    terminal_id: provision.length ? (terminalId ? terminalId.toLowerCase() : null) : null,
    revoke: revoke.sort(byId),
    provision: provision.sort(byId),
    keep: keep.sort(byId),
    blocked: blocked.sort(byId),
    unmanaged,
  };
}
export const planHash = (plan) => createHash('sha256').update(JSON.stringify(plan)).digest('hex');

/**
 * Applies the plan `expected` names, recomputed now (a changed database or roster is refused):
 * revokes first, then provisions with a bootstrap session and its private credential file.
 * `store` is the credential store of scripts/staff-credential.mjs; `log` gets one event per step.
 */
export async function applyRoster({
  pool,
  branchId,
  roster,
  terminal = null,
  expected,
  store,
  log = () => {},
  provisionStaff,
  revokeStaff,
}) {
  const plan = planRoster(roster, await readLocalStaff(pool, branchId), terminal);
  if (!SHA.test(String(expected)) || planHash(plan) !== expected) throw new Error('PLAN_CHANGED');
  if (plan.provision.length) {
    if (!plan.terminal_id || !UUID.test(plan.terminal_id)) throw new Error('TERMINAL_REQUIRED');
    const known = await pool.query(
      'SELECT 1 FROM local_terminals WHERE id=$1 AND branch_id=$2 AND active',
      [plan.terminal_id, branchId],
    );
    if (!known.rowCount) throw new Error('TERMINAL_UNKNOWN');
  }
  for (const r of plan.revoke) {
    await revokeStaff(pool, branchId, r.staff_id);
    log({ event: 'staff_revoked', staff_id: r.staff_id, role: r.role });
  }
  for (const p of plan.provision) {
    await store.prepareStaffFile(p.staff_id, false);
    const credential = await provisionStaff(pool, branchId, {
      staff_id: p.staff_id,
      terminal_id: plan.terminal_id,
      name: p.name,
      role: p.role,
    });
    await store.saveStaffCredential(credential);
    log({
      event: 'staff_session_saved',
      staff_id: credential.staff_id,
      role: credential.role,
      expires_at: credential.expires_at,
      file: `.local/staff-${credential.staff_id}.json`,
    });
  }
  return {
    revoked: plan.revoke.length,
    provisioned: plan.provision.length,
    blocked: plan.blocked.length,
  };
}

/** Reads the bounded roster file. */
export async function readRosterFile(file, branchId) {
  if (!file || (await stat(file)).size > MAX_ROSTER_BYTES) throw new Error('ROSTER_FORMAT');
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error('ROSTER_FORMAT');
  }
  return readRoster(value, branchId);
}

const MESSAGES = {
  ROSTER_FORMAT: 'The roster file is not a back-office roster (download it again).',
  ROSTER_DIGEST: 'The roster file was changed after the download (sha256 differs).',
  ROSTER_OTHER_BRANCH: 'The roster belongs to another branch.',
  PLAN_CHANGED: 'The plan changed since the dry run: run it again and check the new plan.',
  TERMINAL_REQUIRED: 'New accounts need --terminal (the cash desk where they set their PIN).',
  TERMINAL_UNKNOWN: 'The terminal is not an active terminal of this branch.',
  USAGE:
    'Usage: node scripts/staff-roster-apply.mjs --file roster.json [--terminal UUID] [--apply --expected-plan SHA256]',
};
async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      terminal: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'expected-plan': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.file || values.apply !== Boolean(values['expected-plan'])) throw new Error('USAGE');
  if (values.terminal && !UUID.test(values.terminal)) throw new Error('USAGE');
  const [{ createPool }, { loadConfig }, local, store] = await Promise.all([
    import('@pickchick/database'),
    import('@pickchick/platform'),
    import('@pickchick/local-orders'),
    import('./staff-credential.mjs'),
  ]);
  const config = loadConfig('edge');
  const roster = await readRosterFile(values.file, config.branchId);
  const pool = createPool(config.databaseUrl);
  try {
    if (!values.apply) {
      const plan = planRoster(roster, await readLocalStaff(pool, config.branchId), values.terminal);
      console.log(
        JSON.stringify(
          {
            event: 'staff_roster_plan',
            plan_sha256: planHash(plan),
            ...plan,
            ...(plan.provision.length && !plan.terminal_id
              ? { note: 'Add --terminal UUID before applying: new accounts need it.' }
              : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    const result = await applyRoster({
      pool,
      branchId: config.branchId,
      roster,
      terminal: values.terminal ?? null,
      expected: values['expected-plan'],
      store,
      log: (event) => console.log(JSON.stringify(event)),
      provisionStaff: local.provisionStaff,
      revokeStaff: local.revokeStaff,
    });
    console.log(JSON.stringify({ event: 'staff_roster_applied', ...result }));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    // Never print input, credentials or connection strings: a fixed message per error code.
    const code = error instanceof Error ? error.message : '';
    console.error(
      MESSAGES[code] ??
        'Staff roster failed. Check the local edge configuration, the roster file and the plan. Nothing secret is printed.',
    );
    process.exitCode = code === 'USAGE' ? 2 : 1;
  });
}
