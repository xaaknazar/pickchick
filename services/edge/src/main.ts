import { loadConfig } from '@pickchick/platform';
import { createEdge } from './index.js';

try {
  const config = loadConfig('edge');
  const app = await createEdge(config);
  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
  console.log(JSON.stringify({ event: 'listening', service: 'edge', port: config.port }));
} catch {
  console.error(JSON.stringify({ event: 'startup_failed', service: 'edge' }));
  process.exitCode = 1;
}
