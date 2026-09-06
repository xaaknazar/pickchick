import { readFile, writeFile } from 'node:fs/promises';
import {
  BranchSchema,
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
    version: '0.3.0',
    description:
      'Local-only foundation with menu sync, trusted local staff sessions, base-SKU quotes and unpaid POS orders. No customer login, public staff enrollment, modifiers/combos, payments, fiscalization or kitchen dispatch.',
  },
  paths: {
    '/health/live': get('liveness', 'Health'),
    '/health/ready': get('readiness', 'Readiness', {
      503: response('Readiness', 'Required dependency unavailable'),
    }),
    '/v1/branches': get('listBranches', 'BranchList'),
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
