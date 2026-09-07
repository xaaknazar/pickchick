import { mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const result = spawnSync(
  process.execPath,
  [root + 'node_modules/typescript/bin/tsc', '-p', fileURLToPath(new URL('./', import.meta.url))],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir(new URL('dist/', import.meta.url), { recursive: true });
for (const name of ['index.html', 'styles.css'])
  await copyFile(new URL('src/' + name, import.meta.url), new URL('dist/' + name, import.meta.url));
for (const name of [
  'logo.png',
  'bg-blue.png',
  'fonts/golos-text-2f175b8fc40e.woff2',
  'fonts/golos-text-f8d71091110f.woff2',
  'fonts/montserrat-6438d7b8ea9c.woff2',
  'fonts/montserrat-0b00fbd6edcc.woff2',
]) {
  await mkdir(new URL('dist/fonts/', import.meta.url), { recursive: true });
  await copyFile(
    new URL('../../design/prototype/assets/mockup/' + name, import.meta.url),
    new URL('dist/' + name, import.meta.url),
  );
}
