import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeCatalogConnectivity } from './connectivity';
import { API_URL } from './api';
import { parseAvailability, type Availability, type AvailabilityReadState } from './availability';
import { AvailabilityRequestError, createAvailabilityRecovery } from './availability-recovery';
import {
  CONNECTION_OK,
  createConnectionTracker,
  shownAvailabilityState,
  type ConnectionTrack,
} from './availability-connection';
import { parseCatalogVersionHeader } from './catalog-recovery';

/** Long poll never mutates a basket, creates an order or sends a payment command. */
export function useAvailability(
  enabled: boolean,
  refresh = 0,
): AvailabilityReadState & { catalogVersion: number | null } {
  // The last answer of the server in this app run. It stays while the reader re-reads or retries
  // (stale-while-revalidate): a single dropped request never hides the payment handle or shows
  // «Нет связи с сервером» (owner 28.10.2026). See availability-connection.ts.
  const [data, setData] = useState<Availability | null>(null);
  const [track, setTrack] = useState<ConnectionTrack>(CONNECTION_OK);
  const trackRef = useRef(track);
  trackRef.current = track;
  // Head publication version reported by the server (X-Catalog-Version); only ever grows.
  const [catalogVersion, setCatalogVersion] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    // A restart (refresh) keeps a problem already shown until the server answers.
    const connection = createConnectionTracker({ initial: trackRef.current, onChange: setTrack });
    const recovery = createAvailabilityRecovery({
      read: async (signal, signature) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        // The server intentionally holds an unchanged signature for 20 seconds. Allow
        // transport latency around that wait; an immediate snapshot has a shorter budget.
        const timeout = setTimeout(abort, signature ? 35_000 : 10_000);
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
          const head = parseCatalogVersionHeader(response.headers.get('x-catalog-version'));
          if (head !== null)
            setCatalogVersion((previous) =>
              previous !== null && previous >= head ? previous : head,
            );
          const body = await response.text();
          if (body.length > 1_000_000) throw Error('INVALID_AVAILABILITY');
          return parseAvailability(JSON.parse(body));
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
        }
      },
      // A re-read keeps the last answer; before the first one the state is «checking» anyway.
      onChecking: () => {},
      onSuccess: (value) => {
        setData(value);
        connection.succeeded();
      },
      // A failed cycle counts; the problem is shown only once it persists (a second failure in a
      // row or five seconds), never for a single dropped request.
      onFailure: (_error, retrying) => connection.failed(retrying ? 'offline' : 'error'),
    });
    const unsubscribe = subscribeCatalogConnectivity({
      setActive: recovery.setActive,
      // The phone itself reports no network: the paused long-poll cannot fail, so it says
      // «offline» here at once; the next successful read (after reconnect) says «online» again.
      setConnected: connection.network,
    });
    return () => {
      recovery.stop();
      unsubscribe();
      connection.stop();
    };
  }, [enabled, refresh]);
  const state = useMemo(() => shownAvailabilityState(data, track), [data, track]);
  return useMemo(() => ({ ...state, catalogVersion }), [state, catalogVersion]);
}
