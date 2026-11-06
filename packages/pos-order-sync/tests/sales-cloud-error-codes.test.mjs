import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ErrorSchema, PosErrorCodeSchema } from '@pickchick/contracts';
import { createHttpApplication, Resources, RESOURCE } from '@pickchick/platform';
import { CustomerCheckoutController } from '../../../services/api/dist/customer-checkout-controller.js';
import { KioskCheckoutController } from '../../../services/api/dist/kiosk-checkout-controller.js';
import { CommerceError } from '../../commerce-core/dist/index.js';

// Cloud region of packages/contracts/src/index.ts (contracts 4.1): ErrorSchema lists the cashier
// edge POS codes (CR pos-1 section 2, CR client-4 section 1) and the kitchen edge handover code
// (CR kds-6). The shared error filter (packages/platform/src/http.ts) passes a code only when
// ErrorSchema lists it and otherwise answers the default code of the status (409 CONFLICT, 400
// INVALID_REQUEST); the pos and kds controllers throw HttpException({code}, status), exactly
// like the probe below. Cloud routes never send these codes.

// The @nestjs/common instance of the platform package, so the filter sees the same HttpException.
const nest = createRequire(fileURLToPath(import.meta.resolve('@pickchick/platform')))(
  '@nestjs/common',
);
const POS_CODES = PosErrorCodeSchema.options;
const KDS_CODES = ['HANDOVER_MARKS_REQUIRED'];
/** ErrorSchema.code of D0 5b212949. */
const D0_CODES = Object.freeze([
  'CATALOG_UPGRADE_REQUIRED',
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'QUOTE_EXPIRED',
  'MENU_CHANGED',
  'RESTAURANT_CLOSED',
  'AVAILABILITY_STALE',
  'BRANCH_UNAVAILABLE',
  'ITEM_STOPPED',
  'KITCHEN_OFFLINE',
  'CASH_SHIFT_REQUIRED',
  'SERVICE_MODE_DISABLED',
  'KITCHEN_UNAVAILABLE',
  'ORDER_IN_PRODUCTION',
  'SHIFT_CLOSED',
  'CONFLICT',
  'INSUFFICIENT_STOCK',
  'NOT_READY',
  'PAYLOAD_TOO_LARGE',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'RATE_LIMITED',
  'AUTH_RATE_LIMITED',
  'INTERNAL_ERROR',
]);

/** An edge or cloud application whose only route throws HttpException({code}, status). */
async function probe(service) {
  class ErrorProbe {
    fail(status, code) {
      throw new nest.HttpException({ code }, Number(status));
    }
  }
  nest.Param('status')(ErrorProbe.prototype, 'fail', 0);
  nest.Param('code')(ErrorProbe.prototype, 'fail', 1);
  nest.Get(':status/:code')(
    ErrorProbe.prototype,
    'fail',
    Object.getOwnPropertyDescriptor(ErrorProbe.prototype, 'fail'),
  );
  nest.Controller('probe')(ErrorProbe);
  class ProbeModule {}
  nest.Module({
    controllers: [ErrorProbe],
    providers: [
      {
        provide: RESOURCE,
        useFactory: () =>
          new Resources({
            service,
            environment: 'test',
            port: 0,
            databaseUrl: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
          }),
      },
    ],
  })(ProbeModule);
  const app = await createHttpApplication(ProbeModule);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return {
    app,
    async error(status, code) {
      const response = await fetch(`${url}/probe/${status}/${code}`);
      assert.equal(response.status, status);
      return ErrorSchema.parse(await response.json());
    },
  };
}

test('ErrorSchema lists every POS code of PosErrorCodeSchema and the KDS handover code', () => {
  // The cherry-picked pos schema here is byte for byte the one of codex/cutover-pos b25674d5.
  assert.deepEqual(POS_CODES, [
    'SERVICE_MODE_DISABLED',
    'METHOD_DISABLED',
    'TENDER_SUM_MISMATCH',
    'CASH_TENDERED_TOO_LOW',
    'TERMINAL_AMOUNT_NOT_WHOLE',
    'CHANNEL_PRICE_UNAVAILABLE',
    'EXTERNAL_REF_REQUIRED',
    'EXTERNAL_REF_DUPLICATE',
    'APPROVAL_REQUIRED',
    'APPROVAL_INVALID',
    'ORDER_IN_PRODUCTION',
    'REFUND_LIMIT',
    'REFUND_NOT_SUPPORTED',
    'DRAWER_INSUFFICIENT',
    'FISCAL_PENDING',
  ]);
  const listed = ErrorSchema.shape.code.options;
  for (const code of [...POS_CODES, ...KDS_CODES]) {
    assert.ok(listed.includes(code), code);
    const body = {
      code,
      message_key: `errors.${code.toLowerCase()}`,
      trace_id: '00000000-0000-4000-8000-000000000000',
      retryable: false,
    };
    assert.deepEqual(ErrorSchema.parse(body), body);
  }
  // Nothing else changed: the D0 codes are all still listed, each once, plus 13 + 1 new ones.
  assert.equal(new Set(listed).size, listed.length);
  for (const code of D0_CODES) assert.ok(listed.includes(code), code);
  assert.deepEqual(
    listed.filter((code) => !D0_CODES.includes(code)),
    [...POS_CODES.filter((code) => !D0_CODES.includes(code)), ...KDS_CODES],
  );
});

test('the edge error filter now passes each POS code (409) and HANDOVER_MARKS_REQUIRED (400)', async () => {
  const edge = await probe('edge');
  try {
    for (const code of POS_CODES) {
      const body = await edge.error(409, code);
      assert.equal(body.code, code);
      assert.equal(body.message_key, `errors.${code.toLowerCase()}`);
      assert.equal(body.retryable, false);
    }
    const marks = await edge.error(400, 'HANDOVER_MARKS_REQUIRED');
    assert.equal(marks.code, 'HANDOVER_MARKS_REQUIRED');
    assert.equal(marks.message_key, 'errors.handover_marks_required');
    // A code that ErrorSchema does not list still becomes the default code of its status.
    assert.equal((await edge.error(409, 'NOT_A_LISTED_CODE')).code, 'CONFLICT');
    assert.equal((await edge.error(400, 'NOT_A_LISTED_CODE')).code, 'INVALID_REQUEST');
  } finally {
    await edge.app.close();
  }
});

test('cloud checkout routes keep CONFLICT for REFUND_LIMIT: app and kiosk bundles see no new code', async () => {
  // CommerceError REFUND_LIMIT comes only from the back-office refunds (mapped to CONFLICT there);
  // the checkout controllers map it to CONFLICT themselves since the filter would now pass it.
  const customer = new CustomerCheckoutController(
    { me: async () => ({ customer: { id: 'synthetic' }, legal: { accepted: true } }) },
    { pool: {} },
    { revision: 0 },
  );
  customer.checkout = {
    quote: async () => {
      throw new CommerceError('REFUND_LIMIT');
    },
  };
  const token = 'Bearer ' + 'a'.repeat(64);
  for (const accept of [
    'application/json',
    'application/json; profile=pickchick.checkout-errors-v1',
    'application/json; profile=pickchick.checkout-errors-v2',
  ])
    await assert.rejects(
      customer.quote({}, token, accept),
      (e) => e.getResponse().code === 'CONFLICT' && e.getStatus() === 409,
    );
  const kiosk = new KioskCheckoutController({ pool: {} });
  kiosk.checkout = {};
  kiosk.sessions = {};
  await assert.rejects(
    kiosk.execute({ setHeader() {} }, async () => {
      throw new CommerceError('REFUND_LIMIT');
    }),
    (e) => e.getResponse().code === 'CONFLICT' && e.getStatus() === 409,
  );
});
