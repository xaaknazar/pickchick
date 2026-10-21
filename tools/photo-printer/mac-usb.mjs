import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

const execute = promisify(execFile);
const backend = '/usr/libexec/cups/backend/usb';
export function validUsbUri(uri) {
  return (
    typeof uri === 'string' &&
    /^usb:\/\/[A-Za-z0-9%._-]+\/[A-Za-z0-9%._-]+\?serial=[A-Za-z0-9._-]+$/.test(uri)
  );
}
export async function usbPrinters() {
  const { stdout } = await execute(backend, [], { timeout: 5000, maxBuffer: 65536 });
  return stdout.split('\n').flatMap((line) => {
    const match = /^direct (\S+) /.exec(line);
    return match && validUsbUri(match[1]) && /CMD:[^;]*ESC\/POS[;,]/.test(line) ? [match[1]] : [];
  });
}

/** Direct stdin transfer: no CUPS queue/spool file, scheduler retries or default printer. */
export async function sendMacUsb(
  uri,
  bytes,
  {
    discover = usbPrinters,
    launch = spawn,
    timeout = 15000,
    delay = pause,
    report = () => {},
  } = {},
) {
  if (!validUsbUri(uri)) return 'failed';
  try {
    if (!(await discover()).includes(uri)) return 'failed';
  } catch {
    return 'failed';
  }
  return new Promise((resolve) => {
    let attempted = false;
    let written = false;
    let pipeError = false;
    let closed = false;
    let timedOut = false;
    let child;
    try {
      child = launch(backend, ['1', 'pickchick-photo', 'PickChick photo', '1', ''], {
        env: { PATH: '/usr/bin:/bin', DEVICE_URI: uri, CONTENT_TYPE: 'application/vnd.cups-raw' },
        stdio: ['pipe', 'ignore', 'ignore', 'ignore', 'ignore'],
      });
    } catch {
      resolve('failed');
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(attempted ? 'unknown' : 'failed');
    });
    child.once('close', (code) => {
      closed = true;
      clearTimeout(timer);
      report({ code, timedOut, written, pipeError });
      resolve(code === 0 && written && !pipeError ? 'sent' : attempted ? 'unknown' : 'failed');
    });
    child.stdin.on('error', () => {
      pipeError = true;
    });
    child.once('spawn', async () => {
      attempted = true;
      try {
        // Bound each burst; cheap USB controllers may accept data faster than their thermal
        // image buffer consumes it. One child/one copy, never restart after partial output.
        for (let offset = 0; offset < bytes.length; offset += 1024) {
          if (closed || pipeError) return;
          await new Promise((resolve, reject) =>
            child.stdin.write(bytes.subarray(offset, offset + 1024), (error) =>
              error ? reject(error) : resolve(),
            ),
          );
          if (offset + 1024 < bytes.length) await delay(40);
        }
        child.stdin.end(() => {
          written = true;
        });
      } catch {
        pipeError = true;
        child.kill('SIGKILL');
      }
    });
  });
}
