import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { withPikoFlavors } from '../packages/catalog-admin/dist/piko-flavors.js';

// Offline preparation only. Input is a current catalog payload, not credentials.
// The hash pins the reviewed input; a new output file never overwrites a draft.
const [input, output, expectedHash] = process.argv.slice(2);
if (!input || !output || !/^[a-f0-9]{64}$/.test(expectedHash ?? ''))
  throw new Error('Usage: prepare-piko-flavors.mjs input.json output.json input-sha256');
const bytes = await readFile(input);
const hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== expectedHash) throw new Error('Input changed; review the current catalog');
const before = JSON.parse(bytes.toString('utf8'));
const after = withPikoFlavors(before);
await writeFile(output, JSON.stringify(after, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ inputHash: hash, products: after.products.length, published: false }));
