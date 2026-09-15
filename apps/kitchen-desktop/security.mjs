import { allowed, createKitchenServer, validateUpstream } from './gateway.mjs';

// The origin is part of the operation journal's identity. Never pick a free port
// or accept a caller-supplied URL: either own this listener or fail closed.
export const APP_PORT = 4178;
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
export const APP_URL = `${APP_ORIGIN}/`;
export const ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'api.js',
  'model.js',
  'runtime.js',
  'types.js',
  'logo.png',
  'bg-blue.png',
  'fonts/golos-text-2f175b8fc40e.woff2',
  'fonts/golos-text-f8d71091110f.woff2',
  'fonts/montserrat-6438d7b8ea9c.woff2',
  'fonts/montserrat-0b00fbd6edcc.woff2',
];
const paths = new Set([
  '/',
  '/config.json',
  ...ASSETS.filter((n) => n !== 'index.html').map((n) => '/' + n),
]);

export function validateConfig(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        !['edgePort', 'branchLabel', 'edgeHost', 'edgeCertificatePem', 'terminalId'].includes(key),
    )
  )
    throw new Error('INVALID_KITCHEN_CONFIG');
  const edgePort = value.edgePort === undefined ? 3101 : value.edgePort;
  const branchLabel = value.branchLabel === undefined ? 'Локальная точка' : value.branchLabel;
  if (
    !Number.isInteger(edgePort) ||
    edgePort < 1 ||
    edgePort > 65535 ||
    edgePort === APP_PORT ||
    typeof branchLabel !== 'string' ||
    branchLabel.length < 1 ||
    branchLabel.length > 120 ||
    [...branchLabel].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('INVALID_KITCHEN_CONFIG');
  const upstream = validateUpstream(value);
  if (
    value.terminalId !== undefined &&
    (typeof value.terminalId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.terminalId,
      ))
  )
    throw new Error('INVALID_KITCHEN_CONFIG');
  return Object.freeze({
    edgePort,
    branchLabel,
    ...upstream,
    ...(value.terminalId === undefined ? {} : { terminalId: value.terminalId }),
  });
}

export function isAllowedRendererRequest(raw, method = 'GET') {
  if (typeof raw !== 'string' || !raw.startsWith(APP_ORIGIN + '/') || /[%#\\]/.test(raw))
    return false;
  try {
    const url = new URL(raw);
    if (url.origin !== APP_ORIGIN || url.username || url.password) return false;
    const path = raw.slice(APP_ORIGIN.length);
    if (path !== url.pathname + url.search) return false;
    return (method === 'GET' && paths.has(path)) || allowed(method, path);
  } catch {
    return false;
  }
}

export async function startGateway({ config, assetDir }) {
  const gateway = createKitchenServer({ ...validateConfig(config), assetDir });
  await new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    gateway.once('error', failed);
    gateway.listen(APP_PORT, '127.0.0.1', () => {
      gateway.removeListener('error', failed);
      resolve();
    });
  });
  return gateway;
}
