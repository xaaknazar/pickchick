import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative } from 'node:path';

const run = promisify(execFile);
export class HarnessError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const safeCode = (e) =>
  typeof e?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.code)
    ? e.code
    : e instanceof assert.AssertionError
      ? 'ASSERTION_FAILED'
      : 'HARNESS_ERROR';
export const defaults = {
  cloud: 'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud',
  edge: 'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge',
};
export function checkedUrl(raw, kind) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HarnessError('UNSAFE_DATABASE_URL');
  }
  if (
    !['cloud', 'edge'].includes(kind) ||
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    u.hostname !== '127.0.0.1' ||
    u.port !== (kind === 'cloud' ? '55432' : '55433') ||
    u.pathname !== `/pickchick_${kind}` ||
    u.username !== 'pickchick_local' ||
    !u.password ||
    u.search ||
    u.hash
  )
    throw new HarnessError('UNSAFE_DATABASE_URL');
  return u;
}
export function checkedSchema(name) {
  if (!/^ftcap_[a-f0-9]{32}_(?:cloud|edge_[0-9])$/.test(name))
    throw new HarnessError('UNOWNED_SCHEMA');
  return name;
}
export function scopedUrl(raw, kind, schema) {
  const u = checkedUrl(raw, kind);
  u.searchParams.set('options', `-c search_path=${checkedSchema(schema)}`);
  return u.toString();
}
export function parseArgs(argv, root) {
  const result = { quick: false, selfTest: false, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--quick') result.quick = true;
    else if (argv[i] === '--self-test') result.selfTest = true;
    else if (argv[i] === '--output') {
      const output = resolve(root, argv[++i] ?? '');
      if (
        !/^(tests\/load\/results|\.local\/capacity)\/[a-zA-Z0-9._-]+\.json$/.test(
          relative(root, output),
        )
      )
        throw new HarnessError('INVALID_OUTPUT');
      result.output = output;
    } else throw new HarnessError('INVALID_ARGUMENT');
  }
  return result;
}
export async function command(binary, args, cwd) {
  try {
    return (await run(binary, args, { cwd, timeout: 15000, maxBuffer: 1048576 })).stdout.trim();
  } catch {
    throw new HarnessError('LOCAL_TOOL_FAILED');
  }
}
/** Prove that both TCP listeners are the expected local Compose PostgreSQL servers.
 * Never inspect environment variables or Docker Config.Env; no credentials in output.
 */
export async function dockerProof() {
  if (process.env.DOCKER_HOST && !/^(unix:\/\/|npipe:\/\/)/.test(process.env.DOCKER_HOST))
    throw new HarnessError('REMOTE_DOCKER_FORBIDDEN');
  const context = await command('docker', ['context', 'show']);
  const endpoint = JSON.parse(
    await command('docker', [
      'context',
      'inspect',
      context,
      '--format',
      '{{json .Endpoints.docker.Host}}',
    ]),
  );
  if (!/^(unix:\/\/|npipe:\/\/)/.test(endpoint)) throw new HarnessError('REMOTE_DOCKER_FORBIDDEN');
  const result = {};
  for (const kind of ['cloud', 'edge']) {
    const ids = (
      await command('docker', [
        'ps',
        '--filter',
        'label=com.docker.compose.project=pickchick-local',
        '--filter',
        `label=com.docker.compose.service=${kind}-db`,
        '--format',
        '{{.ID}}',
      ])
    )
      .split('\n')
      .filter(Boolean);
    if (ids.length !== 1 || !/^[a-f0-9]+$/.test(ids[0]))
      throw new HarnessError('LOCAL_COMPOSE_REQUIRED');
    const ports = JSON.parse(
      await command('docker', ['inspect', ids[0], '--format', '{{json .NetworkSettings.Ports}}']),
    );
    if (
      !ports['5432/tcp']?.some(
        (p) => p.HostIp === '127.0.0.1' && p.HostPort === (kind === 'cloud' ? '55432' : '55433'),
      )
    )
      throw new HarnessError('LOCAL_BINDING_MISMATCH');
    const systemId = await command('docker', [
      'exec',
      ids[0],
      'psql',
      '-U',
      'pickchick_local',
      '-d',
      `pickchick_${kind}`,
      '-At',
      '-c',
      'SELECT system_identifier FROM pg_control_system()',
    ]);
    if (!/^\d+$/.test(systemId)) throw new HarnessError('LOCAL_IDENTITY_UNAVAILABLE');
    result[kind] = {
      systemId,
      image: await command('docker', ['inspect', ids[0], '--format', '{{.Image}}']),
    };
  }
  return result;
}
export function quantiles(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return Object.fromEntries([
    ['count', s.length],
    ...[0.5, 0.95, 0.99, 1].map((p) => [
      p === 1 ? 'max_ms' : `p${p * 100}_ms`,
      s.length ? Math.round(s[Math.ceil(p * s.length) - 1] * 1000) / 1000 : null,
    ]),
  ]);
}
export async function boundedMap(items, concurrency, op) {
  let index = 0,
    error;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!error && index < items.length) {
        const item = items[index++];
        try {
          await op(item);
        } catch (e) {
          error ??= e;
        }
      }
    }),
  );
  if (error) throw error;
}
