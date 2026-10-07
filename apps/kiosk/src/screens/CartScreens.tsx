import type { KioskModel } from '../model';
import { defaultSelections, validSelections } from '../cart';
import { copy } from '../i18n';
import {
  Body,
  Button,
  Footer,
  Header,
  Heading,
  ScreenSurface,
  ScrollArea,
  Wrapper,
  type ScreenContext,
} from '../components/UI';
import { OrderProgress } from '../components/OrderProgress';
import { UpsellGrid } from '../components/UpsellGrid';
import { CartRow } from '../components/CartRow';
import { CartTotal } from '../components/CartTotal';
import { EmptyCart } from '../components/EmptyCart';
import { Notice } from '../components/Notice';
import { CheckoutSummary } from '../components/CheckoutSummary';
import { PaymentMethodCard } from '../components/PaymentMethodCard';
export function UpsellScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  const products =
    model.catalog?.products.filter(
      (p) => model.catalog?.upsell_product_ids.includes(p.id) && p.available !== false,
    ) ?? [];
  return (
    <ScreenSurface testID="kiosk-screen-upsell">
      <Header {...context} back={model.goMenu} title={t.yourOrder} />
      <OrderProgress step="cart" locale={context.locale} />
      <UpsellGrid
        products={products}
        addedIds={model.cart.map((l) => l.productId)}
        busy={model.busy}
        locale={context.locale}
        onInteraction={model.touch}
        onAdd={(p) => {
          const selections = defaultSelections(p);
          if (validSelections(p, selections)) void model.addToCart(p.id, selections);
          else model.openProduct(p.id);
        }}
      />
      <Footer>
        <Button
          label={t.next}
          testID="kiosk-upsell-continue"
          onPress={model.openCart}
          busy={model.busy}
          fullWidth
        />
      </Footer>
    </ScreenSurface>
  );
}
export function CartScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  return (
    <ScreenSurface testID="kiosk-screen-cart">
      <Header {...context} title={t.yourOrder} back={model.goMenu} />
      <OrderProgress step="cart" locale={context.locale} />
      <ScrollArea onInteraction={model.touch}>
        <Wrapper padding={28} gap={20}>
          {!model.cart.length && !model.unavailableCartLines.length ? (
            <EmptyCart locale={context.locale} />
          ) : null}
          {model.cart.map((line) => (
            <CartRow
              key={line.lineId}
              line={line}
              locale={context.locale}
              busy={model.busy}
              onQuantity={(q) => void model.updateQuantity(line.lineId, q)}
            />
          ))}
          {model.unavailableCartLines.map((line) => (
            <Wrapper key={line.lineId} gap={14} testID={'kiosk-unavailable-line-' + line.lineId}>
              <Notice
                tone="error"
                title={
                  context.locale === 'ru'
                    ? 'Позиция изменилась или недоступна'
                    : 'Тағам өзгерді немесе қолжетімсіз'
                }
                body={
                  context.locale === 'ru'
                    ? 'Удалите её и выберите блюдо заново из актуального меню.'
                    : 'Оны өшіріп, мәзірден қайта таңдаңыз.'
                }
              />
              <Button
                size="compact"
                tone="secondary"
                label={t.remove}
                busy={model.busy}
                onPress={() => void model.updateQuantity(line.lineId, 0)}
              />
            </Wrapper>
          ))}
          {model.cart.length && !model.commercial ? (
            <Notice title={t.loyaltyTitle} body={t.loyaltyBody} />
          ) : null}
        </Wrapper>
      </ScrollArea>
      <Footer>
        <CartTotal total={model.cartTotalMinor} valid={model.cartValid} locale={context.locale} />
        <Wrapper dir="row" gap={20}>
          <Button label={t.addMore} icon="add" tone="secondary" onPress={model.goMenu} />
          <Wrapper flex={1}>
            <Button
              label={t.checkout}
              icon="arrow-forward"
              testID="kiosk-cart-checkout"
              disabled={!model.cart.length || !model.cartValid}
              busy={model.busy}
              onPress={model.goLoyalty}
              fullWidth
            />
          </Wrapper>
        </Wrapper>
      </Footer>
    </ScreenSurface>
  );
}
export function ReviewScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  return (
    <ScreenSurface testID="kiosk-screen-loyalty">
      <Header {...context} title={t.payTitle} back={model.openCart} />
      <OrderProgress step="payment" locale={context.locale} />
      <ScrollArea onInteraction={model.touch}>
        <Wrapper padding={28} gap={28}>
          <CheckoutSummary
            lines={model.cart}
            total={model.cartTotalMinor}
            valid={model.cartValid}
            locale={context.locale}
            estimated={model.catalog?.estimated_minutes}
          />
          <Wrapper gap={16}>
            <Heading size="card">{t.payChoose}</Heading>
            {(model.commercial ? (['kaspi'] as const) : (['kaspi', 'card'] as const)).map(
              (method) => (
                <PaymentMethodCard
                  key={method}
                  method={method}
                  selected={model.paymentMethod === method}
                  busy={model.busy}
                  commercial={!!model.commercial}
                  locale={context.locale}
                  onSelect={() => model.setPaymentMethod(method)}
                />
              ),
            )}
          </Wrapper>
          <Body tone="muted">
            {model.commercial
              ? model.checkoutReady
                ? context.locale === 'ru'
                  ? 'На следующем экране появится QR для оплаты в Kaspi.kz. Телефон вводить не нужно.'
                  : 'Келесі экранда Kaspi.kz арқылы төлеуге арналған QR көрсетіледі. Телефон нөмірін енгізудің қажеті жоқ.'
                : context.locale === 'ru'
                  ? 'Оплата на киоске пока недоступна. Заказ можно оформить у кассира.'
                  : 'Киоскте төлем әзірге қолжетімсіз. Тапсырысты кассирден беруге болады.'
              : t.testPayment}
          </Body>
        </Wrapper>
      </ScrollArea>
      <Footer>
        <CartTotal total={model.cartTotalMinor} valid={model.cartValid} locale={context.locale} />
        <Button
          label={t.createPayment}
          icon="arrow-forward"
          testID="kiosk-review-create"
          disabled={
            !model.cartValid || !model.cart.length || (model.commercial && !model.checkoutReady)
          }
          busy={model.busy}
          onPress={() => void model.beginPayment(model.paymentMethod)}
          fullWidth
        />
      </Footer>
    </ScreenSurface>
  );
}
