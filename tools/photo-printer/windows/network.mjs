import { networkInterfaces } from 'node:os';
import { privateIPv4 } from '../transport.mjs';

/** Bind only the operator-selected physical adapter, even after its DHCP address changes. */
export function windowsBind(
  config,
  { platform = process.platform, interfaces = networkInterfaces() } = {},
) {
  if (config.windowsInterfaceMac === undefined) return config.bind ?? '127.0.0.1';
  if (
    platform !== 'win32' ||
    config.transport !== 'windows-usb' ||
    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(config.windowsInterfaceMac) ||
    config.windowsInterfaceMac === '00:00:00:00:00:00'
  )
    throw Error('Assigned Windows photo adapter required.');
  const addresses = Object.values(interfaces)
    .flat()
    .filter(
      (item) =>
        item &&
        !item.internal &&
        item.family === 'IPv4' &&
        item.mac.toLowerCase() === config.windowsInterfaceMac.toLowerCase() &&
        privateIPv4(item.address),
    );
  if (addresses.length !== 1)
    throw Error('Assigned photo LAN adapter is unavailable or ambiguous.');
  return addresses[0].address;
}
