import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { API_URL } from './api';
import { parseAvailability, type Availability } from './availability';

/** Long poll returns on a changed projection; never refreshes or clears the basket. */
export function useAvailability(enabled: boolean) {
  const [state, setState] = useState<Availability | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false,
      active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
      signature = '';
    let request: AbortController | null = null,
      timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (stopped || !active || request) return;
      const c = new AbortController();
      request = c;
      const timeout = setTimeout(() => c.abort(), 32000);
      let delay = 100;
      try {
        const r = await fetch(
          `${API_URL}/v1/customer-checkout/availability${signature ? `?after=${signature}` : ''}`,
          {
            signal: c.signal,
            credentials: 'omit',
            redirect: 'error',
            headers: { Accept: 'application/json' },
          },
        );
        if (!r.ok) throw Error('Availability unavailable');
        const body = await r.text();
        if (body.length > 1_000_000) throw Error('Invalid availability');
        const next = parseAvailability(JSON.parse(body));
        if (!stopped && active && !c.signal.aborted) {
          setState((previous) =>
            previous?.signature === next.signature && previous.fresh === next.fresh
              ? previous
              : next,
          );
          signature = next.signature === 'disabled' ? '' : next.signature;
        }
        if (!next.enabled) delay = 15000;
      } catch {
        delay = 3000;
        if (!stopped && active) setState((s) => (s ? { ...s, fresh: false } : s));
        signature = '';
      } finally {
        clearTimeout(timeout);
        request = null;
        if (!stopped && active) timer = setTimeout(() => void run(), delay);
      }
    };
    const sub = AppState.addEventListener('change', (value) => {
      active = value === 'active';
      clearTimeout(timer);
      signature = '';
      if (!active) request?.abort();
      else void run();
    });
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      sub.remove();
    };
  }, [enabled]);
  return state;
}
