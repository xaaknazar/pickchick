import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { TestCustomerClient } from '../test-client';
import type { ComboProgressState } from './combo-progress';

// One shared request per app model, never one per visible promotion card.
// No local persistence: account switches must not expose another customer's progress.
export function useComboProgress(
  client: TestCustomerClient,
  enabled: boolean,
  orderRevision: string,
): ComboProgressState {
  const [snapshot, setSnapshot] = useState<{
    client: TestCustomerClient;
    state: ComboProgressState;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let request: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const load = async () => {
      if (stopped || request || AppState.currentState === 'background') return;
      clearTimeout(retry);
      const controller = new AbortController();
      request = controller;
      try {
        const data = await client.comboProgress(controller.signal);
        if (!stopped && !controller.signal.aborted) {
          failures = 0;
          setSnapshot({ client, state: { status: 'ready', data } });
        }
      } catch {
        if (!stopped && !controller.signal.aborted) {
          setSnapshot({ client, state: { status: 'error', data: null } });
          retry = setTimeout(() => void load(), Math.min(60000, 5000 * 2 ** failures++));
        }
      } finally {
        if (request === controller) request = undefined;
      }
    };
    void load();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
      else {
        request?.abort();
        request = undefined;
        clearTimeout(retry);
      }
    });
    return () => {
      stopped = true;
      request?.abort();
      clearTimeout(retry);
      subscription.remove();
    };
  }, [client, enabled, orderRevision]);
  if (!enabled) return { status: 'signed_out', data: null };
  return snapshot?.client === client ? snapshot.state : { status: 'loading', data: null };
}
