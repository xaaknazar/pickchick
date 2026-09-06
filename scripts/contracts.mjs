import { readFile, writeFile } from 'node:fs/promises';
import {
  BranchSchema,
  MenuSnapshotSchema,
  HealthSchema,
  ReadinessSchema,
  ErrorSchema,
  EventEnvelopeSchema,
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
    version: '0.1.0',
    description:
      'Local-only, read-only foundation. No checkout, authentication or payment API is implemented.',
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
  },
  components: {
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
