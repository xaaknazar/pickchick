import { open, readFile, stat, mkdir, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { createPool } from '@pickchick/database';
import { provisionCatalogManager, revokeCatalogManager } from './index.js';
import type { CatalogCredential } from './contracts.js';
// Explicit owner CLI only. The HTTP process never reads an actor provisioning file.
async function run() {
  const [command, ...args] = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (!['provision', 'revoke'].includes(command ?? ''))
    throw new Error('Expected provision or revoke');
  const databaseUrl = process.env['CLOUD_DATABASE_URL'];
  if (!databaseUrl) throw new Error('Missing database configuration');
  const pool = createPool(databaseUrl);
  try {
    if (command === 'revoke') {
      const id = option('--actor');
      if (!id) throw new Error('Missing actor');
      await revokeCatalogManager(pool, id);
      console.log('Catalog manager access revoked.');
      return;
    }
    const input = option('--input'),
      output = option('--output');
    if (!input || !output || (await stat(input)).size > 16000)
      throw new Error('Expected bounded input and new private output file');
    const target = resolve(output),
      privateRoot = resolve('.local');
    if (!target.startsWith(privateRoot + sep) || !target.endsWith('.json'))
      throw new Error('Output must be a new JSON file under .local');
    const data: unknown = JSON.parse(await readFile(input, 'utf8'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const parent = await realpath(dirname(target)),
      base = await realpath(privateRoot);
    if (parent !== base && !parent.startsWith(base + sep))
      throw new Error('Private output cannot escape through a directory symlink');
    const file = await open(target, 'wx', 0o600);
    let credential: CatalogCredential | undefined;
    try {
      credential = await provisionCatalogManager(pool, data);
      await file.writeFile(JSON.stringify(credential, null, 2) + '\n', 'utf8');
      await file.sync();
      await file.close();
    } catch {
      await file.close().catch(() => undefined);
      if (credential) await revokeCatalogManager(pool, credential.actor_id);
      await unlink(target).catch(() => undefined);
      throw new Error('Credential could not be saved');
    }
    console.log(
      'Catalog manager credential saved in the requested private file. Token was not printed.',
    );
  } finally {
    await pool.end();
  }
}
run().catch(() => {
  console.error(
    'Catalog manager command failed. Check scope, input, database and private file permissions. No credential was printed.',
  );
  process.exitCode = 1;
});
