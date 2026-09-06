import { BranchSchema, MenuSnapshotSchema } from '@pickchick/contracts';
import type { Branch, MenuSnapshot } from '@pickchick/contracts';

export const API_URL = 'https://pickchick.185.129.51.103.nip.io';
export interface Capabilities {
  schema_version: 1;
  environment: 'staging';
  data_mode: 'synthetic';
  ordering_enabled: false;
  features: Record<'phone_auth' | 'payments' | 'fiscal' | 'checkout' | 'loyalty', false> & {
    test_order_flow?: boolean;
  };
}

export function parseCapabilities(value: unknown): Capabilities {
  if (!value || typeof value !== 'object') throw new Error('Invalid capabilities');
  const c = value as Record<string, unknown>;
  if (
    c.schema_version !== 1 ||
    c.environment !== 'staging' ||
    c.data_mode !== 'synthetic' ||
    c.ordering_enabled !== false ||
    !c.features ||
    typeof c.features !== 'object'
  )
    throw new Error('Unsupported environment');
  const flags = c.features as Record<string, unknown>;
  if (flags.test_order_flow !== undefined && typeof flags.test_order_flow !== 'boolean')
    throw new Error('Unsupported test feature');
  for (const key of ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']) {
    if (flags[key] !== false) throw new Error('Unsupported feature');
  }
  return c as unknown as Capabilities;
}

async function readJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 8000);
  try {
    if (signal?.aborted) throw new Error('Aborted');
    const response = await fetch(`${API_URL}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: timeout.signal,
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
      throw new Error('Service unavailable');
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 2_000_000) throw new Error('Response too large');
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error('Response too large');
    return JSON.parse(body) as unknown;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function loadCatalog(
  branchId: string | null,
  signal?: AbortSignal,
): Promise<{
  capabilities: Capabilities;
  branches: Branch[];
  branch: Branch;
  menu: MenuSnapshot;
}> {
  const [capabilities, response] = await Promise.all([
    readJson('/v1/capabilities', signal).then(parseCapabilities),
    readJson('/v1/branches', signal),
  ]);
  if (
    !response ||
    typeof response !== 'object' ||
    !('branches' in response) ||
    !Array.isArray(response.branches) ||
    response.branches.length > 100
  )
    throw new Error('Invalid branches');
  const branches = response.branches.map((branch: unknown) => BranchSchema.parse(branch));
  if (branches.some((branch) => branch.ordering_enabled)) throw new Error('Unsupported ordering');
  const branch = branches.find((candidate) => candidate.id === branchId) ?? branches[0];
  if (!branch) throw new Error('No branches');
  const menu = MenuSnapshotSchema.parse(await readJson(`/v1/branches/${branch.id}/menu`, signal));
  if (menu.branch_id !== branch.id) throw new Error('Branch mismatch');
  return { capabilities, branches, branch, menu };
}
