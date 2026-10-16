import https from 'node:https';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhotoService, handler } from './service.mjs';
import { privateIPv4 } from './transport.mjs';
import { createPrintTransport } from './printer.mjs';
import { windowsBind } from './windows/network.mjs';

process.umask(0o077);
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node server.mjs /private/photo-printer.json [--pair]');
const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
const enabled = config.protocolConfirmed === true;
if (![384, 512, 576].includes(config.width ?? 576)) throw new Error('Invalid raster width.');
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
  throw new Error('A dedicated HTTPS service port is required.');
const bind = windowsBind(config);
if (bind !== '127.0.0.1' && !privateIPv4(bind))
  throw new Error('Bind photo HTTPS to loopback or one private LAN IPv4, never all interfaces.');
const send = await createPrintTransport(config);
const database = resolve(config.database);
mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
const service = new PhotoService({
  database,
  logoPath: fileURLToPath(new URL('../../apps/kiosk/assets/v3/logo.webp', import.meta.url)),
  width: config.width ?? 576,
  cut: config.cut === true,
  enabled,
  send,
});
const server = https.createServer(
  { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey), minVersion: 'TLSv1.2' },
  handler(service),
);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.maxRequestsPerSocket = 100;
server.listen(config.port, bind, () => {
  console.log('PickChick photo service started. No photograph is stored on disk.');
  if (process.argv.includes('--pair'))
    console.log('One-use kiosk pairing code (5 minutes):', service.pairing());
});
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  // Drain a submitted job; a forced interruption leaves its durable state 'unknown'.
  setTimeout(() => process.exit(code), 35000).unref();
  server.close(() => {
    const drained = () => {
      if (service.printing || service.rendering) return false;
      service.close();
      process.exit(code);
      return true;
    };
    // A disconnected client can leave a native USB transfer running after HTTP closes.
    if (!drained()) setInterval(drained, 100);
  });
}
if (config.windowsInterfaceMac !== undefined)
  setInterval(() => {
    try {
      if (windowsBind(config) === bind) return;
    } catch {
      /* DHCP/network loss */
    }
    // Windows service recovery resolves the same adapter again. No job is replayed.
    stop(1);
  }, 5000).unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0));
