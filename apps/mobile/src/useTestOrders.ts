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
    if (error.status === 401)
      return 'Тестовый доступ истёк. Продлите его после завершения всех заказов. Если заказ ещё на кухне, попросите оператора закончить проверку.';
    if (error.status === 429) return 'Лимит тестового контура достигнут. Повторите позже.';
    if (error.code === 'PREVIOUS_ORDER_PENDING' || error.code === 'PREVIOUS_COMMAND_PENDING')
      return 'Сохранена незавершённая проверка. Нажмите «Восстановить проверку», чтобы получить её результат без нового заказа.';
    if (error.code === 'PREVIOUS_SESSION_PENDING' || error.code === 'RECOVERY_DATA_INVALID')
      return 'Не удалось восстановить данные прежней проверки. Новый сеанс не создаём; обратитесь к оператору тестового контура.';
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
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [hasSavedSession, setHasSavedSession] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const polling = useRef(false);
  const failures = useRef(0);
  const current = orders.find((order) => order.order_id === currentId) ?? null;
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
          (previous && next.some((order) => order.order_id === previous) ? previous : null) ??
          next.find((order) => !['fulfilled', 'cancelled'].includes(order.state))?.order_id ??
          next[0]?.order_id ??
          null,
      );
      setObservedAt(observation.state === 'observed' ? new Date().toISOString() : null);
      setError(null);
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
  const pollState = useRef({ active: false, expired: false });
  pollState.current = {
    active: recoveryAvailable || hasActiveOrders,
    expired: sessionExpired,
  };
  useEffect(() => {
    if (!restored || (!hasSavedSession && !recoveryAvailable)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (cancelled) return;
      const delay = orderPollDelay({ ...pollState.current, failures: failures.current });
      if (delay === null) return;
      timer = setTimeout(async () => {
        if (AppState.currentState === 'active') await refresh();
        schedule();
      }, delay);
    };
    schedule();
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      listener.remove();
    };
  }, [restored, hasSavedSession, recoveryAvailable, sessionExpired, refresh, hasActiveOrders]);

  const run = async (command: () => Promise<TestOrder>): Promise<TestOrder | null> => {
    if (!connectedTestOrdersEnabled) return null;
    if (!accountCanAct(access.current)) {
      setError('Войдите в аккаунт, чтобы продолжить заказ.');
      return null;
    }
    if (!restored || busyRef.current) return null;
    generation.current += 1;
    const epoch = generation.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const order = await command();
      if (epoch !== generation.current) return null;
      apply(order);
      setHasSavedSession(true);
      return order;
    } catch (failure) {
      if (epoch === generation.current) {
        setError(errorMessage(failure));
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
    error,
    observedAt,
    orders,
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
