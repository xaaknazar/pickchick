import { loadConfig } from '@pickchick/platform';
import { createEdge } from './index.js';

try {
  const config = loadConfig('edge');
  const app = await createEdge(config);
  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
  console.log(JSON.stringify({ event: 'listening', service: 'edge', port: config.port }));
} catch (error) {
  // The class and driver/system code only (e.g. ECONNREFUSED, 28P01): never the message, which
  // can carry a connection string or a secret.
  const failure = error as { name?: unknown; code?: unknown } | null;
  console.error(
    JSON.stringify({
      event: 'startup_failed',
      service: 'edge',
      error: typeof failure?.name === 'string' ? failure.name.slice(0, 60) : 'unknown',
      ...(typeof failure?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(failure.code)
        ? { code: failure.code }
        : {}),
    }),
  );
  process.exitCode = 1;
}
