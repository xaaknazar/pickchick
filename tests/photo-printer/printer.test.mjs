import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrintTransport } from '../../tools/photo-printer/printer.mjs';

const uri = 'usb://Printer/POS-80?serial=TEST';
test('native HTTPS transport routes one payload only to the discovered Mac USB device', async () => {
  const bytes = Buffer.from([27, 64, 29, 118]);
  const calls = [];
  const send = await createPrintTransport(
    { transport: 'mac-usb', usbUri: uri, protocolConfirmed: true },
    {
      platform: 'darwin',
      discover: async () => [uri],
      usb: async (selected, payload) => {
        calls.push({ selected, payload });
        return 'unknown';
      },
      tcp: () => assert.fail('no fallback after unknown USB result'),
    },
  );
  assert.equal(await send(bytes), 'unknown');
  assert.deepEqual(calls, [{ selected: uri, payload: bytes }]);
});
test('disabled USB permits setup without discovery or a print side effect', async () => {
  const unexpected = () => assert.fail('disabled transport touched hardware');
  const send = await createPrintTransport(
    { transport: 'mac-usb', usbUri: uri },
    { platform: 'darwin', discover: unexpected, usb: unexpected, tcp: unexpected },
  );
  assert.equal(await send(Buffer.from('x')), 'failed');
});
test('incorrect platform, missing device, mixed destinations and unknown drivers fail closed', async () => {
  const options = { platform: 'darwin', discover: async () => [] };
  await assert.rejects(
    createPrintTransport({ transport: 'mac-usb', usbUri: uri }, { platform: 'win32' }),
    /macOS/,
  );
  await assert.rejects(
    createPrintTransport({ transport: 'mac-usb', usbUri: uri, protocolConfirmed: true }, options),
    /not connected/,
  );
  for (const config of [
    { transport: 'raw-shell' },
    { transport: 'mac-usb', usbUri: uri + '&copies=2' },
    { transport: 'mac-usb', usbUri: uri, printerHost: '192.168.1.9' },
    { usbUri: uri, printerHost: '192.168.1.9' },
    { printerHost: '8.8.8.8', protocolConfirmed: true },
    { printerHost: '192.168.1.9', printerPort: 0 },
  ])
    await assert.rejects(createPrintTransport(config, options));
});
test('existing Ethernet configurations retain the private address, port and single-send behavior', async () => {
  const bytes = Buffer.from('raster');
  let calls = 0;
  const send = await createPrintTransport(
    { printerHost: '192.168.1.9', printerPort: 9101, protocolConfirmed: true },
    {
      tcp: async (destination, payload) => {
        calls++;
        assert.deepEqual(destination, { host: '192.168.1.9', port: 9101 });
        assert.equal(payload, bytes);
        return 'sent';
      },
    },
  );
  assert.equal(await send(bytes), 'sent');
  assert.equal(calls, 1);
});
