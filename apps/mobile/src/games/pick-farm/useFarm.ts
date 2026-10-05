import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import { CROPS, type FarmCommand } from '@pickchick/farm-game';
import { HarvestQueue } from './harvest-queue';
import { API_URL } from '../../api';
import { useAccount } from '../../useAccount';
import { FarmClient, FarmClientError, farmRequest, type FarmSnapshot } from './api';

const messages: Record<string, string> = {
  GOAL_NOT_READY: 'Сначала выполните цель задания.',
  REWARD_CLAIMED: 'Эта награда уже получена.',
  PLOT_NOT_EMPTY: 'Сначала соберите урожай или уберите семена.',
  PLOT_NOT_STORED: 'Этот объект уже находится на участке.',
  DECORATION_ALREADY_PLACED: 'Украшение уже стоит на участке.',
  DECORATION_NOT_FOUND: 'Украшение уже перемещено. Откройте ваши вещи.',
  DECORATION_NOT_PLACED: 'Украшение находится в ваших вещах.',
  HOUSE_STYLE_LOCKED: 'Этот облик дома откроется на следующем уровне.',
  RECIPE_LOCKED: 'Рецепт пока не открыт. Выполняйте задания сада.',
  STATION_NOT_OWNED: 'Сначала откройте эту мастерскую.',
  STATION_OWNED: 'Эта мастерская уже открыта.',
  JOB_NOT_FOUND: 'Изделие уже забрано. Проверьте склад мастерской.',
  MAX_DECORATIONS: 'Достигнут предел украшений. Уберите часть в ваши вещи.',
  PROGRESSION_LIMIT: 'Достигнут предел сохранения. Продайте часть запасов.',
  FARM_CLIENT_UPGRADE_REQUIRED: 'Обновите PickChick, чтобы продолжить игру в ферму.',
  QUEST_NOT_READY: 'Сначала выполните цель главы.',
  QUEST_ALREADY_CLAIMED: 'Награда уже получена.',
  DECORATION_LOCKED: 'Украшение откроется на следующем этапе развития.',
  STATION_LOCKED: 'Мастерская пока не открыта. Выполняйте задания Алекса.',
  PRODUCTION_NOT_READY: 'Изделие ещё готовится.',
  QUEUE_FULL: 'Сначала заберите готовые изделия.',
  FARM_UNAVAILABLE: 'Ферма ещё готовится к открытию. Попробуйте зайти позже.',
  UNAUTHORIZED: 'Войдите в аккаунт, чтобы открыть свою ферму.',
  STALE_STATE: 'Ферма обновилась на другом устройстве. Проверьте участок и повторите действие.',
  CROP_WITHERED: 'Урожай потерян. Очистите грядку, чтобы посадить снова.',
  CELL_RESERVED: 'Здесь стоит дом. Выберите другую клетку.',
  CELL_OUTSIDE_FIELD: 'Размещайте грядки внутри границы участка 32×32.',
  CROP_NOT_WITHERED: 'Этот урожай ещё не потерян. Очистка не нужна.',
  CELL_OCCUPIED: 'Это место уже занято. Выберите другую клетку.',
  LEGACY_COMMAND: 'Планировка фермы обновилась. Выберите место для новой грядки.',
  CROP_REQUIRES_BED: 'Посадку можно убрать только с грядки.',
  PLOT_EMPTY: 'На грядке уже нет посадки.',
  CROP_NOT_READY: 'Урожай ещё растёт. Осталось немного подождать.',
  INSUFFICIENT_COINS: 'Не хватает монет. Соберите и продайте урожай.',
  ORDER_NOT_READY: 'Сначала соберите все продукты для этого заказа.',
  INSUFFICIENT_INVENTORY: 'Этого урожая пока нет на складе.',
  PLOT_NOT_FOUND: 'Объект уже удалён. Выберите другую грядку.',
  RECOVERY_NOT_AVAILABLE: 'Ферму уже можно продолжить: соберите, продайте или посадите урожай.',
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
  const [receipt, setReceipt] = useState<{ id: number; text: string } | null>(null);
  const receiptId = useRef(0);
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
        const previous = client.snapshot?.state;
        const next = await (command ? client.send(command) : client.refresh());
        if (currentClient.current !== client) return false;
        clock.current = { server: next.serverNow, monotonic: performance.now() };
        owner.current = client;
        setSnapshot(next);
        setServerNow(next.serverNow);
        if (command) {
          const parts: string[] = [];
          if (previous && next.state.revision === previous.revision + 1) {
            const coins = next.state.coins - previous.coins;
            if (coins) parts.push(`${coins > 0 ? '+' : ''}${coins} монет`);
            for (const crop of CROPS) {
              const n = next.state.inventory[crop.id] - previous.inventory[crop.id];
              if (n > 0) parts.push(`${crop.name}: +${n} на склад`);
            }
          }
          setReceipt({
            id: ++receiptId.current,
            text: parts.join(' · ') || (command.type === 'harvest' ? 'Урожай собран' : 'Сохранено'),
          });
        }
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
  const harvestQueue = useRef<HarvestQueue | null>(null);
  useEffect(() => {
    const queue = new HarvestQueue(run);
    harvestQueue.current = queue;
    return () => {
      queue.dispose();
      if (harvestQueue.current === queue) harvestQueue.current = null;
    };
  }, [run]);
  useEffect(() => {
    currentClient.current = client;
    owner.current = null;
    setSnapshot(null);
    setReceipt(null);
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
    customerId,
    receipt,
    state: owner.current === client ? (snapshot?.state ?? null) : null,
    serverNow,
    loading,
    busy,
    error,
    retry: () => {
      void run();
    },
    send: (command: FarmCommand) => run(command),
    harvest: (command: Extract<FarmCommand, { type: 'harvest' }>) =>
      harvestQueue.current?.enqueue(command) ?? Promise.resolve(false),
  };
}
