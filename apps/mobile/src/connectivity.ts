import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { API_URL } from './api';

NetInfo.configure({
  reachabilityUrl: `${API_URL}/health/live`,
  reachabilityMethod: 'GET',
  reachabilityTest: async (response) => response.status === 200,
  reachabilityShortTimeout: 2000,
  reachabilityLongTimeout: 15000,
});

/** Reconnect wakes public reads only. Never resumes an order or payment command. */
export function subscribeCatalogConnectivity(recovery: {
  setActive(active: boolean): void;
  /**
   * The device's own network observation, apart from the foreground: a paused reader can still
   * say «Нет связи» (owner 28.10.2026: no payment handle without a connection). Read-only.
   */
  setConnected?(connected: boolean): void;
}) {
  let foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  let connected = true;
  let disposed = false;
  let revision = 0;
  const apply = () => {
    if (disposed) return;
    recovery.setConnected?.(connected);
    recovery.setActive(foreground && connected);
  };
  const app = AppState.addEventListener('change', (state) => {
    const next = state === 'active';
    if (disposed || foreground === next) return;
    foreground = next;
    const requestedRevision = ++revision;
    apply();
    if (foreground) {
      // iOS can miss network events while suspended. Refresh the native snapshot;
      // a newer network event, another background transition or cleanup wins.
      void NetInfo.refresh().then(
        (networkState) => {
          if (disposed || !foreground || revision !== requestedRevision) return;
          connected = networkState.isConnected !== false;
          apply();
        },
        () => {
          // Retain the last observation; a failed probe does not prove connectivity.
        },
      );
    }
  });
  const network = NetInfo.addEventListener((state) => {
    if (disposed) return;
    revision++;
    // Reachability is a separate, sometimes stale OS/probe opinion, not the API result.
    // Keep public reads running while a network interface exists; their responses decide
    // server availability. A definite interface disconnect still pauses reads immediately.
    connected = state.isConnected !== false;
    apply();
  });
  apply();
  return () => {
    disposed = true;
    revision++;
    app.remove();
    network();
  };
}
