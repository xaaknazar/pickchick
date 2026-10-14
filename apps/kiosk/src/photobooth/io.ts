import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { PhotoIO } from './controller';
import { approvedEndpoint } from './endpoint';
const CONFIG = 'pickchick.photo-printer.v1';
const PENDING = 'pickchick.photo-job.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const provisionedUrl = process.env.EXPO_PUBLIC_KIOSK_PHOTO_URL;
export function createPhotoIO(): PhotoIO {
  const native = () => {
    if (Platform.OS === 'web') throw Error('NATIVE_ONLY');
  };
  return {
    readConfig: async () => {
      if (Platform.OS === 'web') return null;
      const s = await SecureStore.getItemAsync(CONFIG);
      const config = s ? JSON.parse(s) : null;
      return config && approvedEndpoint(config.url, provisionedUrl) ? config : null;
    },
    writeConfig: async (c) => {
      native();
      if (!approvedEndpoint(c.url, provisionedUrl)) throw Error('ADDRESS');
      await SecureStore.setItemAsync(CONFIG, JSON.stringify(c), options);
    },
    readPending: async () => (Platform.OS === 'web' ? null : SecureStore.getItemAsync(PENDING)),
    writePending: async (id) => {
      native();
      if (id) await SecureStore.setItemAsync(PENDING, id, options);
      else await SecureStore.deleteItemAsync(PENDING);
    },
    uuid: () => Crypto.randomUUID(),
    now: Date.now,
    request: async <T>(
      c: { url: string; token: string },
      path: string,
      body?: unknown,
      method?: string,
    ): Promise<T> => {
      native();
      // A guest knowing a code for their own server cannot redirect other guests' photos.
      if (!approvedEndpoint(c.url, provisionedUrl)) throw Error('ADDRESS');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(c.url + path, {
          method: method ?? (body ? 'POST' : 'GET'),
          headers: {
            'Content-Type': 'application/json',
            ...(c.token ? { Authorization: 'Bearer ' + c.token } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: 'error',
        });
        const result = await response.json();
        if (!response.ok)
          throw Error(
            response.status < 500 && typeof result.code === 'string' ? result.code : 'CONNECTION',
          );
        return result as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
