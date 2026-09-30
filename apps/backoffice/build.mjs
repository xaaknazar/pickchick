import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const app = fileURLToPath(new URL('./', import.meta.url));
const result = spawnSync(process.execPath, [root + 'node_modules/typescript/bin/tsc', '-p', app], {
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir(new URL('dist/assets/', import.meta.url), { recursive: true });
for (const file of ['index.html', 'styles.css'])
  await copyFile(new URL(`src/${file}`, import.meta.url), new URL(`dist/${file}`, import.meta.url));
for (const file of ['logo.png', 'shot.jpg', ...Array.from({ length: 24 }, (_, i) => `i${i}.jpg`)]) {
  // The repository does not contain every numbered photo; only actual assets are shipped.
  try {
    await copyFile(
      new URL(`../../design/prototype/assets/mockup/${file}`, import.meta.url),
      new URL(`dist/assets/${file}`, import.meta.url),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const sourceFonts = await readFile(
  new URL('../../design/prototype/reference-fonts.css', import.meta.url),
  'utf8',
);
const interFaces = [
  ...sourceFonts.matchAll(/@font-face\s*\{[^}]*font-family: 'Inter';[^}]*\}/g),
].map((m) => m[0]);
if (!interFaces.length) throw new Error('Inter font sources missing');
await mkdir(new URL('dist/assets/fonts/', import.meta.url), { recursive: true });
await writeFile(
  new URL('dist/fonts.css', import.meta.url),
  interFaces.join('\n').replaceAll('/design/prototype/assets/mockup/fonts/', './assets/fonts/'),
);
for (const name of new Set(
  interFaces.flatMap((face) => [...face.matchAll(/(inter-[a-f0-9]+\.woff2)/g)].map((m) => m[1])),
))
  await copyFile(
    new URL('../../design/prototype/assets/mockup/fonts/' + name, import.meta.url),
    new URL('dist/assets/fonts/' + name, import.meta.url),
  );
