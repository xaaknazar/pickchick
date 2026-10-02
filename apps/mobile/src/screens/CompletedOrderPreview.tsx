import { useState } from 'react';
import { Modal } from 'react-native';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import type { ScreenProps } from '../model';
import { defaultSelections, lineUnitPrice } from '../domain';
import { OrderHistoryCard } from '../components/OrderHistoryCard';
import { OrderSheet } from '../components/OrderSheet';
import { Caption, Page } from '../components/UI';
import { CompletedOrderScreen } from './CompletedOrderScreen';

/** Isolated design fixture. Never submitted to a bank, order or feedback API. */
export function completedOrderFixture(props: ScreenProps): CustomerCommerceOrder {
  const product = props.model.products[0];
  const selections = product ? defaultSelections(product) : [];
  const total = product ? lineUnitPrice({ product, selections }) : '0';
  return {
    orderId: '00000000-0000-4000-8000-000000000001',
    revision: '0'.repeat(64),
    restaurant: 'ТЦ Abay Plaza',
    branchId: '10000000-0000-4000-8000-000000000003',
    createdAt: '2026-10-02T07:32:00.000Z',
    updatedAt: '2026-10-02T07:42:00.000Z',
    kitchenStage: null,
    displayNumber: '12',
    totalMinor: total,
    serviceMode: 'takeaway',
    kitchenComment: 'Соус отдельно',
    phase: 'handed_over',
    expiresAt: null,
    receipt: 'deferred',
    receiptUrl: null,
    items: [
      {
        productId: product?.id ?? 'pick-combo',
        title: product?.name ?? 'Pick Combo',
        quantity: 1,
        totalMinor: total,
        modifiers: selections.map(
          (selection) =>
            product?.modifierGroups
              ?.find((group) => group.id === selection.group_id)
              ?.options.find((option) => option.id === selection.option_id)?.label ??
            selection.option_id,
        ),
      },
    ],
  };
}
export function CompletedOrderPreview(props: ScreenProps) {
  const [review, setReview] = useState<{ rating: number; comment: string | null } | null>(null);
  return (
    <CompletedOrderScreen
      props={props}
      order={completedOrderFixture(props)}
      review={review}
      preparationStartedAt="2026-10-02T07:33:00.000Z"
      readyAt="2026-10-02T07:40:00.000Z"
      onSaveReview={(rating, comment) => setReview({ rating, comment })}
    />
  );
}
export function OrderHistoryPreview(props: ScreenProps) {
  const [opened, setOpened] = useState(false);
  const [initialRating, setInitialRating] = useState<number | undefined>();
  const [review, setReview] = useState<{ rating: number; comment: string | null } | null>(null);
  const order = completedOrderFixture(props);
  return (
    <>
      <Page props={props} title="Заказы" noBack>
        <Caption>Пример завершённого заказа</Caption>
        <OrderHistoryCard
          order={order}
          products={props.model.products}
          savedRating={review?.rating}
          onOpen={() => {
            setInitialRating(undefined);
            setOpened(true);
          }}
          onRate={(rating) => {
            setInitialRating(rating);
            setOpened(true);
          }}
        />
      </Page>
      <Modal
        visible={opened}
        transparent
        animationType="none"
        onRequestClose={() => setOpened(false)}
      >
        <OrderSheet raised name="Завершённый заказ" onClose={() => setOpened(false)}>
          {(close) => (
            <CompletedOrderScreen
              props={{ ...props, inSheet: true, goBack: close }}
              order={order}
              initialRating={initialRating}
              review={review}
              preparationStartedAt="2026-10-02T07:33:00.000Z"
              readyAt="2026-10-02T07:40:00.000Z"
              onSaveReview={(rating, comment) => setReview({ rating, comment })}
            />
          )}
        </OrderSheet>
      </Modal>
    </>
  );
}
