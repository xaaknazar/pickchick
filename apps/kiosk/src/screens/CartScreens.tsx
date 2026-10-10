import { useEffect, useRef, useState } from 'react';
import type { KioskModel, KioskProduct } from '../model';
import { defaultSelections, testLineId, validSelections } from '../cart';
import { copy } from '../i18n';
import { CartUpsell } from '../components/CartUpsell';
import { InvoicePhoneField } from '../components/InvoicePhoneField';
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
  type ScrollFocus,
} from '../components/UI';
import { INVOICE_PHONE_TARGET } from '../components/InvoicePhoneField';
import { OrderProgress } from '../components/OrderProgress';
import { UpsellGrid } from '../components/UpsellGrid';
import { CartLines } from '../components/CartLines';
import { CartTotal, positionsLabel } from '../components/CartTotal';
import { EmptyCart } from '../components/EmptyCart';
import { Notice } from '../components/Notice';
import { CheckoutSummary } from '../components/CheckoutSummary';
import { PaymentMethodCard } from '../components/PaymentMethodCard';
const itemCount = (model: KioskModel) => model.cart.reduce((sum, line) => sum + line.quantity, 0);
const modeLabel = (model: KioskModel, context: ScreenContext) =>
  model.mode
    ? model.mode === 'dine_in'
      ? copy(context.locale).hereChip
      : copy(context.locale).togo
    : undefined;
const upsellProducts = (model: KioskModel) =>
  model.catalog?.products.filter(
    (p) => model.catalog?.upsell_product_ids.includes(p.id) && p.available !== false,
  ) ?? [];
/** The cart line an upsell card stands for: the product with its default choice. */
const upsellLine = (model: KioskModel, p: KioskProduct) =>
  model.cart.find((line) => line.lineId === testLineId(p.id, defaultSelections(p)));
const upsellAdded = (model: KioskModel) =>
  upsellProducts(model)
    .filter((p) => upsellLine(model, p))
    .map((p) => p.id);
/** An upsell card is a toggle: the first tap adds one, a tap on the checked card takes it out. */
const addUpsell = (model: KioskModel, p: KioskProduct) => {
  const selections = defaultSelections(p);
  const line = upsellLine(model, p);
  if (line) void model.updateQuantity(line.lineId, line.quantity - 1);
  else if (validSelections(p, selections)) void model.addToCart(p.id, selections);
  else model.openProduct(p.id);
};
export function UpsellScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  const products = upsellProducts(model);
  return (
    <ScreenSurface testID="kiosk-screen-upsell" tone="brand" entrance={context.direction}>
      <Header
        {...context}
        back={model.goMenu}
        backLabel={t.menu}
        title={t.yourOrder}
        subtitle={positionsLabel(itemCount(model), context.locale)}
        mode={modeLabel(model, context)}
      />
      <UpsellGrid
        products={products}
        addedIds={upsellAdded(model)}
        busy={model.busy}
        locale={context.locale}
        onInteraction={model.touch}
        onAdd={(p) => addUpsell(model, p)}
      />
      <Footer entrance>
        <Button
          label={t.next}
          icon="arrow-forward"
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
  const count = itemCount(model);
  const qr = !!model.commercial && (model.commercialPaymentMethods ?? ['kaspi']).includes('kaspi');
  return (
    <ScreenSurface testID="kiosk-screen-cart" tone="brand" entrance={context.direction}>
      <Header
        {...context}
        back={model.goMenu}
        backLabel={t.menu}
        title={t.yourOrder}
        subtitle={positionsLabel(count, context.locale)}
        mode={modeLabel(model, context)}
      />
      <ScrollArea onInteraction={model.touch}>
        <Wrapper paddingX={24} paddingY={22} gap={14}>
          {!model.cart.length && !model.unavailableCartLines.length ? (
            <EmptyCart locale={context.locale} />
          ) : null}
          <CartLines
            lines={model.cart}
            locale={context.locale}
            busy={model.busy}
            onQuantity={(lineId, q) => void model.updateQuantity(lineId, q)}
          />
          {model.menuUpdating && model.unavailableCartLines.length ? (
            // Availability is briefly not fresh: the lines come back by themselves.
            <Notice
              testID="kiosk-menu-updating"
              title={t.menuUpdatingTitle}
              body={t.menuUpdatingBody}
            />
          ) : (
            model.unavailableCartLines.map((line) => {
              const product = model.catalog?.products.find((p) => p.id === line.productId);
              return (
                <Wrapper
                  key={line.lineId}
                  gap={14}
                  testID={'kiosk-unavailable-line-' + line.lineId}
                >
                  <Notice
                    tone="error"
                    title={product ? `${product.name} × ${line.quantity}` : t.lineChanged}
                    body={product ? `${t.lineChanged}. ${t.lineChangedBody}` : t.lineChangedBody}
                  />
                  <Button
                    size="compact"
                    tone="secondary"
                    label={t.remove}
                    busy={model.busy}
                    onPress={() => void model.updateQuantity(line.lineId, 0)}
                  />
                </Wrapper>
              );
            })
          )}
          {model.cart.length ? (
            <CartUpsell
              products={upsellProducts(model)}
              addedIds={upsellAdded(model)}
              busy={model.busy}
              locale={context.locale}
              onAdd={(p) => addUpsell(model, p)}
            />
          ) : null}
          {model.cart.length && !model.commercial ? (
            <Notice title={t.loyaltyTitle} body={t.loyaltyBody} />
          ) : null}
        </Wrapper>
      </ScrollArea>
      <Footer entrance>
        <CartTotal
          total={model.cartTotalMinor}
          valid={model.cartValid}
          locale={context.locale}
          count={count}
          qr={qr}
          size="large"
        />
        <Wrapper dir="row" gap={14}>
          <Button
            label={t.addMore}
            icon="add"
            iconLeading
            tone="brandOutline"
            onPress={model.goMenu}
          />
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
  const count = itemCount(model);
  // The phone field comes into view above the keypad (and when the invoice is chosen).
  const [focus, setFocus] = useState<ScrollFocus | undefined>(undefined);
  const reveal = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPhone = () => {
    if (reveal.current) clearTimeout(reveal.current);
    // After the keypad has resized the screen.
    reveal.current = setTimeout(
      () => setFocus((now) => ({ target: INVOICE_PHONE_TARGET, request: (now?.request ?? 0) + 1 })),
      350,
    );
  };
  useEffect(
    () => () => {
      if (reveal.current) clearTimeout(reveal.current);
    },
    [],
  );
  const invoice = !!model.commercial && model.paymentMethod === 'kaspi_invoice';
  useEffect(() => {
    if (invoice) showPhone();
  }, [invoice]);
  return (
    <ScreenSurface
      testID="kiosk-screen-loyalty"
      tone="brand"
      keyboardAware
      entrance={context.direction}
    >
      <Header
        {...context}
        back={model.openCart}
        title={t.payTitle}
        subtitle={positionsLabel(count, context.locale)}
      />
      <OrderProgress step="payment" locale={context.locale} />
      <ScrollArea onInteraction={model.touch} focus={focus}>
        <Wrapper paddingX={24} paddingY={22} gap={24}>
          <CheckoutSummary
            lines={model.cart}
            total={model.cartTotalMinor}
            valid={model.cartValid}
            locale={context.locale}
            estimated={model.catalog?.estimated_minutes}
          />
          <Wrapper gap={14}>
            <Heading size="section" tone="inverse">
              {t.payChoose}
            </Heading>
            {(model.commercial
              ? (model.commercialPaymentMethods ?? (['kaspi'] as const))
              : (['kaspi', 'card'] as const)
            ).map((method, index) => (
              <PaymentMethodCard
                key={method}
                method={method}
                position={index}
                selected={model.paymentMethod === method}
                busy={model.busy}
                commercial={!!model.commercial}
                locale={context.locale}
                onSelect={() => model.setPaymentMethod(method)}
              />
            ))}
          </Wrapper>
          {model.commercial && model.paymentMethod === 'kaspi_invoice' ? (
            <InvoicePhoneField
              value={model.invoicePhone ?? ''}
              onChange={(value) => model.setInvoicePhone?.(value)}
              busy={model.busy}
              locale={context.locale}
              valid={!!model.phoneValid}
              onFocus={showPhone}
            />
          ) : null}
          <Body tone="onBlue">
            {model.commercial
              ? model.checkoutReady
                ? model.paymentMethod === 'kaspi_invoice'
                  ? t.invoiceAfterConfirm
                  : t.qrNextScreen
                : t.kioskPayUnavailable
              : t.testPayment}
          </Body>
        </Wrapper>
      </ScrollArea>
      <Footer>
        <CartTotal
          total={model.cartTotalMinor}
          valid={model.cartValid}
          locale={context.locale}
          count={count}
          size="large"
        />
        <Button
          label={
            model.commercial && model.paymentMethod === 'kaspi_invoice'
              ? t.sendInvoice
              : t.createPayment
          }
          icon="arrow-forward"
          testID="kiosk-review-create"
          disabled={
            !model.cartValid ||
            !model.cart.length ||
            (model.commercial &&
              (!model.checkoutReady ||
                (model.paymentMethod === 'kaspi_invoice' && !model.phoneValid)))
          }
          busy={model.busy}
          onPress={() => void model.beginPayment(model.paymentMethod)}
          fullWidth
        />
      </Footer>
    </ScreenSurface>
  );
}
