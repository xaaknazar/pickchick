import { useEffect, useRef, useState } from 'react';
import type { KioskModel, KioskProduct } from '../model';
import { defaultSelections, money, testLineId, validSelections } from '../cart';
import { copy } from '../i18n';
import {
  orderLines,
  orderSummary,
  paysDirectly,
  planUpsell,
  type UpsellTileKey,
} from '../smartUpsell';
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
import { RadialBackdrop } from '../components/RadialBackdrop';
import { StepPills } from '../components/StepPills';
import { UpsellBoard } from '../components/UpsellBoard';
import { UpsellHero, UpsellTile } from '../components/UpsellCards';
import { UpsellFooter } from '../components/UpsellFooter';
import { UpsellHeader } from '../components/UpsellHeader';
import { UpsellSection } from '../components/UpsellSection';
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
/**
 * What the smart upsell remembers while the guest visits a product page from it: the order's
 * products when the screen was opened from the menu. Those are never offered; anything added on
 * the screen stays visible (green) until the guest leaves for the menu or payment.
 */
export interface UpsellMemory {
  base: string[] | null;
}
/** A smart upsell tile toggles like the old cards; a choice made on the product page counts too. */
const toggleSmart = (model: KioskModel, p: KioskProduct) => {
  const selections = defaultSelections(p);
  const line =
    upsellLine(model, p) ?? [...model.cart].reverse().find((entry) => entry.productId === p.id);
  if (line) void model.updateQuantity(line.lineId, line.quantity - 1);
  else if (validSelections(p, selections)) void model.addToCart(p.id, selections);
  else model.openProduct(p.id);
};
/**
 * Smart upsell (kiosk redesign 2026-10-13, README §4): always opened by «Оформить заказ».
 * The suggestion follows `planUpsell`; «К оплате» and «Без допов» lead straight to payment
 * (the Kaspi QR when it is the only method, the payment-method screen otherwise), and «В заказе»
 * opens the order page for changes. Unavailable lines stay visible here and block payment.
 */
export function UpsellScreen({
  model,
  context,
  memory,
}: {
  model: KioskModel;
  context: ScreenContext;
  memory: UpsellMemory;
}) {
  const t = copy(context.locale);
  const [base] = useState(
    () =>
      (memory.base ??= [
        ...model.cart.map((line) => line.productId),
        ...model.unavailableCartLines.map((line) => line.productId),
      ]),
  );
  const products = model.catalog?.products ?? [];
  const plan = planUpsell(products, base);
  const inCart = new Set(model.cart.map((line) => line.productId));
  const nameOf = (id: string) => products.find((p) => p.id === id)?.name ?? '';
  const items = orderSummary(base.map(nameOf).filter(Boolean));
  const subtitle = items
    ? (plan.reason === 'fingers'
        ? t.smartSubFingers
        : plan.reason === 'burger'
          ? t.smartSubBurger
          : t.smartSubOrder
      ).replace('{items}', items)
    : undefined;
  const hero = plan.hero;
  const heroCopy = hero
    ? {
        burger: {
          title: t.smartHeroBurger,
          body: hero.pairing ? t.smartBodyBurgerPair : t.smartBodyBurger,
        },
        fingers: {
          title: t.smartHeroFingers,
          body: (hero.pairing ? t.smartBodyFingersPair : t.smartBodyFingers).replace(
            '{price}',
            money(hero.product.price_minor),
          ),
        },
        lemonade: { title: t.smartHeroLemonade, body: t.smartBodyLemonade },
      }[hero.kind]
    : null;
  const tileName: Record<UpsellTileKey, string> = {
    sauce: t.smartSauce,
    'sauce-hot': t.smartSauceHot,
    cheese: t.smartSauceCheese,
    lemonade: t.smartLemonade,
    'iced-tea': t.smartIcedTea,
    cola: t.smartCola,
  };
  const commercial = !!model.commercial;
  const blocked = !model.cartValid || !model.cart.length || (commercial && !model.checkoutReady);
  const pay = () => {
    if (paysDirectly(model.commercial, model.commercialPaymentMethods))
      void model.beginPayment('kaspi');
    else model.goLoyalty();
  };
  const rows = [
    { key: 'sauces', title: t.smartSauces, note: t.smartSaucesNote, tiles: plan.sauces, art: 1 },
    { key: 'drinks', title: t.drinks, note: undefined, tiles: plan.drinks, art: 0 },
  ].filter((row) => row.tiles.length);
  return (
    <ScreenSurface testID="kiosk-screen-upsell" tone="brand" entrance={context.direction}>
      <RadialBackdrop />
      <UpsellHeader
        locale={context.locale}
        setLocale={context.setLocale}
        title={t.smartTitle}
        subtitle={subtitle}
        onBack={model.goMenu}
        onHelp={context.onHelp}
      />
      <StepPills current="extras" locale={context.locale} />
      <ScrollArea testID="kiosk-upsell-scroll" onInteraction={model.touch} fill>
        <UpsellBoard>
          {model.unavailableCartLines.length || (model.cart.length && !model.cartValid) ? (
            <Wrapper gap={12} testID="kiosk-upsell-check-cart">
              {model.menuUpdating ? (
                <Notice
                  testID="kiosk-menu-updating"
                  title={t.menuUpdatingTitle}
                  body={t.menuUpdatingBody}
                />
              ) : (
                <Notice
                  tone="error"
                  title={t.checkCart}
                  body={`${t.lineChanged}. ${t.lineChangedBody}`}
                />
              )}
              <Wrapper alignSelf="flex-start">
                <Button
                  size="compact"
                  tone="light"
                  label={t.smartOpenCart}
                  testID="kiosk-upsell-open-cart"
                  onPress={model.openCart}
                />
              </Wrapper>
            </Wrapper>
          ) : commercial && model.cart.length && !model.checkoutReady ? (
            <Notice testID="kiosk-upsell-pay-unavailable" body={t.kioskPayUnavailable} />
          ) : null}
          {hero && heroCopy ? (
            <UpsellHero
              product={hero.product}
              badge={hero.badge}
              title={heroCopy.title}
              body={heroCopy.body}
              added={inCart.has(hero.product.id)}
              busy={model.busy}
              locale={context.locale}
              onAdd={() => toggleSmart(model, hero.product)}
            />
          ) : null}
          {rows.map((row, rowIndex) => (
            <UpsellSection
              key={row.key}
              testID={'kiosk-upsell-' + row.key}
              title={row.title}
              note={row.note}
            >
              {row.tiles.map((tile, index) => {
                // Lemonade is the row's wide card; a row of one or two is all wide cards.
                const wide = row.tiles.length <= 2 || tile.key === 'lemonade';
                return (
                  <Wrapper
                    key={tile.product.id}
                    flex={row.tiles.length > 2 && tile.key === 'lemonade' ? 1.4 : 1}
                  >
                    <UpsellTile
                      product={tile.product}
                      name={tileName[tile.key]}
                      badge={tile.badge}
                      description={tile.key === 'lemonade' ? t.smartBodyLemonade : undefined}
                      layout={wide ? 'wide' : 'tall'}
                      art={row.art + index + (row.key === 'drinks' && index ? 1 : 0)}
                      position={1 + rowIndex * 3 + index}
                      added={inCart.has(tile.product.id)}
                      busy={model.busy}
                      locale={context.locale}
                      onAdd={() => toggleSmart(model, tile.product)}
                    />
                  </Wrapper>
                );
              })}
            </UpsellSection>
          ))}
        </UpsellBoard>
      </ScrollArea>
      <UpsellFooter
        items={orderLines([
          ...model.cart.map((line) => ({ name: line.product.name, quantity: line.quantity })),
          // A stopped line is still part of the order until the guest removes it.
          ...model.unavailableCartLines.map((line) => ({
            name: nameOf(line.productId),
            quantity: line.quantity,
          })),
        ])}
        total={model.cartTotalMinor}
        valid={model.cartValid}
        disabled={blocked}
        busy={model.busy}
        locale={context.locale}
        onCart={model.openCart}
        onSkip={pay}
        onPay={pay}
      />
    </ScreenSurface>
  );
}
export function CartScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const t = copy(context.locale);
  const count = itemCount(model);
  // Design 05: the footer plate names Kaspi QR whenever it is offered.
  const qr = (model.commercialPaymentMethods ?? ['kaspi']).includes('kaspi');
  return (
    <ScreenSurface testID="kiosk-screen-cart" tone="brand" entrance={context.direction}>
      <Header
        {...context}
        back={model.goMenu}
        backLabel={t.menu}
        title={t.yourOrder}
        subtitle={positionsLabel(count, context.locale)}
        mode={modeLabel(model, context)}
        modeKind={model.mode}
        centered
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
            onEdit={model.editLine}
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
        back={model.openUpsell}
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
