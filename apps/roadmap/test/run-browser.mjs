import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRoadmapServer } from '../server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'roadmap-browser-'));
const keyFile = join(directory, 'key.txt');
const key = randomBytes(32).toString('base64url');
await writeFile(keyFile, key, { mode: 0o600 });
const port = Number(process.env.ROADMAP_TEST_PORT ?? 4191);
const server = await createRoadmapServer({
  dataDir: join(directory, 'data'),
  key,
  origin: `http://127.0.0.1:${port}`,
});
try {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(
    process.env.ROADMAP_TEST_PYTHON ?? 'python3',
    [new URL('browser.py', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        ROADMAP_TEST_URL: `http://127.0.0.1:${port}/roadmap/`,
        ROADMAP_TEST_KEY_FILE: keyFile,
      },
      stdio: 'inherit',
    },
  );
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
