// Apply reviewed overlays to a separately cloned, pinned upstream checkout.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

export async function installOverlays(directory, { qr = false } = {}) {
  const cwd = resolve(directory);
  const git = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (git(['rev-parse', 'HEAD']).toString().trim() !== '28c9167f9c72cd6758a25e254bc92bc610daa485')
    throw new Error('UPSTREAM_REVISION_MISMATCH');
  if (qr) {
    // Compare against exact pinned expected contents before touching caller files.
    // The optional patch overlaps hardening's context, so reverse-checking each
    // patch independently cannot establish whether a complete QR install matches.
    const temporary = await mkdtemp(join(tmpdir(), 'pickchick-kaspi-qr-overlay-'));
    try {
      const scratch = join(temporary, 'checkout');
      execFileSync('git', ['clone', '--no-hardlinks', '--no-checkout', '--quiet', cwd, scratch], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const scratchGit = (args) =>
        execFileSync('git', args, {
          cwd: scratch,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      scratchGit(['checkout', '--detach', '--quiet', '28c9167f9c72cd6758a25e254bc92bc610daa485']);
      const patches = [
        'pickchick-hardening.patch',
        'pickchick-entrance.patch',
        'pickchick-qr.patch',
      ];
      const paths = new Set();
      for (const name of patches) {
        const patch = await readFile(new URL(name, import.meta.url), 'utf8');
        for (const match of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) paths.add(match[1]);
      }
      const versions = new Map([...paths].map((path) => [path, []]));
      const remember = async () => {
        for (const path of paths) versions.get(path).push(await readFile(join(scratch, path)));
      };
      await remember();
      for (const name of patches) {
        scratchGit(['apply', fileURLToPath(new URL(name, import.meta.url))]);
        await remember();
      }
      for (const path of paths) {
        const actual = await readFile(join(cwd, path));
        if (!versions.get(path).some((expected) => expected.equals(actual)))
          throw new Error(`OVERLAY_CONFLICT:${path}`);
      }
      // Every patched file was validated; copy the complete expected result.
      for (const path of paths) await copyFile(join(scratch, path), join(cwd, path));
      for (const name of ['entrance-flow.mjs', 'bank-time.mjs', 'qr-routes.mjs'])
        await copyFile(new URL(name, import.meta.url), resolve(cwd, 'src', name));
      return;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  for (const name of [
    'pickchick-hardening.patch',
    'pickchick-entrance.patch',
    ...(qr ? ['pickchick-qr.patch'] : []),
  ]) {
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
  for (const name of ['entrance-flow.mjs', 'bank-time.mjs', ...(qr ? ['qr-routes.mjs'] : [])])
    await copyFile(new URL(name, import.meta.url), resolve(cwd, 'src', name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 && !(process.argv.length === 4 && process.argv[3] === '--qr'))
    throw new Error('USAGE: install-overlays.mjs UPSTREAM_DIRECTORY [--qr]');
  await installOverlays(process.argv[2], { qr: process.argv[3] === '--qr' });
  console.log('Pinned Kaspi bridge overlays installed; no bank requests made.');
}
