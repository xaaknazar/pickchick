// GET /health/ready exactly like the compose healthcheck; only enum dependency states are kept.

const DEPENDENCY_STATES = ['up', 'down', 'not_required'];

function dependencies(body) {
  const source = body?.dependencies ?? body?.message?.dependencies;
  if (!source || typeof source !== 'object') return null;
  const result = {};
  for (const name of ['database', 'schema', 'redis'])
    if (DEPENDENCY_STATES.includes(source[name])) result[name] = source[name];
  return Object.keys(result).length ? result : null;
}

export async function probeApi(url, fetcher = fetch, timeoutMs = 5000) {
  try {
    const response = await fetcher(url, {
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response
      .text()
      .then((text) => (text.length <= 16_384 ? JSON.parse(text) : null))
      .catch(() => null);
    return {
      ok: response.status === 200 && body?.ready === true,
      status: response.status,
      error: null,
      dependencies: dependencies(body),
    };
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      status: null,
      error: timeout ? 'timeout' : 'unreachable',
      dependencies: null,
    };
  }
}
