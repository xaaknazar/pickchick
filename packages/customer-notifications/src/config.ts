import { readFileSync } from 'node:fs';
import { createPrivateKey, type KeyObject } from 'node:crypto';
export interface PushOptions {
  enabled: boolean;
  encryptionKey?: Buffer;
  apns?: { key: KeyObject; keyId: string; teamId: string };
  fcm?: { key: KeyObject; projectId: string; email: string };
}
/** Secrets are read from mounted files, never returned by public config or logged. */
export function pushOptions(env: NodeJS.ProcessEnv): PushOptions {
  if (env.CUSTOMER_PUSH_ENABLED !== '1') return { enabled: false };
  try {
    const encryptionKey = Buffer.from(
      readFileSync(env.CUSTOMER_PUSH_ENCRYPTION_KEY_FILE!, 'utf8').trim(),
      'base64',
    );
    if (encryptionKey.length !== 32) throw new Error();
    const result: PushOptions = { enabled: true, encryptionKey };
    if (env.APNS_KEY_FILE) {
      if (
        !/^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID ?? '') ||
        !/^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID ?? '')
      )
        throw new Error();
      const key = createPrivateKey(readFileSync(env.APNS_KEY_FILE));
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
        throw new Error();
      result.apns = { key, keyId: env.APNS_KEY_ID!, teamId: env.APNS_TEAM_ID! };
    }
    if (env.FCM_SERVICE_ACCOUNT_FILE) {
      const account = JSON.parse(readFileSync(env.FCM_SERVICE_ACCOUNT_FILE, 'utf8'));
      if (
        !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(account.project_id) ||
        !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(account.client_email)
      )
        throw new Error();
      const key = createPrivateKey(account.private_key);
      if (key.asymmetricKeyType !== 'rsa') throw new Error();
      result.fcm = { key, projectId: account.project_id, email: account.client_email };
    }
    if (!result.apns && !result.fcm) throw new Error();
    return result;
  } catch {
    throw new Error('Invalid customer push configuration');
  }
}
