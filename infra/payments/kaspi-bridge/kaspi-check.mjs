// Owner check of the bridge and cashier session. Read-only by default.
//   node --env-file=/opt/pickchick-staging/secrets/kaspi-remote.env \
//        --env-file=/opt/pickchick-staging/secrets/kaspi-session.env \
//        infra/payments/kaspi-bridge/kaspi-check.mjs
// Read-only: real pilot invoices must go through the durable commerce ledger.
import { pathToFileURL } from 'node:url';
import { kaspiRemoteConfig } from '../../../packages/commerce-core/dist/index.js';

async function main() {
  const config = kaspiRemoteConfig(process.env);
  if (!config) throw new Error('KASPI_REMOTE_DISABLED');
  if (!config.session) throw new Error('NO_CASHIER_SESSION');
  if (process.argv.length > 2) throw new Error('READ_ONLY_CHECK_NO_ARGUMENTS');
  const session = await fetch(config.bridgeUrl + '/api/session/check', {
    headers: {
      'X-Token-SN': config.session.tokenSN,
      'X-Vtoken-Secret': config.session.vtokenSecret,
      'X-Profile-Id': config.session.profileId,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
    .then((r) => r.json())
    .catch(() => ({ active: false }));
  console.log(JSON.stringify({ step: 'session', active: session.active === true }));
  if (session.active !== true) {
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ step: 'done', invoiceAttempted: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, reason: String(error.message).slice(0, 80) }));
    process.exitCode = 1;
  });
}
