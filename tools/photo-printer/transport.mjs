import net from 'node:net';

export function privateIPv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Exactly one connection/write. A lost result is UNKNOWN, never an automatic reprint. */
export function sendRaster({ host, port = 9100 }, bytes) {
  return new Promise((resolve) => {
    let attempted = false;
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    const socket = net.createConnection({ host, port });
    socket.setTimeout(8000);
    socket.once('connect', () => {
      attempted = true;
      socket.end(bytes, () => finish('sent'));
    });
    socket.once('timeout', () => finish(attempted ? 'unknown' : 'failed'));
    socket.once('error', () => finish(attempted ? 'unknown' : 'failed'));
    socket.once('close', () => finish(attempted ? 'unknown' : 'failed'));
  });
}
