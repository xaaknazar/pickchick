import { useMemo } from 'react';
import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import type { ScreenProps } from '../model';
import { Caption } from '../components/UI';
import { OrderStatusScreen } from './OrderStatusScreen';

/** Gallery fixture only. Never stored, submitted, or passed to the order client. */
export function OrderStatusPreview(props: ScreenProps) {
  const order = useMemo<TestOrder>(() => {
    const ready = props.screenId === 'M18';
    const product = props.model.products[0];
    const created = new Date(Date.now() - 6 * 60_000).toISOString();
    const meta = { synthetic: true as const, namespace: 'pickchick-test' as const };
    return {
      ...meta,
      order_id: '00000000-0000-4000-8000-000000000001',
      number: '12',
      branch_id: '10000000-0000-4000-8000-000000000003',
      version: 1,
      state: ready ? 'ready' : 'preparing',
      payment_state: 'not_started',
      payment_attempt_id: null,
      fiscal_state: 'not_applicable',
      created_at: created,
      updated_at: new Date().toISOString(),
      cancellation_reason: null,
      tasks: [
        {
          task_id: '00000000-0000-4000-8000-000000000002',
          station: 'prep',
          state: ready ? 'done' : 'pending',
          title: 'Приготовление',
          mandatory: true,
        },
      ],
      snapshot: {
        ...meta,
        quote_id: '00000000-0000-4000-8000-000000000003',
        branch_id: '10000000-0000-4000-8000-000000000003',
        catalog_version: 'mockup-v0.2',
        channel: 'mobile',
        service_mode: 'takeaway',
        currency: 'KZT',
        total_minor: product?.priceMinor ?? '0',
        created_at: created,
        expires_at: created,
        lines: [
          {
            id: product?.id ?? 'example',
            name: product?.name ?? 'Пример блюда',
            description: product?.description ?? '',
            category: product?.category ?? '',
            price_minor: product?.priceMinor ?? '0',
            image_id: '',
            prep_required: true,
            quantity: 1,
            line_total_minor: product?.priceMinor ?? '0',
          },
        ],
      },
    };
  }, [props.model.products, props.screenId]);
  return (
    <OrderStatusScreen
      props={props}
      order={order}
      notice={<Caption>Пример дизайна. Заказ не отправляется на кухню.</Caption>}
    />
  );
}
