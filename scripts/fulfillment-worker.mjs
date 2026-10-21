import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  syncFulfillmentOnce,
  cloudTransportOrigin,
  TransportAttention,
  edgeIdentityAutoRotate,
  identityExpiryStatus,
  renewIdentityFile,
} from '@pickchick/fulfillment-transport';
import { readIdentity, identityPath } from './private-identity.mjs';

/** Renewal is checked this often; no cloud request is made before the 10-day window. */
const RENEWAL_CHECK_MS = 15 * 60 * 1000;
const config = loadConfig('edge');
// Off by default; when on, this worker owns .local/edge-identity.json and renews it in place.
const autoRotate = edgeIdentityAutoRotate(process.env);
if (!config.fulfillmentTransportEnabled) {
  console.log(JSON.stringify({ event: 'fulfillment_transport', state: 'disabled' }));
} else {
  const origin = cloudTransportOrigin(
    process.env.EDGE_FULFILLMENT_CLOUD_ORIGIN ?? 'http://127.0.0.1:3100',
  );
  const pool = createPool(config.databaseUrl);
  const stop = new AbortController(),
    once = process.argv.includes('--once');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  let failures = 0,
    renewalAt = 0,
    identityReport;
  const attention = new TransportAttention();
  try {
    do {
      let state = 'retry';
      if (autoRotate && Date.now() >= renewalAt) {
        renewalAt = Date.now() + RENEWAL_CHECK_MS;
        try {
          const renewal = await renewIdentityFile({
            path: fileURLToPath(identityPath),
            origin,
            branchId: config.branchId,
            deviceId: config.edgeDeviceId,
          });
          if (renewal.state !== 'not_due')
            console.log(
              JSON.stringify({
                event: 'edge_identity_rotation',
                state: renewal.state,
                ...(renewal.error ? { error: renewal.error } : {}),
                ...(renewal.daysRemaining === undefined
                  ? {}
                  : { days_remaining: renewal.daysRemaining }),
              }),
            );
        } catch {
          console.error(JSON.stringify({ event: 'edge_identity_rotation', state: 'failed' }));
        }
      }
      try {
        const identity = await readIdentity();
        const expiry = identityExpiryStatus(identity);
        const report = `${expiry.state}:${Math.floor(expiry.daysRemaining)}`;
        if (report !== identityReport) {
          identityReport = report;
          console.log(
            JSON.stringify({
              event: 'edge_identity',
              state: expiry.state,
              days_remaining: expiry.daysRemaining,
              expires_at: expiry.expiresAt,
            }),
          );
        }
        const result = await syncFulfillmentOnce(pool, {
          enabled: true,
          branchId: config.branchId,
          origin,
          identity,
        });
        state = result.state;
        if (once || !['idle', 'busy'].includes(state))
          console.log(JSON.stringify({ event: 'fulfillment_transport', ...result }));
        const notice = attention.observe(result);
        if (notice) console.error(JSON.stringify(notice));
        if (state === 'retry' || state === 'blocked') {
          failures = Math.min(failures + 1, 6);
          if (once) process.exitCode = 1;
        } else failures = 0;
      } catch {
        failures = Math.min(failures + 1, 6);
        console.error(JSON.stringify({ event: 'fulfillment_transport_failed', retrying: !once }));
        if (once) process.exitCode = 1;
      }
      if (once || stop.signal.aborted) break;
      // Each turn claims one event and one reverse event. Drain successful work
      // immediately; only idle, contention or failure has bounded backoff/jitter.
      const wait = failures
        ? Math.min(60000, 1000 * 2 ** failures) + Math.floor(Math.random() * 500)
        : ['idle', 'busy'].includes(state)
          ? 1000
          : 0;
      if (wait)
        await delay(wait, undefined, { signal: stop.signal }).catch((error) => {
          if (error.name !== 'AbortError') throw error;
        });
    } while (!stop.signal.aborted);
  } finally {
    await pool.end();
  }
}
