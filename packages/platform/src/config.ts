import { UuidSchema } from '@pickchick/contracts';
import { isIP } from 'node:net';

export interface ServiceConfig {
  service: 'api' | 'edge';
  environment: 'local' | 'test' | 'staging';
  databaseUrl: string;
  redisUrl?: string;
  branchId?: string;
  testOrderFlowEnabled?: boolean;
  port: number;
  databasePoolMax?: number;
  httpMaxInFlight?: number;
  customerAuthEnabled?: boolean;
  catalogAdminEnabled?: boolean;
  trustedProxyIps?: string[];
  edgeFulfillmentEnabled?: boolean;
  edgeDeviceId?: string;
  fulfillmentTransportEnabled?: boolean;
}

function boundedInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number) {
  const value = env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max)
    throw new Error(`Invalid configuration: ${name}`);
  return Number(value);
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
  if (environment !== 'local' && environment !== 'test' && environment !== 'staging') {
    throw new Error('Unsupported APP_ENV; production is not enabled');
  }
  if (environment === 'staging' && service !== 'api')
    throw new Error('Staging is only enabled for the cloud API');
  const testOrderFlow = env.TEST_ORDER_FLOW_ENABLED ?? 'false';
  if (testOrderFlow !== 'true' && testOrderFlow !== 'false')
    throw new Error('TEST_ORDER_FLOW_ENABLED must be true or false');
  if (testOrderFlow === 'true' && service !== 'api')
    throw new Error('TEST order flow is only enabled for the cloud API');
  const customerAuth = env.CUSTOMER_AUTH_ENABLED ?? 'false';
  if (!['true', 'false'].includes(customerAuth))
    throw new Error('CUSTOMER_AUTH_ENABLED must be true or false');
  if (customerAuth === 'true' && service !== 'api')
    throw new Error('Customer identity belongs to cloud API');
  const catalogAdmin = env.CATALOG_ADMIN_ENABLED ?? 'false';
  if (!['true', 'false'].includes(catalogAdmin))
    throw new Error('CATALOG_ADMIN_ENABLED must be true or false');
  if (catalogAdmin === 'true' && service !== 'api')
    throw new Error('Catalog editor belongs to cloud API');
  const fulfillment = env.EDGE_FULFILLMENT_ENABLED ?? 'false';
  if (!['true', 'false'].includes(fulfillment))
    throw new Error('EDGE_FULFILLMENT_ENABLED must be true or false');
  if (fulfillment === 'true' && service !== 'edge')
    throw new Error('Local fulfillment belongs to the edge service');
  if (fulfillment === 'true' && !UuidSchema.safeParse(env.EDGE_DEVICE_ID).success)
    throw new Error('Enabled local fulfillment requires EDGE_DEVICE_ID');
  for (const [key, owner] of [
    ['CLOUD_FULFILLMENT_TRANSPORT_ENABLED', 'api'],
    ['EDGE_FULFILLMENT_TRANSPORT_ENABLED', 'edge'],
  ]) {
    const value = env[key!] ?? 'false';
    if (!['true', 'false'].includes(value))
      throw new Error('Fulfillment transport flag must be true or false');
    if (value === 'true' && service !== owner)
      throw new Error('Fulfillment transport flag service mismatch');
  }
  const transport =
    env[
      service === 'api'
        ? 'CLOUD_FULFILLMENT_TRANSPORT_ENABLED'
        : 'EDGE_FULFILLMENT_TRANSPORT_ENABLED'
    ] === 'true';
  if (transport && service === 'edge' && fulfillment !== 'true')
    throw new Error('Edge transport requires enabled local fulfillment');
  const proxyIps = env.TRUSTED_PROXY_IPS?.split(',').map((ip) => ip.trim());
  if (
    proxyIps &&
    (proxyIps.length > 8 || proxyIps.some((ip) => !isIP(ip) || ['0.0.0.0', '::'].includes(ip)))
  )
    throw new Error('TRUSTED_PROXY_IPS requires explicit proxy IP addresses');
  const key = service === 'api' ? 'CLOUD_DATABASE_URL' : 'EDGE_DATABASE_URL';
  const databaseUrl =
    environment === 'staging'
      ? stagingUrl(required(env, key), 'postgresql:', 'cloud-db', '/pickchick_cloud', key)
      : localDatabaseUrl(required(env, key), key);
  const expectedDatabase = service === 'api' ? '/pickchick_cloud' : '/pickchick_edge';
  if (new URL(databaseUrl).pathname !== expectedDatabase) {
    throw new Error(`Database scope mismatch: ${key}`);
  }
  const portText =
    env[service === 'api' ? 'API_PORT' : 'EDGE_PORT'] ?? (service === 'api' ? '3100' : '3101');
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('Invalid service port');
  }
  const base: ServiceConfig = {
    service,
    environment,
    databaseUrl,
    port: Number(portText),
    testOrderFlowEnabled: testOrderFlow === 'true',
    databasePoolMax: boundedInteger(env, 'DB_POOL_MAX', 5, 64),
    httpMaxInFlight: boundedInteger(env, 'HTTP_MAX_IN_FLIGHT', 32, 1024),
    ...(customerAuth === 'true' ? { customerAuthEnabled: true } : {}),
    ...(catalogAdmin === 'true' ? { catalogAdminEnabled: true } : {}),
    ...(fulfillment === 'true'
      ? { edgeFulfillmentEnabled: true, edgeDeviceId: env.EDGE_DEVICE_ID! }
      : {}),
    ...(proxyIps ? { trustedProxyIps: proxyIps } : {}),
    ...(transport ? { fulfillmentTransportEnabled: true } : {}),
  };
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
  if (environment === 'staging') {
    stagingUrl(redisUrl, 'redis:', 'redis-cache', '/0', 'REDIS_URL');
  } else if (
    parsedRedis.protocol !== 'redis:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsedRedis.hostname)
  ) {
    throw new Error('Foundation requires local Redis');
  }
  return { ...base, redisUrl };
}

// This is a private Docker network contract, not permission to connect to arbitrary hosts.
function stagingUrl(value: string, protocol: string, host: string, path: string, name: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol === protocol &&
      url.hostname === host &&
      url.pathname === path &&
      url.username &&
      /^[a-f0-9]{64}$/.test(url.password) &&
      !url.search &&
      !url.hash &&
      url.port === (protocol === 'postgresql:' ? '5432' : '6379')
    )
      return value;
  } catch {
    /* Do not disclose the URL or password. */
  }
  throw new Error(`Invalid private staging configuration: ${name}`);
}
