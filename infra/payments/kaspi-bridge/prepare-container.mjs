// Produces an allowlisted Docker context, never copying the caller's .env,
// device/keypair, sessions, logs, node_modules or other untracked upstream files.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { installOverlays } from './install-overlays.mjs';

const UPSTREAM = '28c9167f9c72cd6758a25e254bc92bc610daa485';
const here = fileURLToPath(new URL('.', import.meta.url));
export async function prepareContainer(upstream, output, { qr = false } = {}) {
  const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (git('-C', upstream, 'rev-parse', 'HEAD').toString().trim() !== UPSTREAM)
    throw new Error('UPSTREAM_REVISION_MISMATCH');
  await mkdir(output, { mode: 0o700 }); // Fail instead of overwriting an earlier context.
  const temporary = await mkdtemp(join(tmpdir(), 'pickchick-kaspi-context-'));
  try {
    const checkout = join(temporary, 'checkout');
    git('clone', '--no-hardlinks', '--no-checkout', '--quiet', upstream, checkout);
    git('-C', checkout, 'checkout', '--detach', '--quiet', UPSTREAM);
    await installOverlays(checkout, { qr });
    const names = git('-C', checkout, 'ls-tree', '-r', '--name-only', 'HEAD')
      .toString()
      .trim()
      .split('\n')
      .filter(
        (name) =>
          name === 'server.js' ||
          name === 'package.json' ||
          name === 'package-lock.json' ||
          name.startsWith('src/'),
      );
    names.push('src/entrance-flow.mjs', 'src/bank-time.mjs');
    if (qr) names.push('src/qr-routes.mjs');
    const hashes = {};
    for (const name of names) {
      const relative = 'upstream/' + name;
      const target = join(output, relative);
      await mkdir(resolve(target, '..'), { recursive: true });
      const content = await readFile(join(checkout, name));
      await writeFile(target, content, { flag: 'wx' });
      hashes[relative] = createHash('sha256').update(content).digest('hex');
    }
    for (const name of ['Dockerfile', 'container.compose.yaml', 'session-check.mjs']) {
      await copyFile(join(here, name), join(output, name));
      hashes[name] = createHash('sha256')
        .update(await readFile(join(output, name)))
        .digest('hex');
    }
    await writeFile(
      join(output, '.dockerignore'),
      '**\n!upstream/\n!upstream/**\n!session-check.mjs\n',
    );
    await writeFile(
      join(output, 'manifest.json'),
      JSON.stringify({ upstream: UPSTREAM, qr, hashes }, null, 2) + '\n',
    );
    return { upstream: UPSTREAM, fileCount: Object.keys(hashes).length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4 && !(process.argv.length === 5 && process.argv[4] === '--qr'))
    throw new Error('USAGE: prepare-container.mjs UPSTREAM_CHECKOUT NEW_OUTPUT_DIRECTORY [--qr]');
  console.log(
    JSON.stringify(
      await prepareContainer(resolve(process.argv[2]), resolve(process.argv[3]), {
        qr: process.argv[4] === '--qr',
      }),
    ),
  );
}
