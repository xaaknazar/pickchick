import { privateIPv4, sendRaster } from './transport.mjs';
import { sendMacUsb, usbPrinters, validUsbUri } from './mac-usb.mjs';
import { sendWindowsQueue, validQueue } from './windows-raw.mjs';

/** Operator configuration only. HTTP clients cannot select or change the destination. */
export async function createPrintTransport(
  config,
  {
    platform = process.platform,
    discover = usbPrinters,
    usb = sendMacUsb,
    tcp = sendRaster,
    queue = sendWindowsQueue,
  } = {},
) {
  const kind = config.transport ?? 'tcp';
  if (!['tcp', 'mac-usb', 'windows-queue'].includes(kind))
    throw Error('Unsupported photo printer transport.');
  const enabled = config.protocolConfirmed === true;
  if (kind === 'windows-queue') {
    // The same receipt printer as the cashier desk: the spooler serialises photo and POS jobs.
    if (platform !== 'win32' || !validQueue(config.printerQueue))
      throw Error('Windows queue requires Windows and the exact printer queue name.');
    if (
      config.usbUri !== undefined ||
      config.printerHost !== undefined ||
      config.printerPort !== undefined
    )
      throw Error('Choose only one photo printer transport.');
    return enabled ? (bytes) => queue(config.printerQueue, bytes) : async () => 'failed';
  }
  if (config.printerQueue !== undefined) throw Error('Choose only one photo printer transport.');
  if (kind === 'mac-usb') {
    if (platform !== 'darwin' || !validUsbUri(config.usbUri))
      throw Error('Mac USB requires macOS and an exact discovered ESC/POS USB URI.');
    if (config.printerHost !== undefined || config.printerPort !== undefined)
      throw Error('Choose only one photo printer transport.');
    if (enabled && !(await discover()).includes(config.usbUri))
      throw Error('Selected ESC/POS USB printer not connected.');
    // sendMacUsb rechecks discovery before each single, paced write. Never fall back to TCP.
    return enabled ? (bytes) => usb(config.usbUri, bytes) : async () => 'failed';
  }
  if (config.usbUri !== undefined) throw Error('Choose only one photo printer transport.');
  if (enabled && !privateIPv4(config.printerHost))
    throw Error('Confirm the private printer IPv4 and ESC/POS raster support first.');
  if (
    config.printerPort !== undefined &&
    (!Number.isInteger(config.printerPort) || config.printerPort < 1 || config.printerPort > 65535)
  )
    throw Error('Invalid printer TCP port.');
  return enabled
    ? (bytes) => tcp({ host: config.printerHost, port: config.printerPort ?? 9100 }, bytes)
    : async () => 'failed';
}
