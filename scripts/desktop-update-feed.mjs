// Lays out the update feed of one desktop client (docs/operations/desktop-updates.md):
//   <out>/<app>/<installer>   then   <out>/<app>/latest.json
// node scripts/desktop-update-feed.mjs --app pos|kitchen --installer <Setup.exe> --out <dir> [--apply idle|now]
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS, parseManifest } from '../apps/pos-desktop/updater.mjs';

const PACKAGES = { pos: 'apps/pos-desktop', kitchen: 'apps/kitchen-desktop' };

/** Copies the installer and writes the manifest the installed clients accept. */
export function writeFeed({ app, installer, out, apply = 'idle' }) {
  if (!Object.hasOwn(APPS, app)) throw new Error('Unknown --app: pos or kitchen');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { version } = JSON.parse(readFileSync(join(root, PACKAGES[app], 'package.json'), 'utf8'));
  const file = `${APPS[app]}${version}-x64.exe`;
  if (basename(installer) !== file)
    throw new Error(`The installer of this checkout is ${file}, not ${basename(installer)}`);
  const data = readFileSync(installer);
  if (data.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a Windows executable');
  const manifest = {
    app,
    version,
    file,
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.byteLength,
    apply,
  };
  const text = JSON.stringify(manifest, null, 2) + '\n';
  // The same check the installed client makes: a manifest it would refuse is never written.
  parseManifest(text, app);
  const directory = join(resolve(out), app);
  mkdirSync(directory, { recursive: true });
  copyFileSync(installer, join(directory, file));
  // The manifest appears last and at once: a client never reads half of it or a missing file.
  writeFileSync(join(directory, 'latest.json.tmp'), text);
  renameSync(join(directory, 'latest.json.tmp'), join(directory, 'latest.json'));
  return { directory, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    if (!['--app', '--installer', '--out', '--apply'].includes(name) || !process.argv[i + 1]) {
      console.error(
        'Usage: node scripts/desktop-update-feed.mjs --app pos|kitchen --installer <Setup.exe> --out <dir> [--apply idle|now]',
      );
      process.exit(2);
    }
    args[name.slice(2)] = process.argv[i + 1];
  }
  try {
    if (!args.app || !args.installer || !args.out) throw new Error('--app, --installer, --out');
    console.log(JSON.stringify(writeFeed(args), null, 2));
  } catch (error) {
    console.error('Update feed was not written: ' + error.message);
    process.exit(1);
  }
}
