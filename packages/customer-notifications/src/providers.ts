import { sign, type KeyObject } from 'node:crypto';
import { connect } from 'node:http2';
import type { PushOptions } from './config.js';
export interface PushMessage {
  title: string;
  body: string;
  notificationId: string;
  orderId: string;
}
export interface PushTarget {
  token: string;
  provider: 'apns' | 'fcm';
  environment: 'development' | 'production';
  bundleId: string;
}
export type DeliveryResult = { state: 'accepted' | 'retry' | 'invalid' | 'failed'; code: string };
export function classifyPushResult(
  provider: 'apns' | 'fcm',
  status: number,
  reason = '',
): DeliveryResult {
  if (status >= 200 && status < 300) return { state: 'accepted', code: 'accepted' };
  if (
    (provider === 'apns' &&
      (status === 410 || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) ||
    (provider === 'fcm' && reason === 'UNREGISTERED')
  )
    return { state: 'invalid', code: 'token_invalid' };
  if (status === 429 || status >= 500 || status === 0)
    return { state: 'retry', code: status === 429 ? 'rate_limited' : 'provider_unavailable' };
  return {
    state: 'failed',
    code: status === 401 || status === 403 ? 'provider_auth' : 'provider_rejected',
  };
}
function jwt(header: object, payload: object, key: KeyObject, ec: boolean) {
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${part(header)}.${part(payload)}`;
  const signature = sign(
    'sha256',
    Buffer.from(data),
    ec ? { key, dsaEncoding: 'ieee-p1363' } : key,
  );
  return `${data}.${signature.toString('base64url')}`;
}
export function apnsPayload(message: PushMessage) {
  return {
    aps: {
      alert: { title: message.title, body: message.body },
      sound: 'default',
      'thread-id': 'pickchick-orders',
    },
    notificationId: message.notificationId,
    orderId: message.orderId,
    type: 'order',
  };
}
export class PushProviders {
  private apnsToken: { value: string; expires: number } | null = null;
  private fcmToken: { value: string; expires: number } | null = null;
  constructor(private readonly options: PushOptions) {}
  async send(target: PushTarget, message: PushMessage): Promise<DeliveryResult> {
    try {
      return target.provider === 'apns'
        ? await this.apple(target, message)
        : await this.google(target, message);
    } catch {
      return { state: 'retry', code: 'transport_unavailable' };
    }
  }
  private async apple(target: PushTarget, message: PushMessage): Promise<DeliveryResult> {
    const config = this.options.apns;
    if (!config) return { state: 'failed', code: 'provider_disabled' };
    const now = Math.floor(Date.now() / 1000);
    if (!this.apnsToken || this.apnsToken.expires <= now)
      this.apnsToken = {
        value: jwt(
          { alg: 'ES256', kid: config.keyId },
          { iss: config.teamId, iat: now },
          config.key,
          true,
        ),
        expires: now + 20 * 60,
      };
    const token = this.apnsToken.value;
    return new Promise((resolve) => {
      const client = connect(
        target.environment === 'development'
          ? 'https://api.sandbox.push.apple.com'
          : 'https://api.push.apple.com',
      );
      let settled = false;
      const finish = (result: DeliveryResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.destroy();
        resolve(result);
      };
      const timeout = setTimeout(() => finish({ state: 'retry', code: 'timeout' }), 10000);
      client.on('error', () => finish({ state: 'retry', code: 'transport_unavailable' }));
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${target.token}`,
        authorization: `bearer ${token}`,
        'apns-topic': target.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(now + 1800),
        'apns-collapse-id': message.orderId,
        'apns-id': message.notificationId,
      });
      let status = 0,
        body = '';
      req.on('response', (headers) => {
        status = Number(headers[':status']);
      });
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 8192) finish({ state: 'failed', code: 'invalid_response' });
      });
      req.on('error', () => finish({ state: 'retry', code: 'transport_unavailable' }));
      req.on('end', () => {
        let reason = '';
        try {
          reason = JSON.parse(body).reason ?? '';
        } catch {
          /* Successful APNs responses have no JSON body. */
        }
        finish(classifyPushResult('apns', status, reason));
      });
      req.end(JSON.stringify(apnsPayload(message)));
    });
  }
  private async google(target: PushTarget, message: PushMessage): Promise<DeliveryResult> {
    const config = this.options.fcm;
    if (!config) return { state: 'failed', code: 'provider_disabled' };
    const now = Math.floor(Date.now() / 1000);
    if (!this.fcmToken || this.fcmToken.expires <= now) {
      const assertion = jwt(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: config.email,
          scope: 'https://www.googleapis.com/auth/firebase.messaging',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
        },
        config.key,
        false,
      );
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return classifyPushResult('fcm', response.status);
      const data = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token || !Number.isFinite(data.expires_in))
        return { state: 'failed', code: 'invalid_response' };
      this.fcmToken = {
        value: data.access_token,
        expires: now + Math.min(data.expires_in!, 3600) - 60,
      };
    }
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.fcmToken.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: target.token,
            notification: { title: message.title, body: message.body },
            data: {
              type: 'order',
              notificationId: message.notificationId,
              orderId: message.orderId,
            },
            android: {
              collapse_key: message.orderId,
              ttl: '1800s',
              restricted_package_name: target.bundleId,
              notification: { channel_id: 'orders' },
            },
          },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (response.status === 401) this.fcmToken = null;
    let reason = '';
    try {
      const data = (await response.json()) as { error?: { details?: { errorCode?: string }[] } };
      reason = data.error?.details?.find((v) => v.errorCode)?.errorCode ?? '';
    } catch {
      /* No raw provider body is logged. */
    }
    return classifyPushResult('fcm', response.status, reason);
  }
}
