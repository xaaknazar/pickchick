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
export function subscribeCatalogConnectivity(recovery: { setActive(active: boolean): void }) {
  let foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  let connected = true;
  const apply = () => recovery.setActive(foreground && connected);
  const app = AppState.addEventListener('change', (state) => {
    foreground = state === 'active';
    apply();
  });
  const network = NetInfo.addEventListener((state) => {
    connected = state.isConnected !== false && state.isInternetReachable !== false;
    apply();
  });
  apply();
  return () => {
    app.remove();
    network();
  };
}
