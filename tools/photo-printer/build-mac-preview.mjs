import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const kiosk = resolve(root, 'apps/kiosk');
const scratch = resolve(kiosk, '.local/photo-mac-app');
const output = resolve(root, '.local/photo-mac-web');
mkdirSync(scratch, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(kiosk, 'package.json'), 'utf8'));
writeFileSync(
  resolve(scratch, 'package.json'),
  JSON.stringify({ ...manifest, name: '@pickchick/photo-mac-preview', main: 'index.tsx' }),
);
writeFileSync(
  resolve(scratch, 'index.tsx'),
  readFileSync(new URL('./mac-app.tsx', import.meta.url), 'utf8').replaceAll(
    '../../apps/kiosk/',
    '../../',
  ),
);
writeFileSync(
  resolve(scratch, 'app.json'),
  JSON.stringify({
    expo: { name: 'PickChick Photo Mac', slug: 'pickchick-photo-mac', web: { bundler: 'metro' } },
  }),
);
if (!existsSync(resolve(scratch, 'node_modules')))
  symlinkSync(resolve(kiosk, 'node_modules'), resolve(scratch, 'node_modules'), 'dir');
execFileSync(
  process.execPath,
  [
    resolve(kiosk, 'node_modules/expo/bin/cli'),
    'export',
    '--platform',
    'web',
    '--output-dir',
    output,
  ],
  {
    cwd: scratch,
    env: {
      ...process.env,
      EXPO_NO_DOTENV: '1',
      EXPO_PUBLIC_KIOSK_COMMERCIAL: '0',
      EXPO_PUBLIC_KIOSK_PHOTO_MAC_PREVIEW: '1',
      EXPO_PUBLIC_KIOSK_PHOTO_URL: '',
    },
    stdio: 'inherit',
  },
);
writeFileSync(
  resolve(output, 'photo-mac-build.json'),
  JSON.stringify({ localOnly: true, entry: 'tools/photo-printer/mac-app.tsx' }),
);
console.log('Isolated camera preview built in .local/photo-mac-web');
