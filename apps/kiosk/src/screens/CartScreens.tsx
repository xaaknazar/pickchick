import { useEffect, useState } from 'react';
import type { KioskModel, KioskProduct } from '../model';
import { defaultSelections, LINE_LIMIT, money, testLineId, validSelections } from '../cart';
import { copy } from '../i18n';
import {
  orderLines,
  orderSummary,
  planUpsell,
  undoUpsellAdds,
  type UpsellLine,
  type UpsellTileKey,
} from '../smartUpsell';
import { CartUpsell } from '../components/CartUpsell';
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
import { ProductSheet } from '../components/ProductSheet';
import { initialSize, sheetFacts, sheetSizeGroup } from '../productSheet';
import { selectionSummary } from '../components/selectionSummary';
import { UpsellQuantity } from '../components/UpsellQuantity';
import { opensInSheet } from '../productSheet';
import { useMetrics } from '../theme';
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
 * products when the screen was opened from the menu. Recommendations exclude those products;
 * the sauce/drink rows keep every available product and its editable quantity.
 */
export interface UpsellMemory {
  base: string[] | null;
  /** The cart's lines and quantities when the screen opened: «Без допов» puts them back. */
  opened?: UpsellLine[] | null;
}
/** The cart's lines (stopped ones included) by id and quantity. */
const cartLines = (model: KioskModel): UpsellLine[] =>
  [...model.cart, ...model.unavailableCartLines].map(({ lineId, quantity }) => ({
    lineId,
    quantity,
  }));
/**
 * Smart upsell (kiosk redesign 2026-10-13, README §4): always opened by «Оформить заказ».
 * The suggestion follows `planUpsell`; both actions open the order review with Kaspi QR.
 * «Без допов»
 * first takes out what was added on the screen during this visit. «В заказе»
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
  const { px } = useMetrics();
  const [sheetId, setSheetId] = useState<string | null>(null);
  const sheet = model.catalog?.products.find((p) => p.id === sheetId);
  const choose = (p: KioskProduct) => {
    model.touch();
    if (opensInSheet(p)) setSheetId(p.id);
    else model.openProduct(p.id);
  };
  const controls = (p: KioskProduct) => {
    const lines = model.cart.filter((line) => line.productId === p.id);
    const last = lines.at(-1);
    return (
      <UpsellQuantity
        productId={p.id}
        detail={
          last
            ? selectionSummary(last)
            : (sheetFacts(p, initialSize(sheetSizeGroup(p))).serving ?? undefined)
        }
        name={p.name}
        quantity={lines.reduce((sum, line) => sum + line.quantity, 0)}
        busy={model.busy}
        increaseDisabled={!!last && last.quantity >= LINE_LIMIT}
        locale={context.locale}
        onIncrease={() => {
          if (last) void model.updateQuantity(last.lineId, last.quantity + 1);
          else choose(p);
        }}
        onDecrease={() => {
          if (last) void model.updateQuantity(last.lineId, last.quantity - 1);
        }}
      />
    );
  };
  const displayedProduct = (p: KioskProduct) => {
    const last = model.cart.filter((line) => line.productId === p.id).at(-1);
    return last ? { ...p, price_minor: last.unitPriceMinor } : p;
  };
  const [base] = useState(() => {
    memory.opened ??= cartLines(model);
    return (memory.base ??= [
      ...model.cart.map((line) => line.productId),
      ...model.unavailableCartLines.map((line) => line.productId),
    ]);
  });
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
  const pay = () => model.goLoyalty();
  // «Без допов» takes out exactly what was added during this visit (the cart goes back to the
  // quantities it had when the screen opened), then goes on to payment like «К оплате».
  const skip = () => {
    model.touch();
    void undoUpsellAdds(model, memory.opened ?? [], cartLines(model)).then((done) => {
      if (done) pay();
    });
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
              product={displayedProduct(hero.product)}
              badge={hero.badge}
              title={heroCopy.title}
              body={heroCopy.body}
              added={inCart.has(hero.product.id)}
              busy={model.busy}
              locale={context.locale}
              onAdd={() => choose(hero.product)}
              controls={controls(hero.product)}
            />
          ) : null}
          {rows.map((row, rowIndex) => (
            <UpsellSection
              key={row.key}
              testID={'kiosk-upsell-' + row.key}
              title={row.title}
              note={row.note}
              horizontal
            >
              {row.tiles.map((tile, index) => {
                return (
                  <Wrapper key={tile.product.id} width={px(326)}>
                    <UpsellTile
                      product={displayedProduct(tile.product)}
                      name={tileName[tile.key] ?? tile.product.name}
                      badge={tile.badge}
                      description={tile.key === 'lemonade' ? t.smartBodyLemonade : undefined}
                      layout="tall"
                      art={row.art + index + (row.key === 'drinks' && index ? 1 : 0)}
                      position={1 + rowIndex * 3 + index}
                      added={inCart.has(tile.product.id)}
                      busy={model.busy}
                      locale={context.locale}
                      onAdd={() => choose(tile.product)}
                      controls={controls(tile.product)}
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
        onSkip={skip}
        onPay={pay}
      />
      {sheet ? (
        <ProductSheet
          key={sheet.id}
          product={sheet}
          locale={context.locale}
          busy={model.busy}
          cart={model.cart}
          onInteraction={model.touch}
          onClose={() => setSheetId(null)}
          onAdd={(selections, quantity) =>
            void model.addToCart(sheet.id, selections, quantity).then((added) => {
              if (added) setSheetId(null);
            })
          }
        />
      ) : null}
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
  useEffect(() => {
    if (model.commercial) model.setPaymentMethod('kaspi');
  }, [model.commercial, model.setPaymentMethod]);
  const qrAvailable =
    !model.commercial || (model.commercialPaymentMethods ?? ['kaspi']).includes('kaspi');
  return (
    <ScreenSurface testID="kiosk-screen-loyalty" tone="brand" entrance={context.direction}>
      <Header
        {...context}
        back={model.openUpsell}
        title={t.payTitle}
        subtitle={positionsLabel(count, context.locale)}
      />
      <OrderProgress step="payment" locale={context.locale} />
      <ScrollArea onInteraction={model.touch}>
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
            <PaymentMethodCard
              method="kaspi"
              position={0}
              selected
              busy={model.busy}
              commercial={!!model.commercial}
              locale={context.locale}
              onSelect={() => model.setPaymentMethod('kaspi')}
            />
          </Wrapper>
          <Body tone="onBlue">
            {model.commercial
              ? model.checkoutReady && qrAvailable
                ? t.qrNextScreen
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
          label={t.createPayment}
          icon="arrow-forward"
          testID="kiosk-review-create"
          disabled={
            !model.cartValid ||
            !model.cart.length ||
            (model.commercial && (!model.checkoutReady || !qrAvailable))
          }
          busy={model.busy}
          onPress={() => {
            if (model.commercial) model.setPaymentMethod('kaspi');
            void model.beginPayment('kaspi');
          }}
          fullWidth
        />
      </Footer>
    </ScreenSurface>
  );
}
