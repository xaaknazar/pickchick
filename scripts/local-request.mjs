import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@pickchick/platform';
import { UuidSchema } from '@pickchick/contracts';
import { readStaffCredential } from './staff-credential.mjs';

// Small localhost API client: credentials never appear in argv, stdout or redirects.
try {
  const config = loadConfig('edge');
  const [staffId, method, path, file, keyInput] = process.argv.slice(2);
  if (!['GET', 'POST'].includes(method) || !/^\/edge\/v1\/[a-z0-9/-]+$/.test(path ?? ''))
    throw new Error('Invalid local request');
  const credential = await readStaffCredential(staffId);
  if (credential.branch_id !== config.branchId) throw new Error('Branch mismatch');
  const key = keyInput ?? randomUUID();
  UuidSchema.parse(key);
  let body;
  if (method === 'POST') {
    if (!file || (await stat(file)).size > 90000)
      throw new Error('Expected bounded JSON request file');
    body = JSON.stringify(JSON.parse(await readFile(file, 'utf8')));
  }
  if (method === 'POST')
    console.error(JSON.stringify({ event: 'local_request_started', idempotency_key: key }));
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${credential.token}`,
      'X-Staff-Session-Id': credential.session_id,
      'Idempotency-Key': key,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body }),
  });
  console.log(
    JSON.stringify(
      { status: response.status, idempotency_key: key, result: await response.json() },
      null,
      2,
    ),
  );
  if (!response.ok) process.exitCode = 1;
} catch {
  console.error('Local request failed; check arguments, private session file and running edge.');
  process.exitCode = 1;
}
