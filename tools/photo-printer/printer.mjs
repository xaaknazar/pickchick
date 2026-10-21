import { privateIPv4, sendRaster } from './transport.mjs';
import { sendMacUsb, usbPrinters, validUsbUri } from './mac-usb.mjs';

/** Operator configuration only. HTTP clients cannot select or change the destination. */
export async function createPrintTransport(
  config,
  { platform = process.platform, discover = usbPrinters, usb = sendMacUsb, tcp = sendRaster } = {},
) {
  const kind = config.transport ?? 'tcp';
  if (!['tcp', 'mac-usb'].includes(kind)) throw Error('Unsupported photo printer transport.');
  const enabled = config.protocolConfirmed === true;
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
