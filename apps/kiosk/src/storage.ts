import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { kioskRequest } from './api';
import { commercialKioskRequest } from './commercial-api';
import {
  COMMERCIAL_FLOW_KEY,
  COMMERCIAL_SESSION_KEY,
  KIOSK_DEVICE_KEY,
  type CommercialKioskIO,
} from './commercial-controller';
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

/** Operator provisioning is device-local; no secret is bundled in Expo configuration. */
export function createCommercialKioskIO(): CommercialKioskIO {
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  const read = async (key: string) => {
    if (Platform.OS === 'web')
      throw new Error('Commercial kiosk requires provisioned native storage');
    return SecureStore.getItemAsync(key);
  };
  return {
    readSession: () => read(COMMERCIAL_SESSION_KEY),
    writeSession: (raw) => SecureStore.setItemAsync(COMMERCIAL_SESSION_KEY, raw, options),
    removeSession: () => SecureStore.deleteItemAsync(COMMERCIAL_SESSION_KEY),
    readFlow: () => read(COMMERCIAL_FLOW_KEY),
    writeFlow: (raw) => SecureStore.setItemAsync(COMMERCIAL_FLOW_KEY, raw, options),
    readDevice: () => read(KIOSK_DEVICE_KEY),
    request: async (path, token, body, key) => {
      const raw = await read(KIOSK_DEVICE_KEY);
      if (!raw || raw.length > 1000) throw new Error('Device is not provisioned');
      const device: unknown = JSON.parse(raw);
      if (
        !device ||
        typeof device !== 'object' ||
        !('deviceId' in device) ||
        !('key' in device) ||
        typeof device.deviceId !== 'string' ||
        typeof device.key !== 'string'
      )
        throw new Error('Device is not provisioned');
      return commercialKioskRequest(path, token, body, key, fetch, {
        deviceId: device.deviceId,
        key: device.key,
      });
    },
    now: Date.now,
    uuid: () => Crypto.randomUUID(),
  };
}

/** Trusted native enrollment: call from the operator setup flow, never from guest UI. */
export async function provisionCommercialKiosk(deviceId: string, key: string): Promise<void> {
  if (
    Platform.OS === 'web' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(deviceId) ||
    !/^[a-f0-9]{64}$/.test(key)
  )
    throw new Error('Invalid native device enrollment');
  if (
    (await SecureStore.getItemAsync(KIOSK_DEVICE_KEY)) ||
    (await SecureStore.getItemAsync(COMMERCIAL_SESSION_KEY)) ||
    (await SecureStore.getItemAsync(COMMERCIAL_FLOW_KEY))
  )
    throw new Error('Existing kiosk enrollment must be reviewed before replacement');
  await SecureStore.setItemAsync(KIOSK_DEVICE_KEY, JSON.stringify({ deviceId, key }), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
