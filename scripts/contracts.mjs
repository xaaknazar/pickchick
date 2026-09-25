import { readFile, writeFile } from 'node:fs/promises';
import {
  Request as BackofficeRequest,
  Schemas as BackofficeRecords,
} from '@pickchick/backoffice-core/model';
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
  StaffCredentialSchema,
  StaffLoginSchema,
  StaffPinLoginSchema,
  CashMovementInputSchema,
  StopListSchema,
  CartSchema,
  QuoteSchema,
  LocalOrderSchema,
  CashShiftSchema,
  CashShiftOpenSchema,
  CashShiftCloseSchema,
  CashShiftCurrentSchema,
  CashShiftListSchema,
  LocalOrderListSchema,
  CreateLocalOrderSchema,
  CancelLocalOrderSchema,
  OrderingCommandSchema,
  OrderingStateSchema,
  StopCommandSchema,
  StopStateSchema,
  FulfillmentConfigSchema,
  FulfillmentSummarySchema,
  FulfillmentKitchenOrderSchema,
  FulfillmentOrderSchema,
  FulfillmentKitchenSchema,
  FulfillmentStationsSchema,
  FulfillmentDisplaySchema,
  FulfillmentActionSchema,
  jsonSchema,
} from '@pickchick/contracts';
import {
  PullRequestSchema,
  PullResponseSchema,
  TransportAckSchema,
  TransportEdgeEventSchema,
  TransportReceiptSchema,
} from '@pickchick/fulfillment-transport';
import * as testContracts from '@pickchick/test-order-flow/contracts';
import {
  PosOrderEventSchema,
  PosKitchenEventSchema,
  PosOrderReceiptSchema,
} from '@pickchick/pos-order-sync';
import {
  CatalogStateSchema,
  CatalogBranchesSchema,
  CatalogPublicSchema,
  CatalogSaveSchema,
  CatalogSeedSchema,
  CatalogPublishSchema,
} from '@pickchick/catalog-admin/contracts';
import {
  CustomerSchema,
  CustomerSessionSchema,
  CustomerPatchSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  OtpResponseSchema,
  RefreshRequestSchema,
} from '@pickchick/customer-identity';

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
  {
    status = 200,
    idempotent = false,
    orderId = false,
    variantId = false,
    shiftId = false,
    shiftFilter = false,
  } = {},
) {
  const parameters = [];
  if (shiftId)
    parameters.push({
      name: 'shiftId',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  if (shiftFilter)
    parameters.push({
      name: 'shift_id',
      in: 'query',
      required: false,
      schema: { type: 'string', format: 'uuid' },
    });
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
    version: '0.5.0',
    description:
      'Local menu sync and unpaid POS orders, a gated synthetic TEST journey through two kitchen stations, and separate opt-in customer identity. Real identity requires approved policy URLs/version, protected keys, SMS budget and enabled Mobizon delivery. It never authenticates a local demo profile or adopts anonymous TEST history. Real checkout, payments and fiscal provider delivery remain disabled.',
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
    '/edge/v1/staff/login': {
      post: {
        operationId: 'loginLocalStaff',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffLogin' } } },
        },
        responses: {
          200: response('StaffCredential'),
          401: response('Error', 'Invalid login, password, staff or terminal'),
          413: response('Error', 'Login body exceeds 2 KiB'),
          429: {
            ...response('Error', 'AUTH_RATE_LIMITED'),
            headers: { 'Retry-After': { schema: { type: 'string', const: '60' } } },
          },
          503: response('Error', 'Local service unavailable'),
        },
      },
    },
    '/edge/v1/staff/pin': {
      post: {
        operationId: 'loginLocalStaffPin',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/StaffPinLogin' } },
          },
        },
        responses: {
          200: response('StaffCredential'),
          401: response('Error', 'Invalid PIN, staff or terminal'),
          413: response('Error', 'Login body exceeds 2 KiB'),
          429: {
            ...response('Error', 'AUTH_RATE_LIMITED'),
            headers: { 'Retry-After': { schema: { type: 'string', const: '60' } } },
          },
          503: response('Error', 'Local service unavailable'),
        },
      },
    },
    '/edge/v1/staff/logout': {
      post: {
        operationId: 'logoutLocalStaff',
        security: [{ staffBearer: [], staffSession: [] }],
        responses: {
          204: { description: 'Current session revoked' },
          401: response('Error', 'Invalid or expired session'),
          503: response('Error', 'Local service unavailable'),
        },
      },
    },
    '/edge/v1/session': staffOperation('get', 'getLocalStaffSession', 'StaffSession'),
    '/edge/v1/checkout/quotes': staffOperation('post', 'createLocalQuote', 'Quote', 'Cart', {
      status: 201,
    }),
    '/edge/v1/orders': {
      ...staffOperation('get', 'listLocalOrders', 'LocalOrderList', undefined, {
        shiftFilter: true,
      }),
      ...staffOperation('post', 'createLocalOrder', 'LocalOrder', 'CreateLocalOrder', {
        status: 201,
        idempotent: true,
      }),
    },
    '/edge/v1/cash-shifts': {
      ...staffOperation('get', 'listCashShifts', 'CashShiftList'),
      ...staffOperation('post', 'openCashShift', 'CashShift', 'CashShiftOpen', {
        status: 201,
        idempotent: true,
      }),
    },
    '/edge/v1/cash-shifts/current': staffOperation('get', 'currentCashShift', 'CashShiftCurrent'),
    '/edge/v1/cash-shifts/{shiftId}': staffOperation(
      'get',
      'readCashShift',
      'CashShift',
      undefined,
      { shiftId: true },
    ),
    '/edge/v1/cash-shifts/{shiftId}/close': staffOperation(
      'post',
      'closeCashShift',
      'CashShift',
      'CashShiftClose',
      { idempotent: true, shiftId: true },
    ),
    '/edge/v1/cash-shifts/{shiftId}/movements': staffOperation(
      'post',
      'moveLocalCash',
      'CashShift',
      'CashMovementInput',
      { idempotent: true, shiftId: true },
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
    '/edge/v1/availability/stops': {
      ...staffOperation('get', 'listLocalStops', 'StopList'),
      ...staffOperation('post', 'setLocalStop', 'StopState', 'StopCommand', { idempotent: true }),
    },
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
      StaffCredential: jsonSchema(StaffCredentialSchema),
      StaffLogin: jsonSchema(StaffLoginSchema),
      StaffPinLogin: jsonSchema(StaffPinLoginSchema),
      CashMovementInput: jsonSchema(CashMovementInputSchema),
      StopList: jsonSchema(StopListSchema),
      Cart: jsonSchema(CartSchema),
      Quote: jsonSchema(QuoteSchema),
      LocalOrder: jsonSchema(LocalOrderSchema),
      LocalOrderList: jsonSchema(LocalOrderListSchema),
      CashShift: jsonSchema(CashShiftSchema),
      CashShiftOpen: jsonSchema(CashShiftOpenSchema),
      CashShiftClose: jsonSchema(CashShiftCloseSchema),
      CashShiftCurrent: jsonSchema(CashShiftCurrentSchema),
      CashShiftList: jsonSchema(CashShiftListSchema),
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
  parameters.push({
    name: 'catalog_version',
    in: 'query',
    required: false,
    description:
      'Response representation. Omit for strict build-3 compatibility (mockup-v0.2). Select mockup-v0.3 for descriptions, nutrition, variants and selected options. Existing immutable snapshots retain their original version; v0.2 responses project newer choices into readable names without rewriting stored data. Quote input chooses its own catalog version.',
    schema: { type: 'string', enum: ['mockup-v0.2', 'mockup-v0.3'], default: 'mockup-v0.2' },
  });
  parameters.push({
    name: 'number_format',
    in: 'query',
    required: false,
    description:
      'Select daily for a persistent branch-local order number starting at 1 when a new operational shift opens; the parameter name is retained for compatibility. Omit to preserve legacy global T-number responses. UUID remains the order identity.',
    schema: { type: 'string', enum: ['daily'] },
  });
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
  '/v1/test/sessions/continue': testOperation(
    'post',
    'continueTestSession',
    'TestSession',
    'TestContinueSessionInput',
    {
      roles:
        'Explicit continuation for an unrevoked customer with no active or unknown orders. Same actor/token/history/quotas; expired access extends by two hours, active access is unchanged.',
    },
  ),
  '/v1/test/orders': {
    ...testOperation('get', 'listOwnTestOrders', 'TestOrders'),
    ...testOperation('post', 'createTestOrder', 'TestOrder', 'TestCreateOrder', {
      idempotent: true,
      status: 201,
    }),
  },
  '/v1/test/history': testOperation('get', 'listOwnTestHistory', 'TestHistory', undefined, {
    roles:
      'Customer only. Finished orders, newest first, twenty per page. Optional before UUID must belong to this customer.',
  }),
  '/v1/test/orders/{orderId}/feedback': {
    ...testOperation('get', 'readOwnTestFeedback', 'TestFeedback', undefined, {
      path: ['orderId'],
    }),
    ...testOperation('post', 'submitOwnTestFeedback', 'TestFeedback', 'TestFeedbackInput', {
      path: ['orderId'],
      idempotent: true,
    }),
  },
  '/v1/test/orders/watch': testOperation(
    'post',
    'watchOwnTestOrders',
    'TestOrders',
    'TestOrderWatch',
    {
      roles:
        'Customer only. Event-driven wait up to 20s for own committed order versions; snapshot on reconnect. Read-only, no idempotency key.',
    },
  ),
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
    roles:
      'Display or manager. Returns public order numbers only. Optional shift_context=1 adds shift_number with number_format=daily for duplicate numbers across shifts.',
  }),
  '/v1/test/shift': testOperation(
    'get',
    'readTestServiceShift',
    'TestServiceShiftCurrent',
    undefined,
    {
      roles:
        'Manager only. Current operational shift of the synthetic cloud queue; independent of Windows cash shifts.',
    },
  ),
  '/v1/test/shift/open': testOperation(
    'post',
    'openTestServiceShift',
    'TestServiceShiftCurrent',
    'TestServiceShiftChange',
    {
      roles:
        'Manager only. Checks previous shift and version; starts numbering at 1. Null previous identity is valid only before the first shift.',
      idempotent: true,
      status: 201,
    },
  ),
  '/v1/test/shift/close': testOperation(
    'post',
    'closeTestServiceShift',
    'TestServiceShiftCurrent',
    'TestServiceShiftChange',
    {
      roles:
        'Manager only. Stops new orders; existing orders can still complete. Requires the open shift identity and version.',
      idempotent: true,
      status: 201,
    },
  ),
  '/v1/test/manager/orders': testOperation(
    'get',
    'listManagedTestOrders',
    'TestOrders',
    undefined,
    { roles: 'Manager only.' },
  ),
});

Object.assign(openapi.components.schemas, {
  Customer: jsonSchema(CustomerSchema),
  CustomerSession: jsonSchema(CustomerSessionSchema),
  CustomerPatch: jsonSchema(CustomerPatchSchema),
  OtpRequest: jsonSchema(OtpRequestSchema),
  OtpVerify: jsonSchema(OtpVerifySchema),
  OtpResponse: jsonSchema(OtpResponseSchema),
  RefreshRequest: jsonSchema(RefreshRequestSchema),
  CustomerMe: {
    type: 'object',
    additionalProperties: false,
    required: ['customer'],
    properties: { customer: { $ref: '#/components/schemas/Customer' } },
  },
  CustomerOk: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { const: true } },
  },
  CustomerAuthConfig: {
    type: 'object',
    additionalProperties: false,
    required: ['enabled', 'consent_version', 'terms_url', 'privacy_url'],
    properties: {
      enabled: { type: 'boolean' },
      consent_version: { type: ['string', 'null'] },
      terms_url: { type: ['string', 'null'], format: 'uri' },
      privacy_url: { type: ['string', 'null'], format: 'uri' },
    },
  },
});
openapi.components.securitySchemes.customerBearer = {
  type: 'http',
  scheme: 'bearer',
  description:
    'Opaque short-lived customer access token. Refresh rotation is persisted and revocable; no calendar or inactivity logout.',
};
function customerOperation(operationId, result, input, authenticated = false, status = 200) {
  return {
    operationId,
    tags: ['Customer identity'],
    security: authenticated ? [{ customerBearer: [] }] : [],
    description:
      'Separate from synthetic TEST ordering. Disabled by default. Responses are no-store; keys and OTP never appear in logs. Persist device/request UUIDs before mutation, and repeat exact input after an unknown response.',
    ...(input
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${input}` } } },
          },
        }
      : {}),
    responses: {
      [status]: response(result),
      400: response('Error', 'Invalid input or changed consent version'),
      401: response('Error', 'Unverified code or revoked/expired access'),
      409: response('Error', 'Conflicting or consumed command'),
      413: response('Error', 'Request too large'),
      429: response('Error', 'Durable OTP or SMS budget limit'),
      503: response('Error', 'Identity disabled or provider unavailable'),
      500: response('Error', 'Internal error'),
    },
  };
}
Object.assign(openapi.paths, {
  '/v1/auth/config': { get: customerOperation('getCustomerAuthConfig', 'CustomerAuthConfig') },
  '/v1/auth/otp/request': {
    post: customerOperation('requestCustomerOtp', 'OtpResponse', 'OtpRequest', false, 202),
  },
  '/v1/auth/otp/verify': {
    post: customerOperation('verifyCustomerOtp', 'CustomerSession', 'OtpVerify'),
  },
  '/v1/auth/refresh': {
    post: customerOperation('refreshCustomerSession', 'CustomerSession', 'RefreshRequest'),
  },
  '/v1/auth/logout': { post: customerOperation('logoutCustomer', 'CustomerOk', undefined, true) },
  '/v1/customers/me': {
    get: customerOperation('getCustomerProfile', 'CustomerMe', undefined, true),
    patch: customerOperation('patchCustomerProfile', 'CustomerMe', 'CustomerPatch', true),
    delete: customerOperation('deleteCustomerAccount', 'CustomerOk', undefined, true),
  },
});

for (const [name, schema] of Object.entries({
  CatalogStateSchema,
  CatalogBranchesSchema,
  CatalogPublicSchema,
  CatalogSaveSchema,
  CatalogSeedSchema,
  CatalogPublishSchema,
}))
  openapi.components.schemas[name.replace(/Schema$/, '')] = jsonSchema(schema);
openapi.components.securitySchemes.catalogManagerBearer = {
  type: 'http',
  scheme: 'bearer',
  description:
    'Opaque manager credential issued only through the trusted operator CLI; restricted to explicitly assigned branches.',
};
function catalogOperation(operationId, result, input, branch = true, publicRead = false) {
  return {
    operationId,
    tags: ['Catalog'],
    security: publicRead ? [] : [{ catalogManagerBearer: [] }],
    description:
      'Versioned neutral catalog; publication does not enable checkout or replace the old TEST catalog. Mutations require persisted request_id and exact expected revisions. Draft payload is at most 256 KiB; HTTP PUT is capped at 320 KiB. Every response is no-store.',
    ...(branch
      ? {
          parameters: [
            {
              name: 'branchId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
        }
      : {}),
    ...(input
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${input}` } } },
          },
        }
      : {}),
    responses: {
      200: response(result),
      400: response('Error', 'Invalid catalog or input'),
      401: response('Error', 'Invalid manager credential'),
      403: response('Error', 'Branch is outside assigned scope'),
      404: response('Error', 'Unknown branch or no publication'),
      409: response('Error', 'Revision or idempotency conflict'),
      413: response('Error', 'Request too large'),
      429: response('Error', 'HTTP capacity exceeded'),
      503: response('Error', 'Editor disabled'),
      500: response('Error', 'Internal error'),
    },
  };
}
Object.assign(openapi.paths, {
  '/v1/admin/catalog/branches': {
    get: catalogOperation('listCatalogManagerBranches', 'CatalogBranches', undefined, false),
  },
  '/v1/admin/catalog/branches/{branchId}': {
    get: catalogOperation('readCatalogDraft', 'CatalogState'),
  },
  '/v1/admin/catalog/branches/{branchId}/draft/seed': {
    post: catalogOperation('seedMockupCatalogDraft', 'CatalogState', 'CatalogSeed'),
  },
  '/v1/admin/catalog/branches/{branchId}/draft': {
    put: catalogOperation('saveCatalogDraft', 'CatalogState', 'CatalogSave'),
  },
  '/v1/admin/catalog/branches/{branchId}/publish': {
    post: catalogOperation('publishCatalogDraft', 'CatalogState', 'CatalogPublish'),
  },
  '/v1/catalog/branches/{branchId}': {
    get: catalogOperation('readPublishedCatalog', 'CatalogPublic', undefined, true, true),
  },
});

// Staff-only LAN kitchen. No cloud ingress, setup or payment contract is exposed.
Object.assign(openapi.components.schemas, {
  FulfillmentConfig: jsonSchema(FulfillmentConfigSchema),
  FulfillmentSummary: jsonSchema(FulfillmentSummarySchema),
  FulfillmentKitchenOrder: jsonSchema(FulfillmentKitchenOrderSchema),
  FulfillmentOrder: jsonSchema(FulfillmentOrderSchema),
  FulfillmentKitchen: jsonSchema(FulfillmentKitchenSchema),
  FulfillmentStations: jsonSchema(FulfillmentStationsSchema),
  FulfillmentDisplay: jsonSchema(FulfillmentDisplaySchema),
  FulfillmentAction: jsonSchema(FulfillmentActionSchema),
});
openapi.components.securitySchemes.staffTerminal = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Terminal-Id',
  description: 'Must match the active staff session terminal; does not replace the bearer secret.',
};
function fulfillmentOperation(method, operationId, result, input, options = {}, parameters = []) {
  const operation = staffOperation(method, operationId, result, input, options)[method];
  operation.security = [{ staffBearer: [], staffSession: [], staffTerminal: [] }];
  operation.parameters.push(...parameters);
  operation.description =
    'Local edge only, EDGE_FULFILLMENT_ENABLED required. Kitchen/shift_manager session, own branch and active terminal. Responses are no-store and bounded to 3 MiB; commands to 16 KiB. No payment or cloud admission authority.';
  operation.responses[503] = response('Error', 'Device binding or service unavailable');
  return { [method]: operation };
}
const stationParameter = {
  name: 'stationId',
  in: 'query',
  required: false,
  description:
    'Required for kitchen staff; must be assigned to that staff. Shift manager may omit to read its whole branch.',
  schema: { type: 'string', format: 'uuid' },
};
const limitParameter = {
  name: 'limit',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
};
Object.assign(openapi.paths, {
  '/edge/v1/fulfillment/config': get('getLocalFulfillmentConfig', 'FulfillmentConfig'),
  '/edge/v1/fulfillment/stations': fulfillmentOperation(
    'get',
    'getLocalFulfillmentStations',
    'FulfillmentStations',
  ),
  '/edge/v1/fulfillment/kitchen': fulfillmentOperation(
    'get',
    'getLocalKitchenQueue',
    'FulfillmentKitchen',
    undefined,
    {},
    [
      stationParameter,
      limitParameter,
      {
        name: 'afterOrderId',
        in: 'query',
        required: false,
        schema: { type: 'string', format: 'uuid' },
        description: 'Continue the returned cursor until null; begin again for the next poll.',
      },
    ],
  ),
  '/edge/v1/fulfillment/orders/{orderId}': fulfillmentOperation(
    'get',
    'getLocalFulfillmentOrder',
    'FulfillmentOrder',
    undefined,
    { orderId: true },
    [stationParameter],
  ),
  '/edge/v1/fulfillment/orders/{orderId}/actions': fulfillmentOperation(
    'post',
    'actOnLocalFulfillment',
    'FulfillmentSummary',
    'FulfillmentAction',
    { orderId: true, idempotent: true },
  ),
  '/edge/v1/fulfillment/display': fulfillmentOperation(
    'get',
    'getLocalFulfillmentDisplay',
    'FulfillmentDisplay',
    undefined,
    {},
    [
      limitParameter,
      {
        name: 'afterNumber',
        in: 'query',
        required: false,
        schema: { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$', default: '0' },
        description:
          'PostgreSQL bigint decimal, at most 9223372036854775807. Response has only number/state and cursor.',
      },
    ],
  ),
});

Object.assign(openapi.components.schemas, {
  FulfillmentTransportPullRequest: jsonSchema(PullRequestSchema),
  FulfillmentTransportPullResponse: jsonSchema(PullResponseSchema),
  FulfillmentTransportAck: jsonSchema(TransportAckSchema),
  FulfillmentTransportEvent: jsonSchema(TransportEdgeEventSchema),
  FulfillmentTransportReceipt: jsonSchema(TransportReceiptSchema),
});
for (const [path, operationId, input, result, description] of [
  [
    'pull',
    'pullCommercialFulfillment',
    'FulfillmentTransportPullRequest',
    'FulfillmentTransportPullResponse',
    'Claims one eligible admission/authorization event for the authenticated pinned edge. Lease ownership and expiry are required; no bank, fiscal or refund events can be claimed.',
  ],
  [
    'ack',
    'acknowledgeCommercialFulfillment',
    'FulfillmentTransportAck',
    'FulfillmentTransportReceipt',
    'Called only after durable edge inbox/domain commit. The event and original worker/lease are immutable; an expired lease requires reclaim, never deletion of the reservation.',
  ],
  [
    'events',
    'recordEdgeFulfillment',
    'FulfillmentTransportEvent',
    'FulfillmentTransportReceipt',
    'Authenticated immutable versioned edge fact. Admission uses actual device credentials; order/task observations never overwrite commercial money or award loyalty. Reordered facts cannot lower projection versions.',
  ],
])
  openapi.paths['/internal/v1/edge/fulfillment/' + path] = {
    post: {
      operationId,
      description:
        description +
        ' Disabled by default, private transport only; not routed by the public gateway. Requests at most 64 KiB and responses at most 1,300,000 bytes.',
      security: [{ deviceBearer: [], deviceId: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/' + input } } },
      },
      responses: {
        200: response(result),
        400: response('Error', 'Invalid request'),
        401: response('Error', 'Invalid, expired or revoked device'),
        403: response('Error', 'Device binding mismatch'),
        404: response('Error', 'Disabled or missing'),
        409: response('Error', 'Lease, immutable event or version conflict'),
        413: response('Error', 'Request exceeds 64 KiB'),
        503: response('Error', 'Transport unavailable'),
        500: response('Error', 'Internal error'),
      },
    },
  };

Object.assign(openapi.components.schemas, {
  PosOrderSyncEvent: jsonSchema(PosOrderEventSchema),
  PosKitchenSyncEvent: jsonSchema(PosKitchenEventSchema),
  PosOrderSyncReceipt: jsonSchema(PosOrderReceiptSchema),
});
openapi.paths['/internal/v1/edge/pos-orders/events'] = {
  post: {
    operationId: 'observeEdgePosOrder',
    description:
      'Private, disabled-by-default unpaid POS lifecycle observation. Authenticated edge/branch/producer binding; immutable envelope hash, producer sequence identity and strict per-order commercial create v1 then cancel v2, or kitchen version+1. Kitchen has a separate immutable inbox and requires the unpaid commercial snapshot/owner hash. Sequence gaps across different orders are allowed. Never authorizes payment, fiscalization or kitchen admission. Not routed by the public gateway. Maximum accepted event 96 KiB; response 8 KiB.',
    security: [{ deviceBearer: [], deviceId: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            oneOf: [
              { $ref: '#/components/schemas/PosOrderSyncEvent' },
              { $ref: '#/components/schemas/PosKitchenSyncEvent' },
            ],
          },
        },
      },
    },
    responses: {
      200: response('PosOrderSyncReceipt'),
      400: response('Error', 'Malformed, oversized or unsupported event'),
      401: response('Error', 'Invalid, expired or revoked device'),
      403: response('Error', 'Device, branch or producer binding mismatch'),
      404: response('Error', 'Feature disabled'),
      409: response('Error', 'Changed duplicate, snapshot or order version conflict'),
      413: response('Error', 'Global HTTP body limit exceeded'),
      500: response('Error', 'Internal error'),
    },
  },
};

// Branch-scoped operational API. Record payloads are validated by the command discriminator.
openapi.components.schemas.BackofficeRequest = jsonSchema(BackofficeRequest);
for (const [kind, schema] of Object.entries(BackofficeRecords))
  openapi.components.schemas['BackofficeRecord_' + kind] = jsonSchema(schema);
openapi.components.schemas.BackofficeSnapshot = {
  type: 'object',
  required: ['schema_version', 'branch_id', 'records', 'metrics'],
  properties: {
    schema_version: { const: 1 },
    branch_id: { type: 'string', format: 'uuid' },
    records: { type: 'array', items: { type: 'object' } },
    metrics: { type: 'object' },
  },
  additionalProperties: true,
};
openapi.components.schemas.BackofficeResult = { type: 'object', additionalProperties: true };
openapi.components.schemas.BackofficeContent = {
  type: 'object',
  required: ['schema_version', 'branch_id', 'promos', 'games'],
  properties: {
    schema_version: { const: 1 },
    branch_id: { type: 'string', format: 'uuid' },
    promos: { type: 'array', maxItems: 20, items: { type: 'object' } },
    games: { type: 'array', maxItems: 3, items: { type: 'object' } },
  },
  additionalProperties: false,
};
function boOperation(id, result, input, publicRead = false) {
  const op = catalogOperation(id, result, input, true, publicRead);
  op.tags = ['Backoffice'];
  op.description = publicRead
    ? 'Explicitly published, scheduled public content. No guest/staff/order data.'
    : 'Requires explicit manager or analyst grant for this branch. Writes require manager, durable request_id and reason; matching replay returns the previous result. Refunds remain pending until a trusted payment observation. Stock changes and audit commit atomically. HTTP commands are limited to 16 KiB.';
  return op;
}
const boRead = boOperation('readBackoffice', 'BackofficeSnapshot');
boRead.parameters.push({
  name: 'period',
  in: 'query',
  schema: { type: 'string', enum: ['day', 'week', 'month', 'quarter'], default: 'day' },
});
const boOrder = boOperation('readBackofficeOrder', 'BackofficeResult');
boOrder.parameters.push({
  name: 'orderId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});
const boContent = boOperation(
  'readBackofficePublishedContent',
  'BackofficeContent',
  undefined,
  true,
);
boContent.parameters.push({
  name: 'channel',
  in: 'query',
  schema: { type: 'string', enum: ['mobile', 'kiosk', 'display'], default: 'mobile' },
});
Object.assign(openapi.paths, {
  '/v1/admin/backoffice/branches/{branchId}': { get: boRead },
  '/v1/admin/backoffice/branches/{branchId}/orders/{orderId}': { get: boOrder },
  '/v1/admin/backoffice/branches/{branchId}/commands': {
    post: boOperation('executeBackofficeCommand', 'BackofficeResult', 'BackofficeRequest'),
  },
  '/v1/content/branches/{branchId}': { get: boContent },
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
