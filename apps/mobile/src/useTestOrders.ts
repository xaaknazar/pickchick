import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { orderPollDelay } from './poll-cadence';
import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import { TestApiError, TestCustomerClient } from './test-client';
import { mergeObservedOrder, mergeObservedOrders } from './test-order-session';
import { canCreateTestOrder, observeSavedOrders } from './test-order-observation';
import type { CartLine, DiningMode, PaymentMethod } from './model';
import { useAccount } from './useAccount';
import { connectedTestOrdersEnabled, unpaidTestOrdersEnabled } from './order-simulator';
import { accountCanAct } from './account-access';

export interface TestFlowModel {
  available: boolean;
  restored: boolean;
  hasSavedSession: boolean;
  busy: boolean;
  error: string | null;
  observedAt: string | null;
  orders: TestOrder[];
  historyBusy: boolean;
  moreHistory: boolean;
  loadHistory(): Promise<void>;
  current: TestOrder | null;
  recoveryAvailable: boolean;
  recoverPending(): Promise<TestOrder | null>;
  sessionExpired: boolean;
  continueSession(): Promise<boolean>;
  select(id: string): void;
  refresh(): void;
  submit(): Promise<TestOrder | null>;
  pay(outcome: 'approved' | 'declined' | 'unknown'): Promise<TestOrder | null>;
  cancel(reason: string): Promise<TestOrder | null>;
}

function errorMessage(error: unknown): string {
  if (error instanceof TestApiError) {
    if (error.code === 'SHIFT_CLOSED')
      return 'Смена закрыта. Заказ можно отправить после открытия новой смены. Корзина сохранена.';
    if (error.status === 401)
      return 'Срок доступа истёк. Продлите его после завершения всех заказов. Если заказ ещё на кухне, попросите оператора закончить проверку.';
    if (error.status === 429) return 'Слишком много запросов. Повторите позже.';
    if (error.code === 'PREVIOUS_ORDER_PENDING' || error.code === 'PREVIOUS_COMMAND_PENDING')
      return 'Сохранена незавершённая проверка. Нажмите «Восстановить проверку», чтобы получить её результат без нового заказа.';
    if (error.code === 'PREVIOUS_SESSION_PENDING' || error.code === 'RECOVERY_DATA_INVALID')
      return 'Не удалось восстановить данные прежней проверки. Новый сеанс не создаём; обратитесь к сотруднику ресторана.';
    if (error.code === 'QUOTE_EXPIRED')
      return 'Расчёт устарел. Повторите сохранённую проверку - цена будет снова рассчитана сервером.';
    if (error.status === 409)
      return 'Состояние изменилось. Обновите заказ перед следующим действием.';
    if (error.status === 400) return 'Проверьте состав заказа. Сервер не принял эти данные.';
  }
  return 'Нет ответа сервера. Заказ мог сохраниться - обновите статус или повторите ту же операцию.';
}

export function useTestOrders(
  available: boolean,
  cart: CartLine[],
  diningMode: DiningMode,
  paymentMethod: PaymentMethod = 'kaspi',
): TestFlowModel {
  const account = useAccount();
  const access = useRef(account);
  access.current = account;
  const client = useMemo(() => new TestCustomerClient(), []);
  const [orders, setOrders] = useState<TestOrder[]>([]);
  const [history, setHistory] = useState<TestOrder[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyLock = useRef(false);
  const [moreHistory, setMoreHistory] = useState(true);
  const historyCursor = useRef<string | undefined>(undefined);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [hasSavedSession, setHasSavedSession] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const polling = useRef(false);
  const failures = useRef(0);
  const allOrders = [
    ...orders,
    ...history.filter((old) => !orders.some((order) => order.order_id === old.order_id)),
  ];
  const current = allOrders.find((order) => order.order_id === currentId) ?? null;
  const generation = useRef(0);

  const apply = useCallback((order: TestOrder) => {
    failures.current = 0;
    setOrders((previous) => mergeObservedOrder(previous, order));
    setCurrentId(order.order_id);
    setObservedAt(new Date().toISOString());
  }, []);
  const refresh = useCallback(async () => {
    if (!connectedTestOrdersEnabled) {
      setRestored(true);
      return;
    }
    if (polling.current || busyRef.current) return;
    const epoch = generation.current;
    polling.current = true;
    try {
      const observation = await observeSavedOrders(client);
      if (epoch !== generation.current) return;
      setHasSavedSession(observation.hasSavedSession);
      setRecoveryAvailable(observation.hasPending);
      if (observation.state === 'unavailable') throw observation.error;
      const next = observation.orders;
      setOrders((previous) => mergeObservedOrders(previous, next));
      setCurrentId(
        (previous) =>
          previous ??
          next.find((order) => !['fulfilled', 'cancelled'].includes(order.state))?.order_id ??
          next[0]?.order_id ??
          null,
      );
      setObservedAt(observation.state === 'observed' ? new Date().toISOString() : null);
      setError(null);
      if (!observation.hasPending) setCommandError(null);
      setSessionExpired(false);
      failures.current = 0;
    } catch (failure) {
      if (epoch === generation.current) {
        failures.current += 1;
        setError(errorMessage(failure));
        if (failure instanceof TestApiError && failure.status === 401) setSessionExpired(true);
      }
    } finally {
      if (epoch === generation.current) setRestored(true);
      polling.current = false;
    }
  }, [client]);

  useEffect(() => {
    generation.current += 1;
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  const hasActiveOrders = orders.some((order) => !['fulfilled', 'cancelled'].includes(order.state));
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  useEffect(() => {
    if (!restored || busy || sessionExpired || (!hasSavedSession && !recoveryAvailable)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let foreground = AppState.currentState === 'active';
    let legacyUntil = 0;
    const scheduleRetry = () => {
      const delay = orderPollDelay({ active: true, expired: false, failures: failures.current });
      if (!stopped && foreground && delay !== null) timer = setTimeout(() => void observe(), delay);
    };
    const observe = async () => {
      if (stopped || !foreground || request || busyRef.current) return;
      const legacy = Date.now() < legacyUntil;
      if (legacy || !hasSavedSession || !hasActiveOrders) {
        if (recoveryAvailable || legacy || failures.current > 0) {
          await refresh();
          scheduleRetry();
        }
        return;
      }
      const epoch = generation.current;
      const controller = new AbortController();
      request = controller;
      try {
        const next = await client.watchOrders(ordersRef.current, controller.signal);
        if (stopped || controller.signal.aborted || epoch !== generation.current) return;
        // Advance the watch cursor before React renders, avoiding an immediate repeat response.
        ordersRef.current = mergeObservedOrders(ordersRef.current, next);
        setOrders(ordersRef.current);
        setObservedAt(new Date().toISOString());
        setError(null);
        failures.current = 0;
        const pending = await client.hasPending();
        if (!stopped && !controller.signal.aborted && epoch === generation.current) {
          setRecoveryAvailable(pending);
          if (!pending) setCommandError(null);
        }
      } catch (failure) {
        if (stopped || controller.signal.aborted || epoch !== generation.current) return;
        failures.current += 1;
        if (failure instanceof TestApiError && failure.status === 401) {
          setSessionExpired(true);
          setError(errorMessage(failure));
          return;
        }
        // During staged rollout an older API can still serve authoritative snapshots.
        const unsupported = failure instanceof TestApiError && failure.status === 404;
        if (unsupported) legacyUntil = Date.now() + 60000;
        else setError(errorMessage(failure));
        scheduleRetry();
        return;
      } finally {
        if (request === controller) request = undefined;
      }
      // A response is triggered by a committed change, or a bounded connection heartbeat.
      if (!stopped && foreground) timer = setTimeout(() => void observe(), 0);
    };
    void observe();
    const listener = AppState.addEventListener('change', (state) => {
      foreground = state === 'active';
      clearTimeout(timer);
      request?.abort();
      request = undefined;
      if (foreground)
        void refresh().then(() => {
          if (!stopped) void observe();
        });
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      listener.remove();
    };
  }, [
    client,
    restored,
    busy,
    hasSavedSession,
    recoveryAvailable,
    sessionExpired,
    refresh,
    hasActiveOrders,
  ]);

  const run = async (command: () => Promise<TestOrder>): Promise<TestOrder | null> => {
    if (!connectedTestOrdersEnabled) return null;
    if (!accountCanAct(access.current)) {
      setCommandError(null);
      setError('Войдите в аккаунт, чтобы продолжить заказ.');
      return null;
    }
    if (!restored || busyRef.current) return null;
    generation.current += 1;
    const epoch = generation.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setCommandError(null);
    try {
      const order = await command();
      if (epoch !== generation.current) return null;
      apply(order);
      setHasSavedSession(true);
      return order;
    } catch (failure) {
      if (epoch === generation.current) {
        setCommandError(errorMessage(failure));
        if (failure instanceof TestApiError && failure.status === 401) setSessionExpired(true);
      }
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
      try {
        const pending = await client.hasPending();
        if (epoch === generation.current) setRecoveryAvailable(pending);
      } catch (failure) {
        if (epoch === generation.current) setError(errorMessage(failure));
      }
    }
  };

  const continueSession = async (): Promise<boolean> => {
    if (!connectedTestOrdersEnabled || !accountCanAct(access.current)) return false;
    if (!hasSavedSession || !restored || busyRef.current) return false;
    generation.current += 1;
    const epoch = generation.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setCommandError(null);
    try {
      await client.continueSession();
      if (epoch !== generation.current) return false;
      setSessionExpired(false);
      busyRef.current = false;
      await refresh();
      return true;
    } catch (failure) {
      if (epoch === generation.current)
        setError(
          failure instanceof TestApiError && failure.status === 409
            ? 'Сначала оператор должен завершить все заказы этого сеанса и уточнить неизвестный результат. Затем повторите продление.'
            : errorMessage(failure),
        );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return {
    available: connectedTestOrdersEnabled && available,
    restored,
    hasSavedSession,
    busy: busy || !restored,
    error: commandError ?? error,
    observedAt,
    orders: allOrders,
    historyBusy,
    moreHistory,
    loadHistory: async () => {
      if (historyLock.current || !moreHistory || !hasSavedSession) return;
      historyLock.current = true;
      setHistoryBusy(true);
      try {
        const page = await client.history(historyCursor.current);
        historyCursor.current = page.orders.at(-1)?.order_id ?? historyCursor.current;
        setHistory((previous) => [
          ...previous,
          ...page.orders.filter(
            (order) => !previous.some((old) => old.order_id === order.order_id),
          ),
        ]);
        setMoreHistory(page.has_more);
        setError(null);
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        historyLock.current = false;
        setHistoryBusy(false);
      }
    },
    current,
    recoveryAvailable,
    recoverPending: () => run(() => client.recoverPending()),
    sessionExpired,
    continueSession,
    select: setCurrentId,
    refresh: () => {
      void refresh();
    },
    submit: () =>
      canCreateTestOrder(available, restored)
        ? run(() => client.create(cart, diningMode, paymentMethod, unpaidTestOrdersEnabled))
        : Promise.resolve(null),
    pay: (outcome) =>
      current
        ? run(() => client.command(current, 'simulated-payment', { outcome }))
        : Promise.resolve(null),
    cancel: (reason) =>
      current ? run(() => client.command(current, 'cancel', { reason })) : Promise.resolve(null),
  };
}
