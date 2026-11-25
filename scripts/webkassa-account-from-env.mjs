#!/usr/bin/env node
// Turns the owner's private Webkassa .env (KEY=value lines) into the account JSON that
// EDGE_WEBKASSA_ACCOUNT_FILE / WEBKASSA_ACCOUNT_FILE expect (docs/integrations/webkassa-api.md).
// Values are never printed: the output names only the host, the cashbox and which keys were used.
// Usage: node scripts/webkassa-account-from-env.mjs --env <file> --out <new file> [--base-url URL]
import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = {
  baseUrl: ['WEBKASSA_BASE_URL', 'WEBKASSA_URL', 'WEBKASSA_HOST'],
  apiKey: ['WEBKASSA_API_KEY', 'WEBKASSA_X_API_KEY', 'X_API_KEY', 'API_KEY'],
  login: ['WEBKASSA_LOGIN', 'WEBKASSA_EMAIL', 'LOGIN'],
  password: ['WEBKASSA_PASSWORD', 'PASSWORD'],
  cashboxUniqueNumber: [
    'WEBKASSA_CASHBOX',
    'WEBKASSA_CASHBOX_UNIQUE_NUMBER',
    'CASHBOX_UNIQUE_NUMBER',
    'CASHBOX',
  ],
};
const PATTERNS = {
  baseUrl: /^https:\/\/(devkkm|kkm)\.webkassa\.kz\/?$/,
  apiKey: /^\S{8,200}$/,
  login: /^\S{3,200}$/,
  password: /^.{1,200}$/,
  cashboxUniqueNumber: /^SWK\d{8}$/,
};

export function parseEnv(text) {
  const values = new Map();
  for (const line of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

export function accountFromEnv(values, baseUrlOverride) {
  const account = {};
  const used = {};
  for (const [field, names] of Object.entries(NAMES)) {
    const name = names.find((candidate) => values.get(candidate));
    let value = name ? values.get(name) : undefined;
    if (field === 'baseUrl') value = baseUrlOverride ?? value ?? 'https://devkkm.webkassa.kz';
    if (typeof value !== 'string' || !PATTERNS[field].test(value))
      throw new Error(`Webkassa ${field} missing or invalid (looked for ${names.join(', ')})`);
    account[field] = value;
    used[field] =
      field === 'baseUrl' && !name
        ? 'default'
        : baseUrlOverride && field === 'baseUrl'
          ? '--base-url'
          : name;
  }
  return { account, used };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (flag) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  const envFile = arg('--env');
  const out = arg('--out');
  if (!envFile || !out) {
    console.error('Usage: --env <file> --out <new file> [--base-url URL]');
    process.exit(2);
  }
  const { account, used } = accountFromEnv(
    parseEnv(readFileSync(envFile, 'utf8')),
    arg('--base-url'),
  );
  writeFileSync(out, `${JSON.stringify(account)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(
    JSON.stringify({
      written: out,
      host: new URL(account.baseUrl).host,
      cashbox: account.cashboxUniqueNumber,
      keys: used,
    }),
  );
}
