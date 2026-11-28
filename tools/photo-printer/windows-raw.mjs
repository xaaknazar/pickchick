import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./windows-raw.ps1', import.meta.url));

/** A Windows printer queue name chosen by the operator (e.g. «PickChick XP-A160M»). */
export function validQueue(name) {
  return (
    typeof name === 'string' && /^[\p{L}\p{N} ._()#-]{1,120}$/u.test(name) && name.trim() === name
  );
}

/**
 * One RAW job to the Windows spooler through winspool. The bytes go through stdin only.
 * Exit 0 = `sent` (handed to the spooler, not a paper sensor), 2 = `failed` (queue missing or
 * refused, nothing printed), anything else = `unknown` (never retried automatically).
 */
export function sendWindowsQueue(queue, bytes, { launch = spawn, timeout = 20000 } = {}) {
  if (!validQueue(queue)) return Promise.resolve('failed');
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let started = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    try {
      child = launch(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Queue',
          queue,
        ],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
      );
    } catch {
      resolve('failed');
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(started ? 'unknown' : 'failed');
    }, timeout);
    child.once('error', () => finish(started ? 'unknown' : 'failed'));
    child.once('close', (code) => finish(code === 0 ? 'sent' : code === 2 ? 'failed' : 'unknown'));
    child.stdin.once('error', () => {});
    started = true;
    child.stdin.end(bytes);
  });
}
