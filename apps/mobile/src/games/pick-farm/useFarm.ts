import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import type { FarmCommand } from '@pickchick/farm-game';
import { API_URL } from '../../api';
import { useAccount } from '../../useAccount';
import { FarmClient, FarmClientError, farmRequest, type FarmSnapshot } from './api';

const messages: Record<string, string> = {
  FARM_UNAVAILABLE: 'Ферма ещё готовится к открытию. Попробуйте зайти позже.',
  UNAUTHORIZED: 'Войдите в аккаунт, чтобы открыть свою ферму.',
  STALE_STATE: 'Ферма обновилась на другом устройстве. Проверьте участок и повторите действие.',
  CROP_WITHERED: 'Урожай потерян. Очистите грядку, чтобы посадить снова.',
  CELL_RESERVED: 'Здесь стоит дом. Выберите другую клетку.',
  CROP_NOT_WITHERED: 'Этот урожай ещё не потерян. Очистка не нужна.',
  CELL_OCCUPIED: 'Это место уже занято. Выберите другую клетку.',
  LEGACY_COMMAND: 'Планировка фермы обновилась. Выберите место для новой грядки.',
  CROP_NOT_READY: 'Урожай ещё растёт. Осталось немного подождать.',
  INSUFFICIENT_COINS: 'Не хватает монет. Соберите и продайте урожай.',
  ORDER_NOT_READY: 'Сначала соберите все продукты для этого заказа.',
  INSUFFICIENT_INVENTORY: 'Этого урожая пока нет на складе.',
  PLOT_OCCUPIED: 'На этой грядке уже что-то растёт.',
  MAX_PLOTS: 'Вся доступная территория уже открыта.',
  PENDING_RECOVERY: 'Проверяем предыдущее действие. Нажмите «Повторить».',
  RECOVERY_REQUIRED: 'Не удалось прочитать сохранённое действие. Обратитесь в поддержку.',
  RATE_LIMITED: 'Слишком много действий подряд. Подождите немного и повторите.',
};
function errorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return (
    messages[code] ??
    'Не удалось сохранить действие. Нажмите «Повторить» - повторного списания монет не будет.'
  );
}

export function useFarm() {
  const { account, withOrderAccess } = useAccount();
  const customerId = account?.kind === 'server_customer' ? account.customerId : undefined;
  const client = useMemo(() => {
    if (!customerId || !withOrderAccess) return null;
    const key = `pickchick.farm.pending.v1.${customerId}`;
    const request = farmRequest(API_URL, expoFetch);
    return new FarmClient({
      read: () => AsyncStorage.getItem(key),
      write: (raw) =>
        raw === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, raw),
      randomId: Crypto.randomUUID,
      request: (intent) => withOrderAccess(customerId, (token) => request(token, intent)),
    });
  }, [customerId, withOrderAccess]);
  const [snapshot, setSnapshot] = useState<FarmSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serverNow, setServerNow] = useState(0);
  const currentClient = useRef(client);
  currentClient.current = client;
  const inFlight = useRef<FarmClient | null>(null);
  const owner = useRef<FarmClient | null>(null);
  const clock = useRef({ server: 0, monotonic: 0 });
  const run = useCallback(
    async (command?: FarmCommand) => {
      if (!client) {
        setLoading(false);
        setError(messages.UNAUTHORIZED!);
        return false;
      }
      if (inFlight.current === client) return false;
      inFlight.current = client;
      setBusy(true);
      setError(null);
      try {
        const next = await (command ? client.send(command) : client.refresh());
        if (currentClient.current !== client) return false;
        clock.current = { server: next.serverNow, monotonic: performance.now() };
        owner.current = client;
        setSnapshot(next);
        setServerNow(next.serverNow);
        return true;
      } catch (cause) {
        if (currentClient.current !== client) return false;
        if (cause instanceof FarmClientError && cause.code === 'BUSY') return false;
        if (client.snapshot) {
          owner.current = client;
          setSnapshot(client.snapshot);
          clock.current = { server: client.snapshot.serverNow, monotonic: performance.now() };
        }
        setError(errorMessage(cause));
        return false;
      } finally {
        if (inFlight.current === client) inFlight.current = null;
        if (currentClient.current === client) {
          setBusy(false);
          setLoading(false);
        }
      }
    },
    [client],
  );
  useEffect(() => {
    currentClient.current = client;
    owner.current = null;
    setSnapshot(null);
    setLoading(true);
    setError(null);
    void run();
    const subscription = AppState.addEventListener('change', (value) => {
      if (value === 'active') void run();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active' || AppState.currentState == null)
        setServerNow(
          Math.floor(
            clock.current.server + Math.max(0, performance.now() - clock.current.monotonic),
          ),
        );
    }, 1000);
    return () => {
      subscription.remove();
      clearInterval(timer);
      currentClient.current = null;
    };
  }, [run, client]);
  return {
    state: owner.current === client ? (snapshot?.state ?? null) : null,
    serverNow,
    loading,
    busy,
    error,
    retry: () => {
      void run();
    },
    send: (command: FarmCommand) => run(command),
  };
}
