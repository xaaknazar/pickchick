import { loadConfig } from '@pickchick/platform';
import { createApi } from './index.js';

try {
  const config = loadConfig('api');
  const app = await createApi(config);
  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
  console.log(JSON.stringify({ event: 'listening', service: 'api', port: config.port }));
} catch {
  console.error(JSON.stringify({ event: 'startup_failed', service: 'api' }));
  process.exitCode = 1;
}
