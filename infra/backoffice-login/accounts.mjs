// Local operator command for the per-person staff accounts file. Never prints a password,
// hash or bearer token. Every output is created exclusively (0600); nothing is overwritten,
// so the previous file stays available for rollback until the operator removes it.
//
//   node infra/backoffice-login/accounts.mjs migrate <current.json> <new.json>
//   node infra/backoffice-login/accounts.mjs add <current.json> <credential.json> <username> <new.json> <delivery.txt>
//   node infra/backoffice-login/accounts.mjs remove <current.json> <username> <new.json>
//
// <credential.json> is that person's own catalog_manager credential ({token, actor_id}),
// issued separately; a token already used by another account is refused.
import { open, readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  STAFF_MAX_ACCOUNTS,
  STAFF_USERNAME,
  assertPrivateStaffFile,
  parseStaffConfig,
  passwordHash,
} from '../../apps/backoffice/staff-auth.mjs';

const fail = (message) => {
  throw new Error(message);
};

/** Pure: returns a new version 2 configuration with one more person. */
export function addStaffAccount(config, entry) {
  const current = parseStaffConfig(config);
  if (!STAFF_USERNAME.test(entry.username ?? '')) fail('Invalid username');
  if (current.accounts.length >= STAFF_MAX_ACCOUNTS) fail('Too many staff accounts');
  if (current.accounts.some((a) => a.username === entry.username)) fail('Username already exists');
  if (current.accounts.some((a) => a.token === entry.token))
    fail('Credential already belongs to another account');
  if (entry.actor_id && current.accounts.some((a) => a.actor_id === entry.actor_id))
    fail('Actor already has an account');
  return parseStaffConfig({ ...current, accounts: [...current.accounts, entry] });
}

/** Pure: removes one person; the last account cannot be removed (the portal needs one). */
export function removeStaffAccount(config, username) {
  const current = parseStaffConfig(config);
  const accounts = current.accounts.filter((a) => a.username !== username);
  if (accounts.length === current.accounts.length) fail('Unknown username');
  if (accounts.length === 0) fail('The last account cannot be removed');
  return parseStaffConfig({ ...current, accounts });
}

// JSON.parse errors quote the input; private files are only ever reported generically.
async function readPrivateJson(path) {
  await assertPrivateStaffFile(path);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fail('Private file is not valid JSON');
  }
}
const readPrivate = readPrivateJson;

async function writeExclusive(path, text) {
  const output = await open(path, 'wx', 0o600);
  try {
    await output.writeFile(text);
    await output.sync();
  } finally {
    await output.close();
  }
  if ((await stat(path)).mode & 0o077) fail('Private file permissions required');
}

async function credentialOf(path) {
  const credential = await readPrivateJson(path);
  if (!/^[a-f0-9]{64}$/.test(credential?.token ?? '')) fail('Invalid catalog credential');
  if (
    credential.actor_id !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(credential.actor_id)
  )
    fail('Invalid catalog credential');
  return credential;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'migrate' && rest.length === 2) {
    const [current, next] = rest;
    if (current === next) fail('Output must be a new file');
    await writeExclusive(next, JSON.stringify(parseStaffConfig(await readPrivate(current))) + '\n');
    return 'Staff accounts migrated to version 2; credentials not printed.';
  }
  if (command === 'add' && rest.length === 5) {
    const [current, credentialPath, username, next, delivery] = rest;
    if (new Set([current, credentialPath, next, delivery]).size !== 4)
      fail('Inputs and outputs must be distinct files');
    const credential = await credentialOf(credentialPath);
    const password = randomBytes(24).toString('base64url');
    const config = addStaffAccount(await readPrivate(current), {
      username,
      token: credential.token,
      ...(credential.actor_id ? { actor_id: credential.actor_id } : {}),
      ...(await passwordHash(password)),
    });
    const origin = new URL(config.origin);
    // Delivery file first: if it cannot be created, no account file exists without a password.
    await writeExclusive(
      delivery,
      `PickChick - личный кабинет\n\nАдрес: ${origin.origin}/backoffice/\nЛогин: ${username}\nПароль: ${password}\n\nЭто ваш личный доступ: все изменения меню и стоп-листа записываются на ваше имя.\nНе передавайте пароль другим сотрудникам. Сохраните его в менеджере паролей.\n`,
    );
    await writeExclusive(next, JSON.stringify(config) + '\n');
    return 'Staff account added; password written only to the private delivery file.';
  }
  if (command === 'remove' && rest.length === 3) {
    const [current, username, next] = rest;
    if (current === next) fail('Output must be a new file');
    await writeExclusive(
      next,
      JSON.stringify(removeStaffAccount(await readPrivate(current), username)) + '\n',
    );
    return 'Staff account removed; restart the portal so its sessions end.';
  }
  fail('Usage: accounts.mjs migrate|add|remove ... (see the header of this file)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (message) => console.log(message),
    (error) => {
      // Only curated messages; never file contents.
      console.error(error instanceof Error ? error.message : 'Staff accounts command failed');
      process.exitCode = 1;
    },
  );
}
