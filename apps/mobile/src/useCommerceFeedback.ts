import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import { useAccount } from './useAccount';
import {
  orderFeedbackRequest,
  listOrderFeedback,
  type CustomerOrderFeedbackResponse,
} from './order-feedback';

type Feedback = NonNullable<CustomerOrderFeedbackResponse['feedback']>;
const message = (error: unknown) => {
  const code = error instanceof Error ? error.message : '';
  if (code === 'UNAUTHORIZED') return 'Войдите снова, чтобы сохранить отзыв.';
  if (code === 'NOT_FOUND') return 'Заказ не найден. Вернитесь в список заказов.';
  if (code === 'CONFLICT') return 'Оценить можно только выданный заказ.';
  return 'Не удалось сохранить или загрузить отзыв. Проверьте связь и попробуйте ещё раз.';
};

/** Customer-scoped review state. No optimistic success before server persistence. */
export function useCommerceFeedback(order: CustomerCommerceOrder | null, historyEnabled: boolean) {
  const { account, withOrderAccess } = useAccount();
  const customerId = account?.customerId;
  const selectedId = order?.phase === 'handed_over' ? order.orderId : null;
  const [ratings, setRatings] = useState<Record<string, Feedback>>({});
  const [detail, setDetail] = useState<CustomerOrderFeedbackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const saveLock = useRef(false);
  const detailAbort = useRef<AbortController | null>(null);
  const request = useCallback(
    (id: string, method: 'GET' | 'POST', body: unknown, signal?: AbortSignal) => {
      if (!customerId || !withOrderAccess) return Promise.reject(new Error('UNAUTHORIZED'));
      return withOrderAccess(customerId, (token) =>
        orderFeedbackRequest(id, method, body, token, signal),
      );
    },
    [customerId, withOrderAccess],
  );
  useEffect(() => {
    if (!historyEnabled || !customerId || !withOrderAccess) return;
    const controller = new AbortController();
    void withOrderAccess(customerId, (token) => listOrderFeedback(token, controller.signal))
      .then((result) => {
        if (controller.signal.aborted) return;
        setRatings((previous) => ({
          ...Object.fromEntries(result.feedback.map((item) => [item.orderId, item])),
          ...previous,
        }));
      })
      .catch(() => {
        /* Detail retry remains available; history itself still works. */
      });
    return () => controller.abort();
  }, [historyEnabled, customerId, withOrderAccess]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!selectedId) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    detailAbort.current = controller;
    setLoading(true);
    void request(selectedId, 'GET', undefined, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setDetail(result);
        if (result.feedback)
          setRatings((previous) => ({ ...previous, [selectedId]: result.feedback! }));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selectedId, request, refresh]);
  const save = useCallback(
    async (rating: number, comment: string) => {
      if (!selectedId || saveLock.current || !detail?.enabled || detail.orderId !== selectedId)
        return;
      saveLock.current = true;
      detailAbort.current?.abort();
      setSaving(true);
      setError(null);
      try {
        const result = await request(selectedId, 'POST', { rating, comment });
        if (result.feedback)
          setRatings((previous) => ({ ...previous, [selectedId]: result.feedback! }));
        if (selected.current === selectedId) setDetail(result);
      } catch (cause) {
        if (selected.current === selectedId) setError(message(cause));
      } finally {
        saveLock.current = false;
        setSaving(false);
      }
    },
    [selectedId, detail, request],
  );
  return {
    ratings,
    detail: detail?.orderId === selectedId ? detail : null,
    loading,
    saving,
    error,
    save,
    retry: () => setRefresh((value) => value + 1),
  };
}
