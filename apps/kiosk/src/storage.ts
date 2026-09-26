import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { kioskRequest } from './api';
import { KIOSK_SESSION_KEY, KIOSK_FLOW_KEY, type KioskIO } from './controller';

export function createKioskIO(): KioskIO {
  return {
    readSession: () =>
      Platform.OS === 'web'
        ? AsyncStorage.getItem(KIOSK_SESSION_KEY)
        : SecureStore.getItemAsync(KIOSK_SESSION_KEY),
    writeSession: (raw) =>
      Platform.OS === 'web'
        ? AsyncStorage.setItem(KIOSK_SESSION_KEY, raw)
        : SecureStore.setItemAsync(KIOSK_SESSION_KEY, raw, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          }),
    removeSession: () =>
      Platform.OS === 'web'
        ? AsyncStorage.removeItem(KIOSK_SESSION_KEY)
        : SecureStore.deleteItemAsync(KIOSK_SESSION_KEY),
    readFlow: () => AsyncStorage.getItem(KIOSK_FLOW_KEY),
    writeFlow: (raw) => AsyncStorage.setItem(KIOSK_FLOW_KEY, raw),
    request: kioskRequest,
    now: Date.now,
    uuid: () => Crypto.randomUUID(),
  };
}
