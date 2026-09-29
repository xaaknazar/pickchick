// Owner check of the bridge and cashier session. Read-only by default.
//   node --env-file=/opt/pickchick-staging/secrets/kaspi-remote.env \
//        --env-file=/opt/pickchick-staging/secrets/kaspi-session.env \
//        infra/payments/kaspi-bridge/kaspi-check.mjs
// With --invoice-phone +77XXXXXXXXX [--amount 100] it issues ONE real invoice (money
// goes to the connected Kaspi Pay merchant) and follows its status for 5 minutes.
// Prints only statuses; never phones, tokens or session values.
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  KaspiBridgeClient,
  kaspiInvoiceOutcome,
  kaspiPhone,
  kaspiRemoteConfig,
} from '../../../packages/commerce-core/dist/index.js';

async function main() {
  const config = kaspiRemoteConfig(process.env);
  if (!config) throw new Error('KASPI_REMOTE_DISABLED');
  if (!config.session) throw new Error('NO_CASHIER_SESSION');
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
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
  const target = option('--invoice-phone');
  if (!target) {
    console.log(JSON.stringify({ step: 'done', invoiceAttempted: false }));
    return;
  }
  const phone = kaspiPhone(target.replace(/[\s()-]/g, ''));
  const amount = Number(option('--amount') ?? '100');
  if (!phone || !Number.isInteger(amount) || amount < 1 || amount > 1000)
    throw new Error('INVOICE_ARGUMENTS_INVALID');
  const client = new KaspiBridgeClient(config);
  const created = await client.createInvoice(phone, amount, 'PickChick проверка');
  const id =
    created.kind === 'ok' ? String(created.data.QrOperationId ?? created.data.Id ?? '') : '';
  console.log(JSON.stringify({ step: 'invoice', result: created.kind, operationId: id || null }));
  if (!/^[1-9][0-9]*$/.test(id)) {
    process.exitCode = 1;
    return;
  }
  const until = Date.now() + 5 * 60_000;
  let last = '';
  while (Date.now() < until) {
    const answer = await client.details(id);
    const status = answer.kind === 'ok' ? String(answer.data.Status ?? '') : answer.kind;
    if (status !== last) {
      last = status;
      console.log(JSON.stringify({ step: 'status', status, outcome: kaspiInvoiceOutcome(status) }));
    }
    if (['captured', 'failed'].includes(kaspiInvoiceOutcome(status))) return;
    await delay(3000);
  }
  // Leave nothing payable behind after the check window.
  await client.cancel(id);
  console.log(JSON.stringify({ step: 'cancelled_after_timeout', operationId: id }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, reason: String(error.message).slice(0, 80) }));
    process.exitCode = 1;
  });
}
