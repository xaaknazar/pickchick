import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';

const execute = promisify(execFile);
export function validWindowsUsbPath(value) {
  return (
    typeof value === 'string' &&
    /^\\\\\?\\usb#vid_[a-f0-9]{4}&pid_[a-f0-9]{4}(?:&mi_[a-f0-9]{2})?#[a-z0-9&._-]{1,160}#\{28d78fad-5a12-11d1-ae5b-0000f803a8c2\}$/i.test(
      value,
    )
  );
}
export function validWindowsHelper(value) {
  return (
    typeof value === 'string' &&
    /^[A-Za-z]:\\/.test(value) &&
    win32.isAbsolute(value) &&
    !/[\r\n"<>|]/.test(value) &&
    win32.basename(value) === 'PickChickPhotoUsb.exe'
  );
}
export async function windowsUsbPrinters(helper, { run = execute } = {}) {
  if (!validWindowsHelper(helper)) throw Error('Pinned Windows photo helper required.');
  const { stdout } = await run(helper, ['list'], {
    timeout: 8000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  const entries = JSON.parse(stdout);
  if (!Array.isArray(entries) || entries.some((p) => !validWindowsUsbPath(p?.path)))
    throw Error('Invalid USB discovery.');
  return entries.map((p) => p.path);
}

/** Direct usbprint.sys transfer. Lost acknowledgement is unknown, never a new job. */
export async function sendWindowsUsb(
  helper,
  path,
  bytes,
  { discover = windowsUsbPrinters, launch = spawn, timeout = 30000 } = {},
) {
  if (
    !validWindowsHelper(helper) ||
    !validWindowsUsbPath(path) ||
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > 524288
  )
    return 'failed';
  try {
    if (!(await discover(helper)).includes(path)) return 'failed';
  } catch {
    return 'failed';
  }
  return new Promise((resolve) => {
    let attempted = false,
      output = '',
      settled = false,
      child;
    const finish = (state) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(state);
      }
    };
    let timer;
    try {
      child = launch(helper, ['send', path], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve('failed');
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(attempted ? 'unknown' : 'failed');
    }, timeout);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 1024) {
        child.kill('SIGKILL');
        finish(attempted ? 'unknown' : 'failed');
      }
    });
    child.stdin.on('error', () => {
      child.kill('SIGKILL');
      finish(attempted ? 'unknown' : 'failed');
    });
    child.once('error', () => finish(attempted ? 'unknown' : 'failed'));
    child.once('close', (code) => {
      const result = output.trim();
      finish(
        code === 0 && result === 'sent'
          ? 'sent'
          : code === 1 && result === 'failed'
            ? 'failed'
            : attempted
              ? 'unknown'
              : 'failed',
      );
    });
    child.once('spawn', () => {
      attempted = true;
      child.stdin.end(bytes);
    });
  });
}
