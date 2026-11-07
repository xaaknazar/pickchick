/**
 * Owner commands of the master runbook (docs/operations/cutover-2026-11-19.md steps 4 and 6,
 * section 9) run on the offline stand the way the operator runs them, never by SQL:
 *
 * - scripts/pos-sales-setup.mjs (status, desk, enable, disable) and scripts/backoffice-setup.mjs
 *   (--role, --accept-restored-z): the real command line in its own Node process. The edge tools
 *   accept only an owner URL without overrides (edgeInstallConfig), so the run schema comes from
 *   PGOPTIONS, which node-postgres reads for every connection; the URL stays the plain local one.
 * - infra/windows/pos-sales-sync-release.mjs: its command line refuses anything but the point's
 *   owner login on 127.0.0.1:55433 (syncReleaseConfig), so the stand calls the same exported
 *   runPosSalesSyncRelease the CLI calls after that check, with the stand's owner pool (as
 *   tests/integration/cutover-sync-release.test.mjs does). The tool's own owner check
 *   (retryPosSalesDelivery: owner of pos_sale_outbox) still runs.
 * Synthetic data only; every connection is the stand's own local database.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import {
  parseSyncReleaseArgs,
  runPosSalesSyncRelease,
} from '../../infra/windows/pos-sales-sync-release.mjs';
import { root, SCHEMA_PATTERN, StandError } from './stand.mjs';

const exec = promisify(execFile);

/** A refusal of an owner command: its code and the JSON it printed (stderr). */
export class OwnerCommandError extends Error {
  constructor(tool, code, output = null) {
    super(`${tool}: ${code}`);
    this.code = code;
    this.tool = tool;
    this.output = output;
  }
}

const baseEnv = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  APP_ENV: 'test',
  NODE_OPTIONS: '--max-old-space-size=256',
});
function schemaOptions(stand) {
  if (!SCHEMA_PATTERN.test(stand.schema)) throw new StandError('UNOWNED_SCHEMA');
  return `-c search_path=${stand.schema}`;
}
/** The owner environment of the stand edge (owner.env on the point). */
export function edgeOwnerEnv(stand) {
  return {
    ...baseEnv(),
    EDGE_DATABASE_URL: stand.edgeAdmin,
    EDGE_BRANCH_ID: stand.ids.branch,
    PGOPTIONS: schemaOptions(stand),
  };
}
/** The cloud database owner of the stand (CLOUD_DATABASE_URL of the owner, not the API role). */
export function cloudOwnerEnv(stand) {
  return { ...baseEnv(), CLOUD_DATABASE_URL: stand.admin.cloud, PGOPTIONS: schemaOptions(stand) };
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
/** One command line; its stdout parsed as JSON, or OwnerCommandError with its refusal. */
async function command(tool, args, env, { json = true } = {}) {
  let stdout;
  try {
    ({ stdout } = await exec(process.execPath, [resolve(root, tool), ...args], {
      cwd: root,
      env,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const output = parse(error.stderr ?? '');
    throw new OwnerCommandError(tool, output?.code ?? 'COMMAND_FAILED', output);
  }
  const result = json ? parse(stdout) : stdout.trim();
  if (json && result === null) throw new OwnerCommandError(tool, 'OUTPUT_NOT_JSON');
  return result;
}

/** `node scripts/pos-sales-setup.mjs <args>` with the stand's edge owner environment. */
export const posSalesSetup = (stand, args) =>
  command('scripts/pos-sales-setup.mjs', args, edgeOwnerEnv(stand));

/** `node scripts/backoffice-setup.mjs <args>` with the stand's cloud owner environment. */
export const backofficeSetup = (stand, args, options) =>
  command('scripts/backoffice-setup.mjs', args, cloudOwnerEnv(stand), options);

/** `pos-sales-sync-release.mjs <args>` after the CLI's own owner check: its one stdout line. */
export async function posSalesSyncRelease(stand, args) {
  const line = await runPosSalesSyncRelease(parseSyncReleaseArgs(args), {
    pool: stand.edge,
    branchId: stand.ids.branch,
  });
  if (typeof line !== 'string' || line.includes('\n'))
    throw new OwnerCommandError('pos-sales-sync-release', 'OUTPUT_NOT_ONE_LINE');
  return JSON.parse(line);
}

/**
 * The parked Z exactly as the cash desk sends it, with its payload_hash: the query of
 * export-z.sql in docs/operations/backoffice-cutover.md «Принять Z смены, открытой во время
 * восстановления» п. 1 (read only; the operator runs it with psql).
 */
export async function exportParkedZ(stand, eventId) {
  return (
    await stand.edge.query(
      `SELECT json_build_object('event_id', event_id, 'branch_id', branch_id,
         'sequence', sequence::text, 'kind', kind,
         'occurred_at', to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'payload', payload, 'payload_hash', payload_hash) AS row
       FROM pos_sale_outbox
       WHERE event_id = $1 AND kind = 'shift_report' AND acknowledged_at IS NULL
         AND last_error = 'rejected:INVALID_EVENT'`,
      [eventId],
    )
  ).rows[0]?.row;
}
