import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  validWindowsUsbPath,
  windowsUsbPrinters,
  sendWindowsUsb,
} from '../../tools/photo-printer/windows-usb.mjs';
import { createPrintTransport } from '../../tools/photo-printer/printer.mjs';
import { windowsBind } from '../../tools/photo-printer/windows/network.mjs';

const path = String.raw`\\?\usb#vid_1234&pid_5678#UNIT01#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}`;
const helper = String.raw`C:\Program Files\PickChick\PhotoPrinter\PickChickPhotoUsb.exe`;
const bytes = Buffer.from([27, 64, 29, 118, 48]);
test('Windows USB discovery accepts only printer interfaces, exact pinned destination and local helper', async () => {
  assert(validWindowsUsbPath(path));
  for (const wrong of [
    path.replace('28d78fad', 'aaaaaaaa'),
    '\\\\server\\printer',
    'LPT1',
    'USB001',
    `${path}\n`,
    path + ' & whoami',
  ])
    assert(!validWindowsUsbPath(wrong));
  const calls = [];
  assert.deepEqual(
    await windowsUsbPrinters(helper, {
      run: async (...args) => {
        calls.push(args);
        return { stdout: JSON.stringify([{ path }]) };
      },
    }),
    [path],
  );
  assert.deepEqual(calls[0].slice(0, 2), [helper, ['list']]);
  await assert.rejects(windowsUsbPrinters('powershell.exe'));
  await assert.rejects(
    windowsUsbPrinters(helper, { run: async () => ({ stdout: '[{"path":"LPT1"}]' }) }),
  );
});
test('Windows USB sends exactly once, treats lost/partial replies as unknown and never falls back', async () => {
  for (const scenario of ['sent', 'failed', 'unknown', 'crash', 'timeout', 'garbage']) {
    let launches = 0,
      captured = Buffer.alloc(0),
      kills = 0;
    const result = await sendWindowsUsb(helper, path, bytes, {
      discover: async () => [path],
      timeout: 25,
      launch: (exe, args, options) => {
        launches++;
        assert.equal(exe, helper);
        assert.deepEqual(args, ['send', path]);
        assert(!options.shell);
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.kill = () => {
          kills++;
        };
        child.stdin.on('data', (data) => {
          captured = Buffer.concat([captured, data]);
        });
        child.stdin.on('finish', () => {
          if (scenario === 'timeout') return;
          if (scenario !== 'crash') child.stdout.write(scenario + '\r\n');
          child.emit('close', scenario === 'sent' ? 0 : scenario === 'failed' ? 1 : 9);
        });
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    });
    assert.equal(result, ['sent', 'failed'].includes(scenario) ? scenario : 'unknown');
    assert.equal(launches, 1);
    assert.deepEqual(captured, bytes);
    assert.equal(kills, scenario === 'timeout' ? 1 : 0);
  }
});
test('disconnected and malformed Windows USB requests never launch a write', async () => {
  const launch = () => assert.fail('unexpected USB process');
  assert.equal(
    await sendWindowsUsb(helper, path, bytes, { discover: async () => [], launch }),
    'failed',
  );
  assert.equal(
    await sendWindowsUsb(helper, path, bytes, {
      discover: async () => {
        throw Error('offline');
      },
      launch,
    }),
    'failed',
  );
  assert.equal(await sendWindowsUsb(helper, 'USB001', bytes, { launch }), 'failed');
  assert.equal(await sendWindowsUsb(helper, path, Buffer.alloc(524289), { launch }), 'failed');
});
test('Windows photo transport survives unplug/reconnect without a new token or TCP fallback', async () => {
  let connected = false,
    calls = 0;
  const send = await createPrintTransport(
    {
      transport: 'windows-usb',
      windowsUsbHelper: helper,
      windowsUsbPath: path,
      protocolConfirmed: true,
    },
    {
      platform: 'win32',
      discoverWindows: async () => (connected ? [path] : []),
      windowsUsb: async (exe, p, payload) => {
        calls++;
        assert.equal(exe, helper);
        assert.equal(p, path);
        assert.equal(payload, bytes);
        return 'sent';
      },
      tcp: () => assert.fail('no TCP fallback'),
    },
  );
  assert.equal(await send.ready(), false);
  connected = true;
  assert.equal(await send.ready(), true);
  assert.equal(await send(bytes), 'sent');
  assert.equal(calls, 1);
  connected = false;
  assert.equal(await send.ready(), false);
  const disabled = await createPrintTransport(
    { transport: 'windows-usb', windowsUsbHelper: helper, windowsUsbPath: path },
    { platform: 'win32', discoverWindows: () => assert.fail('disabled probe') },
  );
  assert.equal(await disabled.ready(), false);
  assert.equal(await disabled(bytes), 'failed');
  for (const config of [
    {
      transport: 'windows-usb',
      windowsUsbHelper: helper,
      windowsUsbPath: path,
      printerHost: '192.168.1.2',
    },
    { transport: 'tcp', windowsUsbHelper: helper },
    { transport: 'windows-usb', windowsUsbHelper: helper, windowsUsbPath: 'USB001' },
  ])
    await assert.rejects(createPrintTransport(config, { platform: 'win32' }));
});
test('Windows DHCP follows only the configured physical MAC and rejects ambiguous/foreign networks', () => {
  const mac = '02:11:22:33:44:55',
    config = { transport: 'windows-usb', windowsInterfaceMac: mac };
  const physical = { address: '192.168.2.61', mac, internal: false, family: 'IPv4' };
  const interfaces = {
    WiFi: [physical],
    VPN: [{ ...physical, mac: '02:99:88:77:66:55', address: '10.0.0.1' }],
  };
  assert.equal(windowsBind(config, { platform: 'win32', interfaces }), '192.168.2.61');
  physical.address = '192.168.3.33';
  assert.equal(windowsBind(config, { platform: 'win32', interfaces }), '192.168.3.33');
  for (const address of ['169.254.1.1', '8.8.8.8', '127.0.0.1']) {
    physical.address = address;
    assert.throws(() => windowsBind(config, { platform: 'win32', interfaces }));
  }
  physical.address = '192.168.2.61';
  interfaces.WiFi.push({ ...physical, address: '192.168.2.62' });
  assert.throws(() => windowsBind(config, { platform: 'win32', interfaces }));
  assert.throws(() => windowsBind(config, { platform: 'darwin', interfaces }));
  assert.equal(windowsBind({ bind: '127.0.0.1' }), '127.0.0.1');
});
