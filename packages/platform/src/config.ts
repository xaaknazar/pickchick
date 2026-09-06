import { UuidSchema } from '@pickchick/contracts';

export interface ServiceConfig {
  service: 'api' | 'edge';
  environment: 'local' | 'test';
  databaseUrl: string;
  redisUrl?: string;
  branchId?: string;
  port: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

export function localDatabaseUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid database URL: ${name}`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['/pickchick_cloud', '/pickchick_edge'].includes(url.pathname)
  ) {
    throw new Error(`Foundation requires a dedicated local database: ${name}`);
  }
  return value;
}

export function loadConfig(
  service: 'api' | 'edge',
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const environment = env.APP_ENV;
  if (environment !== 'local' && environment !== 'test') {
    throw new Error('Foundation only supports APP_ENV=local or test; production is not enabled');
  }
  const key = service === 'api' ? 'CLOUD_DATABASE_URL' : 'EDGE_DATABASE_URL';
  const databaseUrl = localDatabaseUrl(required(env, key), key);
  const expectedDatabase = service === 'api' ? '/pickchick_cloud' : '/pickchick_edge';
  if (new URL(databaseUrl).pathname !== expectedDatabase) {
    throw new Error(`Database scope mismatch: ${key}`);
  }
  const portText =
    env[service === 'api' ? 'API_PORT' : 'EDGE_PORT'] ?? (service === 'api' ? '3100' : '3101');
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('Invalid service port');
  }
  const base: ServiceConfig = { service, environment, databaseUrl, port: Number(portText) };
  if (service === 'edge') {
    const branch = UuidSchema.safeParse(required(env, 'EDGE_BRANCH_ID'));
    if (!branch.success) throw new Error('Invalid EDGE_BRANCH_ID');
    return { ...base, branchId: branch.data };
  }
  const redisUrl = required(env, 'REDIS_URL');
  let parsedRedis: URL;
  try {
    parsedRedis = new URL(redisUrl);
  } catch {
    throw new Error('Invalid REDIS_URL');
  }
  if (
    parsedRedis.protocol !== 'redis:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsedRedis.hostname)
  ) {
    throw new Error('Foundation requires local Redis');
  }
  return { ...base, redisUrl };
}
