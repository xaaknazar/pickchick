// Local operator command: never prints a password or bearer token.
import { readFile, open, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { passwordHash } from '../../apps/backoffice/staff-auth.mjs';
const [credentialPath, privateOutput, deliveryOutput] = process.argv.slice(2);
if (!credentialPath || !privateOutput || !deliveryOutput || privateOutput === deliveryOutput)
  throw new Error('Provide credential, new private configuration, new delivery file');
const credential = JSON.parse(await readFile(credentialPath, 'utf8'));
if (!/^[a-f0-9]{64}$/.test(credential.token) || typeof credential.actor_id !== 'string')
  throw new Error('Invalid director credential');
const password = randomBytes(24).toString('base64url');
const config = {
  version: 1,
  username: 'ceo',
  origin: 'https://pickchick.kz',
  actor_id: credential.actor_id,
  token: credential.token,
  ...(await passwordHash(password)),
};
// Exclusive creation prevents accidental replacement of an existing account.
const delivery = await open(deliveryOutput, 'wx', 0o600);
try {
  const output = await open(privateOutput, 'wx', 0o600);
  try {
    await output.writeFile(JSON.stringify(config) + '\n');
    await output.sync();
  } finally {
    await output.close();
  }
  await delivery.writeFile(
    `PickChick - личный кабинет CEO\n\nАдрес: https://pickchick.kz/backoffice/#finance\nЛогин: ceo\nПароль: ${password}\n\nСохраните пароль в менеджере паролей. Не передавайте аккаунт сотрудникам: каждому будет выдан отдельный доступ.\n`,
  );
  await delivery.sync();
} finally {
  await delivery.close();
}
if ((await stat(privateOutput)).mode & 0o077 || (await stat(deliveryOutput)).mode & 0o077)
  throw new Error('Private file permissions required');
console.log('CEO configuration and private delivery file created; credentials not printed.');
