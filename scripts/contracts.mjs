import { readFile, writeFile } from 'node:fs/promises';
import {
  BranchSchema,
  CapabilitiesSchema,
  MenuSnapshotSchema,
  HealthSchema,
  ReadinessSchema,
  ErrorSchema,
  EventEnvelopeSchema,
  MenuPublishedSchema,
  MenuPullSchema,
  MenuAckSchema,
  AckReceiptSchema,
  StaffSessionSchema,
  CartSchema,
  QuoteSchema,
  LocalOrderSchema,
  CreateLocalOrderSchema,
  CancelLocalOrderSchema,
  OrderingCommandSchema,
  OrderingStateSchema,
  StopCommandSchema,
  StopStateSchema,
  jsonSchema,
} from '@pickchick/contracts';
import * as testContracts from '@pickchick/test-order-flow/contracts';

const response = (name, description = 'Success') => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
});
const get = (operationId, name, extra = {}) => ({
  get: {
    operationId,
    responses: { 200: response(name), 500: response('Error', 'Internal error'), ...extra },
  },
});
function staffOperation(
  method,
  operationId,
  result,
  input,
  { status = 200, idempotent = false, orderId = false, variantId = false } = {},
) {
  const parameters = [];
  if (variantId)
    parameters.push({
      name: 'variantId',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  if (idempotent)
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  if (orderId)
    parameters.push({
      name: 'orderId',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  return {
    [method]: {
      operationId,
      security: [{ staffBearer: [], staffSession: [] }],
      parameters,
      ...(input
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { $ref: `#/components/schemas/${input}` } },
              },
            },
          }
        : {}),
      responses: {
        [status]: response(result),
        400: response('Error', 'Invalid request'),
        401: response('Error', 'Invalid or expired local staff session'),
        403: response('Error', 'Role cannot perform operation'),
        404: response('Error', 'Resource missing or outside actor scope'),
        409: response('Error', 'Version, idempotency, quote expiry, menu or availability conflict'),
        413: response('Error', 'Request too large'),
        500: response('Error', 'Internal error'),
      },
    },
  };
}
const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'PickChick foundation API',
    version: '0.4.0',
    description:
      'Foundation with local menu sync and unpaid POS orders, plus an explicitly gated synthetic TEST journey through two kitchen stations. TEST orders do not reach a restaurant, bank or fiscal provider. Customer phone login, real payments, fiscalization, modifiers and production kitchen admission remain unavailable.',
  },
  paths: {
    '/health/live': get('liveness', 'Health'),
    '/health/ready': get('readiness', 'Readiness', {
      503: response('Readiness', 'Required dependency unavailable'),
    }),
    '/v1/branches': get('listBranches', 'BranchList'),
    '/v1/capabilities': get('getCapabilities', 'Capabilities'),
    '/v1/branches/{branchId}/menu': {
      get: {
        ...get('getBranchMenu', 'MenuSnapshot', {
          400: response('Error', 'Invalid UUID'),
          404: response('Error', 'No active menu'),
        }).get,
        parameters: [
          {
            name: 'branchId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
      },
    },
    '/edge/v1/menu': get('getLocalMenu', 'MenuSnapshot', {
      404: response('Error', 'No local menu'),
    }),
    '/edge/v1/session': staffOperation('get', 'getLocalStaffSession', 'StaffSession'),
    '/edge/v1/checkout/quotes': staffOperation('post', 'createLocalQuote', 'Quote', 'Cart', {
      status: 201,
    }),
    '/edge/v1/orders': staffOperation(
      'post',
      'createLocalOrder',
      'LocalOrder',
      'CreateLocalOrder',
      { status: 201, idempotent: true },
    ),
    '/edge/v1/orders/{orderId}': staffOperation('get', 'readLocalOrder', 'LocalOrder', undefined, {
      orderId: true,
    }),
    '/edge/v1/orders/{orderId}/cancel': staffOperation(
      'post',
      'cancelUnpaidLocalOrder',
      'LocalOrder',
      'CancelLocalOrder',
      { idempotent: true, orderId: true },
    ),
    '/edge/v1/ordering': staffOperation('get', 'readLocalOrdering', 'OrderingState'),
    '/edge/v1/availability/stops/{variantId}': staffOperation(
      'get',
      'readLocalStop',
      'StopState',
      undefined,
      { variantId: true },
    ),
    '/edge/v1/ordering/open': staffOperation(
      'post',
      'openLocalOrdering',
      'OrderingState',
      'OrderingCommand',
      { idempotent: true },
    ),
    '/edge/v1/ordering/close': staffOperation(
      'post',
      'closeLocalOrdering',
      'OrderingState',
      'OrderingCommand',
      { idempotent: true },
    ),
    '/edge/v1/availability/stops': staffOperation(
      'post',
      'setLocalStop',
      'StopState',
      'StopCommand',
      { idempotent: true },
    ),
    '/internal/v1/edge/sync/pull': {
      get: {
        ...get('pullPendingMenu', 'MenuPull', {
          401: response('Error', 'Invalid or inactive device identity'),
        }).get,
        security: [{ deviceBearer: [], deviceId: [] }],
        description:
          'Returns the oldest unacknowledged event for the authenticated edge branch, or null. Repeated delivery is expected. No caller cursor is accepted.',
      },
    },
    '/internal/v1/edge/sync/ack': {
      post: {
        operationId: 'acknowledgeAppliedMenu',
        security: [{ deviceBearer: [], deviceId: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MenuAck' } } },
        },
        responses: {
          200: response('AckReceipt'),
          400: response('Error', 'Malformed acknowledgment'),
          401: response('Error', 'Invalid or inactive device identity'),
          404: response('Error', 'Event outside device branch or missing'),
          409: response('Error', 'Sequence, release or checksum mismatch'),
          413: response('Error', 'Request body exceeds HTTP limit'),
          500: response('Error', 'Internal error'),
        },
        description:
          'Edge sends only after durable local commit. Cloud activates the release and stores the ACK in one transaction. Duplicate ACK is safe.',
      },
    },
  },
  components: {
    securitySchemes: {
      deviceBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Local provisioned 256-bit device key; revocable and expiring.',
      },
      deviceId: { type: 'apiKey', in: 'header', name: 'X-Device-Id' },
      staffBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Local staff session secret, distinct from cloud device credentials.',
      },
      staffSession: { type: 'apiKey', in: 'header', name: 'X-Staff-Session-Id' },
    },
    schemas: {
      Branch: jsonSchema(BranchSchema),
      Capabilities: jsonSchema(CapabilitiesSchema),
      BranchList: {
        type: 'object',
        additionalProperties: false,
        required: ['branches'],
        properties: { branches: { type: 'array', items: { $ref: '#/components/schemas/Branch' } } },
      },
      MenuSnapshot: jsonSchema(MenuSnapshotSchema),
      Health: jsonSchema(HealthSchema),
      Readiness: jsonSchema(ReadinessSchema),
      Error: jsonSchema(ErrorSchema),
      MenuPublished: jsonSchema(MenuPublishedSchema),
      MenuPull: jsonSchema(MenuPullSchema),
      MenuAck: jsonSchema(MenuAckSchema),
      AckReceipt: jsonSchema(AckReceiptSchema),
      StaffSession: jsonSchema(StaffSessionSchema),
      Cart: jsonSchema(CartSchema),
      Quote: jsonSchema(QuoteSchema),
      LocalOrder: jsonSchema(LocalOrderSchema),
      CreateLocalOrder: jsonSchema(CreateLocalOrderSchema),
      CancelLocalOrder: jsonSchema(CancelLocalOrderSchema),
      OrderingCommand: jsonSchema(OrderingCommandSchema),
      OrderingState: jsonSchema(OrderingStateSchema),
      StopCommand: jsonSchema(StopCommandSchema),
      StopState: jsonSchema(StopStateSchema),
    },
  },
};

// Keep the public TEST contract generated from the same browser-safe schemas
// used by the native client, kiosk, kitchen and runtime validation.
openapi.components.securitySchemes.testBearer = {
  type: 'http',
  scheme: 'bearer',
  description:
    'Opaque expiring TEST customer or station credential; staff issuance is trusted CLI only.',
};
for (const [name, schema] of Object.entries(testContracts)) {
  if (name.endsWith('Schema') && name !== 'TestActorSchema')
    openapi.components.schemas[name.replace(/Schema$/, '')] = jsonSchema(schema);
}
function testOperation(method, operationId, result, input, options = {}) {
  const parameters = (options.path ?? []).map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  }));
  if (options.idempotent)
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  return {
    [method]: {
      operationId,
      tags: ['Synthetic TEST'],
      description: `Only available when TEST_ORDER_FLOW_ENABLED=true. ${options.roles ?? 'Synthetic customer data only.'}`,
      security: options.public ? [] : [{ testBearer: [] }],
      parameters,
      ...(input
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { $ref: `#/components/schemas/${input}` } },
              },
            },
          }
        : {}),
      responses: {
        [options.status ?? 200]: response(result),
        400: response('Error', 'Invalid input'),
        401: response('Error', 'Missing or expired TEST credential'),
        403: response('Error', 'Wrong station role'),
        404: response('Error', 'TEST gate disabled or resource outside actor scope'),
        409: response(
          'Error',
          'Stale version, expired quote, idempotency conflict or unresolved simulation',
        ),
        413: response('Error', 'Body exceeds limit'),
        429: response('Error', 'Durable synthetic quota reached'),
        500: response('Error', 'Internal error'),
        503: response('Error', 'Synthetic branch unavailable'),
      },
    },
  };
}
Object.assign(openapi.paths, {
  '/v1/test/catalog': testOperation('get', 'getTestCatalog', 'TestCatalog', undefined, {
    public: true,
  }),
  '/v1/test/sessions': testOperation(
    'post',
    'createTestSession',
    'TestSession',
    'TestSessionInput',
    { public: true, status: 201 },
  ),
  '/v1/test/quotes': testOperation('post', 'quoteTestCart', 'TestQuote', 'TestCart', {
    idempotent: true,
    status: 201,
  }),
  '/v1/test/orders': {
    ...testOperation('get', 'listOwnTestOrders', 'TestOrders'),
    ...testOperation('post', 'createTestOrder', 'TestOrder', 'TestCreateOrder', {
      idempotent: true,
      status: 201,
    }),
  },
  '/v1/test/orders/{orderId}': testOperation('get', 'readTestOrder', 'TestOrder', undefined, {
    path: ['orderId'],
  }),
  '/v1/test/orders/{orderId}/simulated-payment': testOperation(
    'post',
    'simulateTestPayment',
    'TestOrder',
    'TestPayment',
    { path: ['orderId'], idempotent: true },
  ),
  '/v1/test/orders/{orderId}/cancel': testOperation(
    'post',
    'cancelTestOrder',
    'TestOrder',
    'TestCancellation',
    {
      path: ['orderId'],
      idempotent: true,
      roles: 'Owning customer or manager; no financial refund is produced.',
    },
  ),
  '/v1/test/orders/{orderId}/resolve-payment': testOperation(
    'post',
    'resolveTestPayment',
    'TestOrder',
    'TestResolvePayment',
    { path: ['orderId'], idempotent: true, roles: 'Manager only.' },
  ),
  '/v1/test/kitchen': testOperation('get', 'listTestKitchen', 'TestKitchen', undefined, {
    roles: 'Prep, assembly or manager.',
  }),
  '/v1/test/orders/{orderId}/tasks/{taskId}/complete': testOperation(
    'post',
    'completeTestKitchenTask',
    'TestOrder',
    'TestVersion',
    {
      path: ['orderId', 'taskId'],
      idempotent: true,
      roles: 'Assigned station or manager. Assembly requires all mandatory preparation.',
    },
  ),
  '/v1/test/orders/{orderId}/handoff': testOperation(
    'post',
    'handoffTestOrder',
    'TestOrder',
    'TestVersion',
    { path: ['orderId'], idempotent: true, roles: 'Assembly or manager. Requires ready state.' },
  ),
  '/v1/test/display': testOperation('get', 'readTestDisplay', 'TestDisplay', undefined, {
    roles: 'Display or manager. Returns public order numbers only.',
  }),
  '/v1/test/manager/orders': testOperation(
    'get',
    'listManagedTestOrders',
    'TestOrders',
    undefined,
    { roles: 'Manager only.' },
  ),
});

for (const [filename, value] of [
  ['openapi.json', openapi],
  ['event.schema.json', jsonSchema(EventEnvelopeSchema)],
]) {
  const target = new URL(`../packages/contracts/${filename}`, import.meta.url);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if ((await readFile(target, 'utf8')) !== text)
      throw new Error(`Generated contract drift: ${filename}`);
  } else {
    await writeFile(target, text);
  }
}
console.log('Runtime schemas and generated contracts agree.');
