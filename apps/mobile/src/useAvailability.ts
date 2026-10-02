import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { API_URL } from './api';
import { parseAvailability, type AvailabilityReadState } from './availability';
import { AvailabilityRequestError, createAvailabilityRecovery } from './availability-recovery';

/** Long poll never mutates a basket, creates an order or sends a payment command. */
export function useAvailability(enabled: boolean, refresh = 0) {
  const [state, setState] = useState<AvailabilityReadState>({ data: null, status: 'checking' });
  useEffect(() => {
    if (!enabled) return;
    const recovery = createAvailabilityRecovery({
      read: async (signal, signature) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(abort, 32_000);
        try {
          if (signal.aborted) throw Error('Aborted');
          const response = await fetch(
            `${API_URL}/v1/customer-checkout/availability${signature ? `?after=${signature}` : ''}`,
            {
              signal: controller.signal,
              credentials: 'omit',
              redirect: 'error',
              headers: { Accept: 'application/json' },
            },
          );
          if (!response.ok) throw new AvailabilityRequestError(response.status);
          const body = await response.text();
          if (body.length > 1_000_000) throw Error('INVALID_AVAILABILITY');
          return parseAvailability(JSON.parse(body));
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
        }
      },
      onChecking: () =>
        setState((previous) => (previous.data ? previous : { ...previous, status: 'checking' })),
      onSuccess: (data) => setState({ data, status: 'online' }),
      onFailure: (_error, retrying) =>
        setState((previous) => ({ ...previous, status: retrying ? 'offline' : 'error' })),
    });
    setState((previous) => ({ ...previous, status: 'checking' }));
    const sub = AppState.addEventListener('change', (value) => {
      if (value === 'active') setState((previous) => ({ ...previous, status: 'checking' }));
      recovery.setActive(value === 'active');
    });
    recovery.setActive(
      AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
    );
    return () => {
      recovery.stop();
      sub.remove();
    };
  }, [enabled, refresh]);
  return state;
}
