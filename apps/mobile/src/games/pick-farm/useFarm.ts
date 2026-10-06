import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import { CROPS, FARM_PROTOCOL, type FarmCommand, type FarmState } from '@pickchick/farm-game';
import { API_URL } from '../../api';
import { useAccount } from '../../useAccount';
import { FarmClient, farmRequest } from './api';
import { FarmPipeline, type ActionResult, type Ticket } from './pipeline';

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
  CROP_REQUIRES_TREE: 'Яблоню покупают в магазине, на грядку её не посадить.',
  CROP_LOCKED: 'Эта культура откроется на следующем уровне.',
  PLOT_EMPTY: 'На грядке уже нет посадки.',
  CROP_NOT_READY: 'Урожай ещё растёт. Осталось немного подождать.',
  CROP_NOT_GROWING: 'Поливать нужно растущий урожай.',
  ALREADY_WATERED: 'Эта посадка уже полита.',
  WATER_UNAVAILABLE: 'Лейка заработает после обновления сервера фермы.',
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
  CELL_LOCKED: 'Эта земля ещё не куплена. Расширьте участок в магазине.',
  LAND_LOCKED: 'Новая земля откроется на следующем уровне.',
  LAND_MAX: 'Вся земля фермы уже открыта.',
  PEN_LOCKED: 'Постройка откроется на следующем уровне.',
  PEN_OWNED: 'Эта постройка уже есть на ферме.',
  PEN_NOT_OWNED: 'Сначала постройте загон.',
  PEN_FULL: 'В загоне нет свободных мест.',
  INSUFFICIENT_FEED: 'Нет корма на складе. При сборе выберите «На склад для заказов».',
  ANIMALS_NOT_HUNGRY: 'Животные уже накормлены.',
  ANIMALS_NOT_READY: 'Ещё не готово. Животные работают.',
  ANIMAL_NOT_FOUND: 'Этого животного уже нет в загоне.',
  BOARD_NOT_READY: 'Новый покупатель ещё в пути.',
};
export function farmMessage(code: string): string {
  return (
    messages[code] ??
    'Не удалось сохранить действие. Нажмите «Повторить» - повторного списания монет не будет.'
  );
}
const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : '';

export type FarmReceipt = { id: number; text: string; coins: number; xp: number };

export function useFarm() {
  const { account, withOrderAccess } = useAccount();
  const customerId = account?.kind === 'server_customer' ? account.customerId : undefined;
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<FarmReceipt | null>(null);
  const [serverNow, setServerNow] = useState(0);
  const receiptId = useRef(0);
  const clock = useRef({ server: 0, monotonic: 0 });
  const estimate = useCallback(
    () =>
      Math.floor(clock.current.server + Math.max(0, performance.now() - clock.current.monotonic)),
    [],
  );
  const pipeline = useMemo(() => {
    if (!customerId || !withOrderAccess) return null;
    const key = `pickchick.farm.pending.v1.${customerId}`;
    const request = farmRequest(API_URL, expoFetch);
    const client = new FarmClient({
      read: () => AsyncStorage.getItem(key),
      write: (raw) =>
        raw === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, raw),
      randomId: Crypto.randomUUID,
      request: (intent) => withOrderAccess(customerId, (token) => request(token, intent)),
    });
    let last: unknown = null;
    const instance: FarmPipeline = new FarmPipeline(
      {
        send: (command) => client.send(command),
        refresh: () => client.refresh(),
        current: () => client.snapshot,
      },
      estimate,
      () => {
        const confirmed = instance.confirmed;
        if (confirmed && confirmed !== last) {
          // Each server answer re-anchors the local clock used for timers and predictions.
          last = confirmed;
          clock.current = { server: confirmed.serverNow, monotonic: performance.now() };
          setServerNow(confirmed.serverNow);
        }
        setVersion((v) => v + 1);
      },
      (cause) => setError(farmMessage(codeOf(cause))),
    );
    return instance;
  }, [customerId, withOrderAccess, estimate]);

  useEffect(() => {
    setReceipt(null);
    setError(null);
    setLoading(true);
    if (!pipeline) {
      setLoading(false);
      setError(messages.UNAUTHORIZED!);
      return;
    }
    let alive = true;
    void pipeline.refresh().then(() => {
      if (alive) setLoading(false);
    });
    const subscription = AppState.addEventListener('change', (value) => {
      if (value === 'active') void pipeline.refresh();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active' || AppState.currentState == null)
        setServerNow(estimate());
    }, 1000);
    return () => {
      alive = false;
      subscription.remove();
      clearInterval(timer);
      pipeline.dispose();
    };
  }, [pipeline, estimate]);

  const onDone = useCallback((result: ActionResult) => {
    if (!result.ok) return;
    const { before, after } = result;
    const coins = after.coins - before.coins;
    const xp = after.xp - before.xp;
    const parts: string[] = [];
    for (const crop of CROPS) {
      const n = after.inventory[crop.id] - before.inventory[crop.id];
      if (n > 0) parts.push(`${crop.name} +${n}`);
    }
    setReceipt({ id: ++receiptId.current, text: parts.join(' · '), coins, xp });
  }, []);
  /** Validated at once against the predicted field; confirmation arrives later. */
  const submit = useCallback(
    (command: FarmCommand): Ticket => {
      if (!pipeline) return { accepted: false, code: 'UNAUTHORIZED' };
      const ticket = pipeline.submit(command);
      if (ticket.accepted) {
        setError(null);
        void ticket.done.then(onDone);
      }
      return ticket;
    },
    [pipeline, onDone],
  );
  void version;
  const state: FarmState | null = pipeline?.predicted() ?? null;
  return {
    customerId,
    receipt,
    /** Field shown to the player: confirmed state plus actions still being saved. */
    state,
    /** Server-confirmed state: the only source for displayed coins and XP. */
    confirmed: pipeline?.confirmed?.state ?? null,
    serverNow: Math.max(serverNow, pipeline?.confirmed?.serverNow ?? 0),
    loading: loading && !state,
    pending: pipeline?.pending ?? 0,
    watering: pipeline?.watering ?? true,
    /**
     * False while the API still runs protocol 2: land, animals, the order board, daily
     * rewards and the new recipes stay hidden because that server would reject them.
     */
    v3: (pipeline?.confirmed?.protocol ?? FARM_PROTOCOL) >= 3,
    error,
    clearError: () => setError(null),
    retry: () => {
      setError(null);
      void pipeline?.refresh();
    },
    submit,
  };
}
