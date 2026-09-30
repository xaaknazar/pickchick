import { BranchSchema, MenuSnapshotSchema } from '@pickchick/contracts';
import { TestCatalogSchema } from '@pickchick/test-order-flow/contracts';
import type { Branch, MenuSnapshot } from '@pickchick/contracts';

export const API_URL = 'https://pickchick.185.129.51.103.nip.io';
export interface Capabilities {
  schema_version: 1;
  environment: 'staging';
  data_mode: 'synthetic' | 'pilot';
  ordering_enabled: false;
  features: Record<'payments' | 'fiscal' | 'checkout' | 'loyalty', false> & {
    phone_auth: boolean;
    test_order_flow?: boolean;
    unpaid_test_orders?: boolean;
  };
}

export function parseCapabilities(value: unknown): Capabilities {
  if (!value || typeof value !== 'object') throw new Error('Invalid capabilities');
  const c = value as Record<string, unknown>;
  if (
    c.schema_version !== 1 ||
    c.environment !== 'staging' ||
    !['synthetic', 'pilot'].includes(String(c.data_mode)) ||
    c.ordering_enabled !== false ||
    !c.features ||
    typeof c.features !== 'object'
  )
    throw new Error('Unsupported environment');
  const flags = c.features as Record<string, unknown>;
  if (flags.test_order_flow !== undefined && typeof flags.test_order_flow !== 'boolean')
    throw new Error('Unsupported test feature');
  for (const key of ['payments', 'fiscal', 'checkout', 'loyalty']) {
    if (flags[key] !== false) throw new Error('Unsupported feature');
  }
  if (flags.phone_auth !== (c.data_mode === 'pilot')) throw new Error('Invalid identity mode');
  return c as unknown as Capabilities;
}

export class CatalogRequestError extends Error {
  readonly retryable: boolean;

  constructor(reason: 'transport' | 'http' | 'invalid_response', status?: number) {
    super(`Catalog ${reason}${status === undefined ? '' : ` (${status})`}`);
    this.name = 'CatalogRequestError';
    this.retryable =
      reason === 'transport' ||
      (reason === 'http' && (status === 408 || status === 429 || (status ?? 0) >= 500));
  }
}

export function isRetryableCatalogError(error: unknown): boolean {
  return error instanceof CatalogRequestError && error.retryable;
}

async function readCatalogJson(
  path: string,
  signal?: AbortSignal,
  timeoutMs = 8000,
): Promise<unknown> {
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    if (signal?.aborted) throw new Error('Aborted');
    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: timeout.signal,
        credentials: 'omit',
        redirect: 'error',
      });
    } catch {
      throw new CatalogRequestError('transport');
    }
    if (!response.ok) throw new CatalogRequestError('http', response.status);
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new CatalogRequestError('invalid_response');
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 2_000_000) throw new CatalogRequestError('invalid_response');
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new CatalogRequestError('transport');
    }
    if (body.length > 2_000_000) throw new CatalogRequestError('invalid_response');
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new CatalogRequestError('invalid_response');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function loadTestCatalog(signal?: AbortSignal) {
  return TestCatalogSchema.parse(
    await readCatalogJson('/v1/test/catalog?catalog_version=mockup-v0.3', signal, 10_000),
  );
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
  // Wait for both bounded reads to settle before permitting a retry. A quick
  // failure of one endpoint must not leave its sibling running in the next attempt.
  const [capabilitiesResult, branchesResult] = await Promise.allSettled([
    readCatalogJson('/v1/capabilities', signal).then(parseCapabilities),
    readCatalogJson('/v1/branches', signal),
  ]);
  if (capabilitiesResult.status === 'rejected') throw capabilitiesResult.reason;
  if (branchesResult.status === 'rejected') throw branchesResult.reason;
  const capabilities = capabilitiesResult.value;
  const response = branchesResult.value;
  if (
    !response ||
    typeof response !== 'object' ||
    !('branches' in response) ||
    !Array.isArray(response.branches) ||
    response.branches.length > 100
  )
    throw new Error('Invalid branches');
  // This public catalog remains the read-only storefront. A separately enabled
  // payment branch must not invalidate it or replace its menu. Authenticated
  // checkout resolves its own server-approved branch/account independently.
  const branches = response.branches
    .map((branch: unknown) => BranchSchema.parse(branch))
    .filter((branch: Branch) => !branch.ordering_enabled);
  const branch = branches.find((candidate) => candidate.id === branchId) ?? branches[0];
  if (!branch) throw new Error('No branches');
  const menu = MenuSnapshotSchema.parse(
    await readCatalogJson(`/v1/branches/${branch.id}/menu`, signal),
  );
  if (menu.branch_id !== branch.id) throw new Error('Branch mismatch');
  return { capabilities, branches, branch, menu };
}
