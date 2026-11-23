import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KioskError, kioskRequest } from './api';
import {
  commercialKioskRead,
  commercialKioskRequest,
  commercialKioskSend,
  exchangeKioskEnrollment,
} from './commercial-api';
import { kaspiTerminalCall, kaspiTerminalProbe, kaspiTlsFrom } from './kaspi-terminal';
import { KaspiTlsModule } from '../modules/kaspi-tls';
import { KASPI_TERMINAL_LINK_KEY } from './kaspi-terminal-link';
import { enrollDevice, KIOSK_ENROLLMENT_REQUEST_KEY } from './enrollment';
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

/** Native pinned TLS on iOS; elsewhere (web) HTTPS is unsupported and nothing is sent. */
const terminalTls = kaspiTlsFrom(KaspiTlsModule);

/** Operator provisioning is device-local; no secret is bundled in Expo configuration. */
export function createCommercialKioskIO(): CommercialKioskIO {
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  const read = async (key: string) => {
    if (Platform.OS === 'web')
      throw new Error('Commercial kiosk requires provisioned native storage');
    return SecureStore.getItemAsync(key);
  };
  const credentials = async () => {
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
    return { deviceId: device.deviceId, key: device.key };
  };
  return {
    readSession: () => read(COMMERCIAL_SESSION_KEY),
    writeSession: (raw) => SecureStore.setItemAsync(COMMERCIAL_SESSION_KEY, raw, options),
    removeSession: () => SecureStore.deleteItemAsync(COMMERCIAL_SESSION_KEY),
    readFlow: () => read(COMMERCIAL_FLOW_KEY),
    writeFlow: (raw) => SecureStore.setItemAsync(COMMERCIAL_FLOW_KEY, raw, options),
    readDevice: () => read(KIOSK_DEVICE_KEY),
    request: async (path, token, body, key) =>
      commercialKioskRequest(path, token, body, key, fetch, await credentials()),
    read: async (path, token, readOptions) =>
      commercialKioskRead(path, token, fetch, await credentials(), readOptions),
    send: async (method, path, token, body) =>
      commercialKioskSend(method, path, token, body, fetch, await credentials()),
    // ADR-0018: the terminal link, its token and certificate pin live only in this iPad's
    // SecureStore. HTTPS goes through the native kaspi-tls module (pinned leaf certificate).
    terminal: {
      store: {
        read: () => read(KASPI_TERMINAL_LINK_KEY),
        write: (raw) => SecureStore.setItemAsync(KASPI_TERMINAL_LINK_KEY, raw, options),
        remove: () => SecureStore.deleteItemAsync(KASPI_TERMINAL_LINK_KEY),
      },
      call: (host, method, params, callOptions) =>
        kaspiTerminalCall(host, method, params, callOptions, fetch, terminalTls),
      probe: (host) => kaspiTerminalProbe(host, fetch, terminalTls),
    },
    // Audit 19.10: the staff code is sent once for the server check and never stored.
    verifyStaff: async (pin) => {
      const answer = await commercialKioskRequest(
        '/staff/verify',
        undefined,
        { pin },
        undefined,
        fetch,
        await credentials(),
      );
      if (!answer || typeof answer !== 'object' || !('valid' in answer) || answer.valid !== true)
        throw new KioskError('INVALID_RESPONSE');
    },
    now: Date.now,
    uuid: () => Crypto.randomUUID(),
  };
}

/** Trusted native enrollment: call from the operator setup flow, never from guest UI. */
export async function commercialKioskEnrollmentPresent(): Promise<boolean> {
  if (Platform.OS === 'web') return true;
  return !!(await SecureStore.getItemAsync(KIOSK_DEVICE_KEY));
}

export async function provisionCommercialKiosk(login: string, password: string): Promise<void> {
  if (Platform.OS === 'web') throw new Error('Native enrollment required');
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  await enrollDevice(login, password, {
    occupied: async () =>
      !!(
        (await SecureStore.getItemAsync(KIOSK_DEVICE_KEY)) ||
        (await SecureStore.getItemAsync(COMMERCIAL_SESSION_KEY)) ||
        (await SecureStore.getItemAsync(COMMERCIAL_FLOW_KEY))
      ),
    readRequest: () => SecureStore.getItemAsync(KIOSK_ENROLLMENT_REQUEST_KEY),
    writeRequest: (value) => SecureStore.setItemAsync(KIOSK_ENROLLMENT_REQUEST_KEY, value, options),
    removeRequest: () => SecureStore.deleteItemAsync(KIOSK_ENROLLMENT_REQUEST_KEY),
    uuid: () => Crypto.randomUUID(),
    exchange: exchangeKioskEnrollment,
    check: (device) =>
      commercialKioskRequest('/enrollment/check', undefined, {}, undefined, fetch, device),
    save: (device) => SecureStore.setItemAsync(KIOSK_DEVICE_KEY, JSON.stringify(device), options),
  });
}
