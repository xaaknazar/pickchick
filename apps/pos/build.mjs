import { mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MENU_ASSETS } from '../pos-desktop/menu-assets.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const app = fileURLToPath(new URL('./', import.meta.url));
const result = spawnSync(process.execPath, [root + 'node_modules/typescript/bin/tsc', '-p', app], {
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir(new URL('dist/', import.meta.url), { recursive: true });
for (const file of ['index.html', 'styles.css'])
  await copyFile(new URL(`src/${file}`, import.meta.url), new URL(`dist/${file}`, import.meta.url));
await copyFile(
  new URL('../../design/prototype/assets/mockup/logo.png', import.meta.url),
  new URL('dist/logo.png', import.meta.url),
);

await mkdir(new URL('dist/assets/menu/', import.meta.url), { recursive: true });
for (const name of MENU_ASSETS) {
  await copyFile(
    new URL(`../../design/prototype/assets/mockup/${name}`, import.meta.url),
    new URL(`dist/assets/menu/${name}`, import.meta.url),
  );
}
