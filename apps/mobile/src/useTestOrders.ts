import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import { TestApiError, TestCustomerClient } from './test-client';
import { mergeObservedOrder, mergeObservedOrders } from './test-order-session';
import type { CartLine, DiningMode } from './model';

export interface TestFlowModel {
  available: boolean;
  busy: boolean;
  error: string | null;
  observedAt: string | null;
  orders: TestOrder[];
  current: TestOrder | null;
  recoveryAvailable: boolean;
  recoverPending(): Promise<TestOrder | null>;
  select(id: string): void;
  refresh(): void;
  submit(): Promise<TestOrder | null>;
  pay(outcome: 'approved' | 'declined' | 'unknown'): Promise<TestOrder | null>;
  cancel(reason: string): Promise<TestOrder | null>;
}

function errorMessage(error: unknown): string {
  if (error instanceof TestApiError) {
    if (error.status === 401)
      return 'Тестовый сеанс истёк. Его заказы остаются на тестовой кухне; попросите оператора завершить проверку.';
    if (error.status === 429) return 'Лимит тестового контура достигнут. Повторите позже.';
    if (error.code === 'PREVIOUS_ORDER_PENDING' || error.code === 'PREVIOUS_COMMAND_PENDING')
      return 'Сохранена незавершённая проверка. Нажмите «Восстановить проверку», чтобы получить её результат без нового заказа.';
    if (error.code === 'PREVIOUS_SESSION_PENDING' || error.code === 'RECOVERY_DATA_INVALID')
      return 'Не удалось восстановить данные прежней проверки. Новый сеанс не создаём; обратитесь к оператору тестового контура.';
    if (error.code === 'QUOTE_EXPIRED')
      return 'Расчёт устарел. Повторите сохранённую проверку — цена будет снова рассчитана сервером.';
    if (error.status === 409)
      return 'Состояние изменилось. Обновите заказ перед следующим действием.';
    if (error.status === 400) return 'Проверьте состав заказа. Сервер не принял эти данные.';
  }
  return 'Нет ответа сервера. Заказ мог сохраниться — обновите статус или повторите ту же операцию.';
}

export function useTestOrders(
  available: boolean,
  cart: CartLine[],
  diningMode: DiningMode,
): TestFlowModel {
  const client = useMemo(() => new TestCustomerClient(), []);
  const [orders, setOrders] = useState<TestOrder[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const polling = useRef(false);
  const current = orders.find((order) => order.order_id === currentId) ?? null;
  const generation = useRef(0);

  const apply = useCallback((order: TestOrder) => {
    setOrders((previous) => mergeObservedOrder(previous, order));
    setCurrentId(order.order_id);
    setObservedAt(new Date().toISOString());
  }, []);
  const refresh = useCallback(async () => {
    if (!available || polling.current || busyRef.current) return;
    const epoch = generation.current;
    polling.current = true;
    try {
      const next = await client.orders();
      if (epoch !== generation.current) return;
      const pending = await client.hasPending();
      if (epoch !== generation.current) return;
      setOrders((previous) => mergeObservedOrders(previous, next));
      setRecoveryAvailable(pending);
      setCurrentId(
        (previous) =>
          (previous && next.some((order) => order.order_id === previous) ? previous : null) ??
          next.find((order) => !['fulfilled', 'cancelled'].includes(order.state))?.order_id ??
          next[0]?.order_id ??
          null,
      );
      setObservedAt(new Date().toISOString());
      setError(null);
    } catch (failure) {
      if (epoch === generation.current) setError(errorMessage(failure));
    } finally {
      polling.current = false;
    }
  }, [available, client]);

  useEffect(() => {
    let active = true;
    generation.current += 1;
    setRestored(false);
    if (!available) return;
    void client
      .restore()
      .then(async () => {
        const pending = await client.hasPending();
        if (active) {
          setRestored(true);
          setRecoveryAvailable(pending);
          void refresh();
        }
      })
      .catch((failure) => {
        if (active) {
          setRestored(true);
          setError(errorMessage(failure));
        }
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [available, client, refresh]);
  useEffect(() => {
    if (!available || !restored) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, 3000);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [available, restored, refresh]);

  const run = async (command: () => Promise<TestOrder>): Promise<TestOrder | null> => {
    if (!available || !restored || busyRef.current) return null;
    generation.current += 1;
    const epoch = generation.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const order = await command();
      if (epoch !== generation.current) return null;
      apply(order);
      return order;
    } catch (failure) {
      if (epoch === generation.current) setError(errorMessage(failure));
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

  return {
    available,
    busy: busy || (available && !restored),
    error,
    observedAt,
    orders,
    current,
    recoveryAvailable,
    recoverPending: () => run(() => client.recoverPending()),
    select: setCurrentId,
    refresh: () => {
      void refresh();
    },
    submit: () => run(() => client.create(cart, diningMode)),
    pay: (outcome) =>
      current
        ? run(() => client.command(current, 'simulated-payment', { outcome }))
        : Promise.resolve(null),
    cancel: (reason) =>
      current ? run(() => client.command(current, 'cancel', { reason })) : Promise.resolve(null),
  };
}
