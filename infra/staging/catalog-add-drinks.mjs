#!/usr/bin/env node
/**
 * Guarded owner operation: add the iiko bar drinks that the published catalog of one branch does
 * not sell standalone (reviewed data: catalog-add-drinks.json), optionally also as combo drink
 * choices, through the same back-office catalog API a manager uses. Runbook:
 * docs/operations/catalog-add-drinks-2026-10-12.md
 *
 *   node infra/staging/catalog-add-drinks.mjs --auth staff --username ceo --branch-id <uuid> [--combo-options]
 *   ... --plan-sha256 <hash from the dry-run> --save       draft only (content_reviewed=false)
 *   ... --plan-sha256 <hash from the dry-run> --publish    draft + publication (owner approval)
 *   ... --restore-from <evidence>/published-before.json      rollback: republish a saved version
 *
 * Without --save/--publish nothing is written to the server: the run reads the draft and the
 * publication, prints what customers would see change and a plan hash, and keeps private evidence
 * (.local/catalog-add-drinks, 0600). A write needs that reviewed plan hash; it refuses when the
 * draft, the publication or the data changed since the review, when the draft holds someone
 * else's unpublished edits (unless --accept-draft-changes), and --publish refuses while the data
 * file says "approved_by_owner": false. Concurrent edits are rejected by the API revision check;
 * a local lock stops two writing runs from one checkout. A lost response is retried once with the
 * same request_id (the API replays its receipt), never with a new one.
 *
 * Credentials: --auth staff logs in like the browser (pickchick.kz/backoffice, manager role) with
 * the password from PICKCHICK_BACKOFFICE_PASSWORD or a hidden prompt; --auth token uses the
 * personal catalog bearer (nip.io API) from PICKCHICK_CATALOG_TOKEN, a private --credential-file
 * or a hidden prompt. Passwords, tokens and cookies are never printed or written to evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BarDrinksSpecSchema,
  catalogDigest,
  describeCatalogDiff,
  withBarDrinks,
} from '../../packages/catalog-admin/dist/bar-drinks.js';
import {
  CatalogBranchesSchema,
  CatalogPayloadSchema,
  CatalogStateSchema,
} from '../../packages/catalog-admin/dist/contracts.js';
import { readHiddenPassword } from '../../scripts/hidden-password.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_DATA = path.join(REPO, 'infra/staging/catalog-add-drinks.json');
export const DEFAULT_EVIDENCE = path.join(REPO, '.local/catalog-add-drinks');
export const DEFAULT_BASE = {
  staff: 'https://pickchick.kz',
  token: 'https://pickchick.185.129.51.103.nip.io',
};
export const PLAN_FORMAT = 'pickchick-catalog-add-drinks-plan-v1';
export const SNAPSHOT_FORMAT = 'pickchick-catalog-snapshot-v1';
/** Staff portal JSON_MAX_BYTES (apps/backoffice/server.mjs) is the tightest body limit. */
export const BODY_LIMIT = 300 * 1024 - 4096;
const STAFF_COOKIE = '__Host-pickchick_staff';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[a-f0-9]{64}$/;

export class GuardFailure extends Error {}
export class ApiFailure extends Error {
  constructor(status, code, reason) {
    super(`API ${status} ${code}${reason ? ' ' + reason : ''}`);
    Object.assign(this, { status, code, reason });
  }
}
const guard = (condition, message) => {
  if (!condition) throw new GuardFailure(message);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: OPTIONS }));
  } catch (error) {
    throw new GuardFailure(error.message);
  }
  const args = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k.replace(/-(.)/g, (_, c) => c.toUpperCase()), v]),
  );
  return checked(args);
}
const OPTIONS = {
  'branch-id': { type: 'string' },
  auth: { type: 'string' },
  'base-url': { type: 'string' },
  username: { type: 'string' },
  'credential-file': { type: 'string' },
  data: { type: 'string', default: DEFAULT_DATA },
  'combo-options': { type: 'boolean', default: false },
  'restore-from': { type: 'string' },
  save: { type: 'boolean', default: false },
  publish: { type: 'boolean', default: false },
  'plan-sha256': { type: 'string' },
  'accept-draft-changes': { type: 'boolean', default: false },
  'evidence-dir': { type: 'string', default: DEFAULT_EVIDENCE },
};
function checked(args) {
  guard(UUID.test(args.branchId ?? ''), '--branch-id <uuid> required');
  guard(['staff', 'token'].includes(args.auth), '--auth staff|token required');
  guard(
    args.auth !== 'staff' || /^[a-z][a-z0-9._-]{1,31}$/.test(args.username ?? ''),
    '--username required for --auth staff',
  );
  guard(args.auth === 'token' || !args.credentialFile, '--credential-file is for --auth token');
  guard(!(args.save && args.publish), 'Choose --save or --publish');
  guard(
    !(args.save || args.publish) || /^[a-f0-9]{64}$/.test(args.planSha256 ?? ''),
    'A write needs --plan-sha256 from a reviewed dry-run',
  );
  guard(
    !(args.restoreFrom && args.comboOptions),
    '--combo-options does not apply to --restore-from',
  );
  args.baseUrl ??= DEFAULT_BASE[args.auth];
  let base;
  try {
    base = new URL(args.baseUrl);
  } catch {
    throw new GuardFailure('Invalid --base-url');
  }
  guard(
    base.protocol === 'https:' ||
      (base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)),
    'HTTPS base URL required (plain HTTP only for a local test API)',
  );
  args.mode = args.publish ? 'publish' : args.save ? 'save' : 'dry-run';
  return args;
}

async function privateFile(file, limit) {
  const info = await lstat(file);
  guard(
    info.isFile() && !info.isSymbolicLink() && info.size <= limit,
    `${file}: regular file required`,
  );
  guard((info.mode & 0o077) === 0, `${file}: must be private (chmod 600)`);
  return readFile(file);
}

/** Secret only from the environment, a private credential file or a hidden terminal prompt. */
export async function credentials(args, { env, prompt }) {
  if (args.auth === 'staff') {
    const password =
      env.PICKCHICK_BACKOFFICE_PASSWORD ||
      (await prompt(`Back-office password for ${args.username} (hidden): `).catch(() => ''));
    guard(password, 'No password: set PICKCHICK_BACKOFFICE_PASSWORD or run in a terminal');
    return { kind: 'staff', username: args.username, password };
  }
  let token = env.PICKCHICK_CATALOG_TOKEN;
  if (!token && args.credentialFile) {
    let file;
    try {
      file = JSON.parse((await privateFile(args.credentialFile, 65536)).toString('utf8'));
    } catch (error) {
      if (error instanceof GuardFailure) throw error;
      throw new GuardFailure('Credential file is not readable JSON');
    }
    token = file?.token;
  }
  token ||= await prompt('Catalog manager token (hidden): ').catch(() => '');
  guard(
    TOKEN.test(token ?? ''),
    'No valid catalog token (64 hex): env, --credential-file or prompt',
  );
  return { kind: 'token', token };
}

/** Manager API: the staff portal session (cookie + Origin) or the bearer catalog API. */
export function catalogApi({ base, auth, fetchImpl = fetch, timeoutMs = 20000 }) {
  const origin = new URL(base).origin;
  const prefix = auth.kind === 'staff' ? '/backoffice/api' : '';
  let cookie = null;
  const call = async (method, route, body) => {
    const headers = { Accept: 'application/json' };
    if (auth.kind === 'token') headers.Authorization = `Bearer ${auth.token}`;
    else {
      headers.Origin = origin;
      if (cookie) headers.Cookie = cookie;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(origin + route, {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data;
    try {
      data = text && text.length < 4 * 1024 * 1024 ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok)
      throw new ApiFailure(
        response.status,
        typeof data?.code === 'string' ? data.code : 'HTTP_ERROR',
        typeof data?.error?.code === 'string' ? data.error.code : undefined,
      );
    return { data, response };
  };
  const branch = (id, suffix = '') => `${prefix}/v1/admin/catalog/branches/${id}${suffix}`;
  return {
    async login() {
      if (auth.kind !== 'staff') return;
      let response;
      try {
        ({ response } = await call('POST', '/backoffice/auth/login', {
          username: auth.username,
          password: auth.password,
        }));
      } catch (error) {
        if (error instanceof ApiFailure && error.status === 403)
          throw new GuardFailure('Staff portal refused this Host/Origin; check --base-url');
        throw error;
      } finally {
        auth.password = '';
      }
      const set = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
      const pair = set.map((v) => v.split(';')[0]).find((v) => v.startsWith(STAFF_COOKIE + '='));
      guard(pair && TOKEN.test(pair.slice(STAFF_COOKIE.length + 1)), 'Login returned no session');
      cookie = pair;
    },
    async logout() {
      if (auth.kind !== 'staff' || !cookie) return;
      await call('POST', '/backoffice/auth/logout').catch(() => undefined);
      cookie = null;
    },
    branches: async () =>
      CatalogBranchesSchema.parse((await call('GET', `${prefix}/v1/admin/catalog/branches`)).data),
    state: async (id) => CatalogStateSchema.parse((await call('GET', branch(id))).data),
    save: async (id, body) =>
      CatalogStateSchema.parse((await call('PUT', branch(id, '/draft'), body)).data),
    publish: async (id, body) =>
      CatalogStateSchema.parse((await call('POST', branch(id, '/publish'), body)).data),
    /** Public mobile storefront; no credential is sent. */
    async storefront() {
      const response = await fetchImpl(origin + '/v1/customer-checkout/catalog', {
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok ? response.json() : null;
    },
  };
}

const normal = (payload) => catalogDigest({ ...payload, content_reviewed: false });

/** Pure plan: what will be written and published, and the hash an operator reviews. */
export function planChange({
  state,
  branchId,
  spec,
  specSha256,
  restore,
  restoreSha256,
  comboOptions,
  acceptDraftChanges,
}) {
  const { draft, published } = state;
  guard(
    draft && published,
    'Branch needs an existing draft and publication; use the back-office first',
  );
  let target, changes, warnings, foreign;
  if (restore) {
    target = CatalogPayloadSchema.parse(restore);
    changes = [];
    warnings = [];
    foreign = normal(draft.payload) !== normal(published.payload);
  } else {
    const fromDraft = withBarDrinks(draft.payload, spec, { comboOptions });
    const fromPublished = withBarDrinks(published.payload, spec, { comboOptions });
    target = fromDraft.payload;
    changes = fromPublished.changes;
    warnings = fromDraft.warnings;
    foreign = normal(fromDraft.payload) !== normal(fromPublished.payload);
  }
  const plan = {
    format: PLAN_FORMAT,
    branch_id: branchId,
    operation: restore ? 'restore' : 'add-drinks',
    source_sha256: restore ? restoreSha256 : specSha256,
    combo_options: Boolean(comboOptions),
    accept_draft_changes: Boolean(acceptDraftChanges),
    draft_revision: draft.revision,
    draft_sha256: catalogDigest(draft.payload),
    published_version: published.version,
    published_sha256: catalogDigest(published.payload),
    target_sha256: normal(target),
  };
  return {
    plan,
    planSha256: catalogDigest(plan),
    target,
    changes,
    warnings,
    foreign,
    live: normal(target) === normal(published.payload),
    diff: describeCatalogDiff(published.payload, { ...target, content_reviewed: true }),
    draftDiff: foreign ? describeCatalogDiff(published.payload, draft.payload) : [],
  };
}

async function evidence(root, branchId, mode, now) {
  const stamp = now().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 4);
  const dir = path.join(root, branchId, `${stamp}-${mode}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return {
    dir,
    save: (name, value) =>
      writeFile(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      }),
  };
}

async function readSpec(args) {
  const bytes = await readFile(args.data);
  let spec;
  try {
    spec = BarDrinksSpecSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new GuardFailure(`${args.data}: invalid drinks data`);
  }
  return { spec, specSha256: sha256(bytes) };
}

async function readRestore(args) {
  const bytes = await privateFile(args.restoreFrom, 1024 * 1024);
  const file = JSON.parse(bytes.toString('utf8'));
  guard(
    file?.format === SNAPSHOT_FORMAT && file.branch_id === args.branchId,
    'Restore file is not a snapshot of this branch',
  );
  return {
    restore: CatalogPayloadSchema.parse(file.payload),
    restoreSha256: sha256(bytes),
    restoreVersion: file.version,
  };
}

/** No response, or a gateway timeout: the API may have committed, so only a replay is safe. */
const lost = (error) =>
  ['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name) ||
  (error instanceof ApiFailure && [502, 504].includes(error.status));
/** A lost response is retried once with the same body and request_id; the API replays it. */
async function dispatch(send) {
  try {
    return await send();
  } catch (error) {
    if (!lost(error)) throw error;
    try {
      return await send();
    } catch (retry) {
      if (!lost(retry)) throw retry;
      throw new GuardFailure(
        'Outcome unknown (network). Run the dry-run again before anything else.',
      );
    }
  }
}

function explain(error) {
  if (!(error instanceof ApiFailure)) return error;
  const hints = {
    400: 'API rejected the request (invalid payload).',
    401: 'Login or token rejected.',
    403: 'This account has no manager role for the branch.',
    404: 'Route or branch not found.',
    409: 'Conflict: the draft or publication changed, or publication preconditions failed.',
    413: 'Request too large for the API.',
    429: 'Rate limited; wait 15 minutes.',
    503: 'Catalog editor unavailable.',
  };
  const edge = {
    EDGE_DEVICE_INACTIVE: 'Cashier PC is not active: start it, then dry-run and --publish again.',
    EDGE_MENU_STATE_UNKNOWN: 'Cashier has not reported its menu yet: wait for it, then retry.',
    UNAVAILABLE_LINKED_PRODUCT: 'A combo choice links to a hidden product.',
  };
  return new GuardFailure(
    `${error.message}. ${edge[error.reason] ?? hints[error.status] ?? ''}`.trim(),
  );
}

function report(out, { args, source, state, actor, p, dir }) {
  const support = Object.entries(state.publication_support ?? {}).filter(([, on]) => on);
  out(`Account: ${actor.name}. Branch: ${state.branch.code} ${state.branch.name}.`);
  out(
    `Published version ${state.published.version}; draft revision ${state.draft.revision}; ` +
      `publication reaches: ${support.map(([channel]) => channel).join(', ') || 'not reported'}.`,
  );
  if (args.restoreFrom) out(`Restore of published version ${source.restoreVersion}.`);
  else
    out(
      `Data ${path.relative(REPO, args.data)} sha256 ${source.specSha256.slice(0, 12)}, ` +
        `approved_by_owner=${source.spec.approved_by_owner}, combo choices ${args.comboOptions ? 'on' : 'off'}.`,
    );
  out(
    p.live
      ? 'Customers already see this catalog: nothing to do.'
      : 'After publication customers will see:',
  );
  for (const line of p.diff) out('  ' + line);
  if (p.foreign) {
    out('WARNING: the draft already holds unpublished edits that are not part of this operation:');
    for (const line of p.draftDiff) out('  ' + line);
  }
  for (const line of p.warnings) out('Note: ' + line);
  out(`Plan sha256: ${p.planSha256}`);
  out(`Evidence: ${dir}`);
}

async function apply({ api, args, source, state, p, out, result }) {
  guard(
    args.planSha256 === p.planSha256,
    'Plan changed since review (draft, publication or data); run the dry-run again',
  );
  guard(
    !p.foreign || args.acceptDraftChanges,
    'Draft holds unpublished edits; review them in the back-office or pass --accept-draft-changes after review',
  );
  guard(
    !args.publish || args.restoreFrom || source.spec.approved_by_owner,
    'approved_by_owner is false in the data file: publication refused',
  );
  if (p.live) {
    out('Nothing to do: the publication already matches the plan.');
    return;
  }
  // A saved-only draft stays unreviewed, so nobody publishes it from the back-office by accident.
  const desired = CatalogPayloadSchema.parse({ ...p.target, content_reviewed: args.publish });
  let current = state;
  if (catalogDigest(current.draft.payload) === catalogDigest(desired))
    out('Draft already holds this plan.');
  else {
    const body = {
      expected_revision: current.draft.revision,
      request_id: randomUUID(),
      payload: desired,
    };
    guard(
      Buffer.byteLength(JSON.stringify(body)) <= BODY_LIMIT,
      'Draft too large for the back-office body limit',
    );
    current = await dispatch(() => api.save(args.branchId, body));
    guard(
      catalogDigest(current.draft?.payload) === catalogDigest(desired),
      'Saved draft differs from the plan',
    );
    out(
      `Draft saved: revision ${current.draft.revision}${args.publish ? '' : ' (unreviewed, not published)'}.`,
    );
  }
  result.draft_revision = current.draft.revision;
  if (!args.publish) return;
  const body = {
    expected_revision: current.draft.revision,
    expected_published_version: state.published.version,
    request_id: randomUUID(),
    confirmation: 'publish_catalog',
  };
  current = await dispatch(() => api.publish(args.branchId, body));
  guard(
    current.published?.version === state.published.version + 1 &&
      catalogDigest(current.published.payload) === catalogDigest(desired),
    'Publication differs from the plan; inspect the back-office',
  );
  result.published_version = current.published.version;
  out(`Published version ${current.published.version}.`);
  const after = await api.state(args.branchId);
  if (after.edge_delivery)
    out(
      `Cashier delivery: ${after.edge_delivery.status} (menu ${after.edge_delivery.menu_version}); wait for "applied" in the back-office.`,
    );
  const shop = await api.storefront().catch(() => null);
  out(
    shop?.version === current.published.version
      ? `Mobile storefront serves version ${shop.version}.`
      : 'Mobile storefront not confirmed yet; check it manually.',
  );
}

export async function run(argv, io = {}) {
  const {
    env = process.env,
    out = (line) => process.stdout.write(line + '\n'),
    fetchImpl = fetch,
    prompt = readHiddenPassword,
    now = () => new Date(),
  } = io;
  const args = parse(argv);
  const source = args.restoreFrom ? await readRestore(args) : await readSpec(args);
  const auth = await credentials(args, { env, prompt });
  const api = catalogApi({ base: args.baseUrl, auth, fetchImpl });
  const lock = path.join(args.evidenceDir, '.lock');
  let locked = false;
  try {
    if (args.mode !== 'dry-run') {
      await mkdir(args.evidenceDir, { recursive: true, mode: 0o700 });
      const owner = JSON.stringify({ pid: process.pid, started: now().toISOString() });
      await writeFile(lock, owner, { flag: 'wx', mode: 0o600 }).catch(() => {
        throw new GuardFailure(`Another write is running or crashed: inspect, then remove ${lock}`);
      });
      locked = true;
    }
    await api.login();
    const { actor, branches } = await api.branches();
    guard(
      branches.some((b) => b.id === args.branchId),
      'Branch is not assigned to this account',
    );
    const state = await api.state(args.branchId);
    const p = planChange({
      state,
      branchId: args.branchId,
      comboOptions: args.comboOptions,
      acceptDraftChanges: args.acceptDraftChanges,
      ...source,
    });
    const files = await evidence(args.evidenceDir, args.branchId, args.mode, now);
    await files.save('state-before.json', state);
    await files.save('published-before.json', {
      format: SNAPSHOT_FORMAT,
      branch_id: args.branchId,
      version: state.published.version,
      published_at: state.published.published_at,
      payload: state.published.payload,
    });
    await files.save('plan.json', { ...p, target: undefined, plan_sha256: p.planSha256 });
    report(out, { args, source, state, actor, p, dir: files.dir });
    const result = {
      event: 'catalog_add_drinks',
      mode: args.mode,
      plan_sha256: p.planSha256,
      live: p.live,
      foreign_draft_changes: p.foreign,
      evidence: files.dir,
    };
    if (args.mode === 'dry-run') {
      if (!p.live)
        out(
          'Dry-run only. After review: same command with --plan-sha256 <hash> --publish (or --save).',
        );
      return result;
    }
    await apply({ api, args, source, state, p, out, result });
    await files.save('result.json', result);
    return result;
  } catch (error) {
    throw explain(error);
  } finally {
    await api.logout();
    if (locked) await rm(lock, { force: true });
  }
}

const USAGE = `Usage: node infra/staging/catalog-add-drinks.mjs --auth staff --username <login> | --auth token
  [--credential-file <private json>] --branch-id <uuid> [--combo-options] [--data <json>]
  [--restore-from <published-before.json>] [--save | --publish --plan-sha256 <hash>]
  [--accept-draft-changes] [--base-url <https url>] [--evidence-dir <dir>]
Default is a read-only dry-run. Runbook: docs/operations/catalog-add-drinks-2026-10-12.md`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  if (process.argv.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  run(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      const known =
        error instanceof GuardFailure ||
        error instanceof ApiFailure ||
        error?.name === 'BarDrinksError';
      console.error(
        known
          ? 'Stopped: ' + error.message
          : 'Stopped: unexpected ' + (error?.name ?? 'error') + ': ' + error?.message,
      );
      process.exitCode = 1;
    });
}
