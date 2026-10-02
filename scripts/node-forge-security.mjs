import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const forgeAdvisory = 'GHSA-86w9-cpqp-85rv';
export const patchSha256 = 'f62abad2a9dd9648c682496678d3fb749967ab24293a6a469660ad0f20d92521';
export const patchedRsaSha256 = '98fbd62bfb31de7f706d3d0cbee4c5c7d3b63649846c55d678e963c236bfbcaf';
export function resolveForgeConsumers() {
  return ['mobile', 'kiosk'].flatMap((app) => {
    const request = createRequire(`${root}apps/${app}/package.json`);
    const expo = createRequire(request.resolve('expo/package.json'));
    const cli = createRequire(expo.resolve('@expo/cli/package.json'));
    const certificates = createRequire(cli.resolve('@expo/code-signing-certificates/package.json'));
    return [cli, certificates].map((consumer) => ({
      rsaPath: consumer.resolve('node-forge/lib/rsa.js'),
      packagePath: consumer.resolve('node-forge/package.json'),
      forge: consumer('node-forge'),
    }));
  });
}

/** Actual RSA signatures, including a malformed nested ASN.1 sequence. */
export function signatureChecks(forge) {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicExponent: 3,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
  const publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  for (const algorithm of ['sha256', 'sha384', 'sha512']) {
    const md = forge.md[algorithm].create().update('PickChick signature regression');
    const signature = privateKey.sign(md);
    assert.equal(publicKey.verify(md.digest().getBytes(), signature), true);
    assert.equal(
      publicKey.verify(
        forge.md[algorithm].create().update('Changed message').digest().getBytes(),
        signature,
      ),
      false,
    );
  }
  const asn1 = forge.asn1;
  const node = (type, constructed, value) =>
    asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
  const md = forge.md.sha256.create().update('PickChick signature regression');
  const digest = md.digest().getBytes();
  const oid = node(asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes());
  const parameters = node(asn1.Type.NULL, false, '');
  const sequence = (children) => node(asn1.Type.SEQUENCE, true, children);
  for (const algorithmElements of [[oid], [oid, parameters]]) {
    const info = sequence([
      sequence(algorithmElements),
      node(asn1.Type.OCTETSTRING, false, digest),
    ]);
    const signature = privateKey.sign(asn1.toDer(info).getBytes(), 'NONE');
    assert.equal(
      publicKey.verify(digest, signature),
      true,
      'Valid optional NULL must remain supported',
    );
  }
  for (const algorithmElements of [
    [oid, parameters, node(asn1.Type.OCTETSTRING, false, 'garbage')],
    [oid, node(asn1.Type.OCTETSTRING, false, 'garbage')],
    [oid, node(asn1.Type.NULL, false, 'garbagebytes')],
  ]) {
    const malformed = sequence([
      sequence(algorithmElements),
      node(asn1.Type.OCTETSTRING, false, digest),
    ]);
    const signature = privateKey.sign(asn1.toDer(malformed).getBytes(), 'NONE');
    assert.throws(() => publicKey.verify(digest, signature), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
  }
}

/** Fail closed if any lockfile consumer can resolve an unreviewed forge snapshot. */
export function verifyForgeLock(lock) {
  assert.match(lock, new RegExp(`^  node-forge@1\\.4\\.0: ${patchSha256}$`, 'm'));
  const snapshots = lock.split('\nsnapshots:\n')[1];
  assert.ok(snapshots, 'Missing dependency snapshots');
  const entries = [...snapshots.matchAll(/^ {2}node-forge@([^\n]+):/gm)];
  assert.equal(entries.length, 1, 'Every node-forge snapshot must be reviewed');
  assert.equal(entries[0][1], `1.4.0(patch_hash=${patchSha256})`);
  const references = [...snapshots.matchAll(/^ +node-forge: ([^\n]+)$/gm)];
  assert.ok(references.length > 0, 'Missing node-forge consumers');
  for (const entry of references) assert.equal(entry[1], `1.4.0(patch_hash=${patchSha256})`);
}

export function verifyNodeForgePatch() {
  verifyForgeLock(readFileSync(`${root}pnpm-lock.yaml`, 'utf8'));
  verifyForgeLock(readFileSync(`${root}node_modules/.pnpm/lock.yaml`, 'utf8'));
  assert.equal(
    createHash('sha256')
      .update(readFileSync(`${root}patches/node-forge@1.4.0.patch`))
      .digest('hex'),
    patchSha256,
  );
  const consumers = resolveForgeConsumers();
  // Check all physical install copies, including copies no longer referenced by Expo.
  const copies = readdirSync(`${root}node_modules/.pnpm`)
    .filter((name) => name.startsWith('node-forge@'))
    .map((name) => `${root}node_modules/.pnpm/${name}/node_modules/node-forge`)
    .filter((path) => existsSync(`${path}/package.json`));
  assert.ok(copies.length > 0, 'Missing installed node-forge');
  for (const directory of copies) {
    assert.equal(JSON.parse(readFileSync(`${directory}/package.json`)).version, '1.4.0');
    assert.equal(
      createHash('sha256')
        .update(readFileSync(`${directory}/lib/rsa.js`))
        .digest('hex'),
      patchedRsaSha256,
      'Every installed node-forge copy must match the reviewed RSA patch',
    );
  }
  for (const consumer of consumers) {
    assert.equal(JSON.parse(readFileSync(consumer.packagePath)).version, '1.4.0');
    assert.equal(
      createHash('sha256').update(readFileSync(consumer.rsaPath)).digest('hex'),
      patchedRsaSha256,
      'Installed node-forge must match the reviewed RSA patch before any advisory exception',
    );
  }
  for (const forge of new Set(consumers.map((consumer) => consumer.forge))) signatureChecks(forge);
  return consumers;
}
