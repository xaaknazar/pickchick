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
const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'PickChick foundation API',
    version: '0.2.0',
    description:
      'Local-only foundation with authenticated edge menu pull/ACK. Device setup and menu publication are trusted local CLI operations. No customer/staff authentication, checkout or payments.',
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
