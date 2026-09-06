import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import { TestApiError, TestCustomerClient } from './test-client';
import type { CartLine, DiningMode } from './model';

export interface TestFlowModel {
  available: boolean;
  busy: boolean;
  error: string | null;
  observedAt: string | null;
  orders: TestOrder[];
  current: TestOrder | null;
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
    if (error.code === 'PREVIOUS_ORDER_PENDING')
      return 'Сначала восстановите прежнюю корзину и повторите проверку: результат создания предыдущего заказа ещё неизвестен.';
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
  const polling = useRef(false);
  const current = orders.find((order) => order.order_id === currentId) ?? null;
  const generation = useRef(0);

  const apply = useCallback((order: TestOrder) => {
    setOrders((previous) => [
      order,
      ...previous.filter((candidate) => candidate.order_id !== order.order_id),
    ]);
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
      setOrders(next);
      setCurrentId(
        (previous) =>
          previous ??
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
    if (!available) return;
    void client
      .restore()
      .then(() => {
        if (active) {
          setRestored(true);
          void refresh();
        }
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure));
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
    if (!available || busyRef.current) return null;
    generation.current += 1;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const order = await command();
      apply(order);
      return order;
    } catch (failure) {
      setError(errorMessage(failure));
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return {
    available,
    busy,
    error,
    observedAt,
    orders,
    current,
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
