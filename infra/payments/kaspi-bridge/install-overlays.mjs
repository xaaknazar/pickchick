// Apply reviewed overlays to a separately cloned, pinned upstream checkout.
import { execFileSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function installOverlays(directory) {
  const cwd = resolve(directory);
  const git = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (git(['rev-parse', 'HEAD']).toString().trim() !== '28c9167f9c72cd6758a25e254bc92bc610daa485')
    throw new Error('UPSTREAM_REVISION_MISMATCH');
  for (const name of ['pickchick-hardening.patch', 'pickchick-entrance.patch']) {
    const patch = fileURLToPath(new URL(name, import.meta.url));
    try {
      git(['apply', '--check', patch]);
    } catch {
      try {
        git(['apply', '--reverse', '--check', patch]);
        continue;
      } catch {
        throw new Error(`OVERLAY_CONFLICT:${name}`);
      }
    }
    git(['apply', patch]);
  }
  for (const name of ['entrance-flow.mjs', 'bank-time.mjs'])
    await copyFile(new URL(name, import.meta.url), resolve(cwd, 'src', name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('USAGE: install-overlays.mjs UPSTREAM_DIRECTORY');
  await installOverlays(process.argv[2]);
  console.log('Pinned Kaspi bridge overlays installed; no bank requests made.');
}
