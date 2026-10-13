/** Independent telemetry: it cannot create a guest, change a cart or retry a payment. */
export function startDevicePresence(io: {
  readDevice(): Promise<string | null>;
  snapshot(): {
    state: 'active' | 'background';
    issue: 'none' | 'connection' | 'data' | 'login' | 'demo';
    menuVersion: number | null;
  };
  appVersion: string;
  origin: string;
  fetcher?: typeof fetch;
}) {
  const origin = new URL(io.origin);
  if (
    origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))
  )
    throw new Error('Unsafe telemetry origin');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Invalid telemetry origin');
  let stopped = false,
    busy = false;
  const send = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const raw = await io.readDevice();
      if (stopped || !raw || raw.length > 1000) return;
      const d = JSON.parse(raw) as { deviceId?: unknown; key?: unknown };
      if (
        typeof d.deviceId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(d.deviceId) ||
        typeof d.key !== 'string' ||
        !/^[a-f0-9]{64}$/.test(d.key)
      )
        return;
      await (io.fetcher ?? fetch)(origin.origin + '/v1/kiosk-checkout/device-presence', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          'Content-Type': 'application/json',
          'X-Kiosk-Device': d.deviceId,
          'X-Kiosk-Key': d.key,
        },
        body: JSON.stringify({ appVersion: io.appVersion, ...io.snapshot() }),
      });
    } catch {
      /* Telemetry failure must not interrupt a guest or expose credentials. */
    } finally {
      busy = false;
    }
  };
  void send();
  const timer = setInterval(() => {
    if (io.snapshot().state === 'active') void send();
  }, 15000);
  return {
    send,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
