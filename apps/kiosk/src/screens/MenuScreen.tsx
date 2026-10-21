import { useEffect, useRef, useState } from 'react';
import type { KioskModel, KioskProduct } from '../model';
import { copy } from '../i18n';
import { defaultSelections, validSelections } from '../cart';
import { Header, pilotBranch, ScreenSurface, Wrapper, type ScreenContext } from '../components/UI';
import { PhotoEntry } from '../components/PhotoEntry';
import { CategoryRail } from '../components/CategoryRail';
import { MenuGrid } from '../components/MenuGrid';
import { CartBar } from '../components/CartBar';
import { Toast } from '../components/Toast';
import { ProductSheet } from '../components/ProductSheet';
import { inCategory, type Category, type MenuMemory } from '../components/categories';
import { opensInSheet } from '../productSheet';
export type { MenuMemory } from '../components/categories';
export function MenuScreen({
  model,
  context,
  memory,
}: {
  model: KioskModel;
  context: ScreenContext;
  memory: MenuMemory;
}) {
  const t = copy(context.locale);
  const [category, setCategory] = useState<Category>(memory.category);
  const [revision, setRevision] = useState(0);
  const products = model.catalog?.products ?? [];
  // Simple products (extras, drinks and sauces without a choice or with one size choice) open
  // as a sheet over the menu (product-and-payment.md §3); everything else keeps the product page.
  const [sheetId, setSheetId] = useState<string | null>(null);
  const sheet = sheetId ? products.find((p) => p.id === sheetId) : undefined;
  const open = (p: KioskProduct) => {
    if (!opensInSheet(p)) return model.openProduct(p.id);
    model.touch();
    setSheetId(p.id);
  };
  const quantity = model.cart.reduce((sum, line) => sum + line.quantity, 0);
  const previousQuantity = useRef(memory.cartQuantity ?? quantity);
  const previousTotal = useRef(memory.cartTotal ?? model.cartTotalMinor);
  useEffect(() => {
    memory.cartQuantity = quantity;
    memory.cartTotal = model.cartTotalMinor;
  }, [memory, model.cartTotalMinor, quantity]);
  // The line of the latest add (an earlier line that grew keeps its place in the cart).
  const added = model.lastAdded
    ? (model.cart.find((line) => line.lineId === model.lastAdded!.lineId) ?? null)
    : null;
  const addSerial = model.lastAdded?.serial ?? 0;
  // A line added on the product screen just closed flies into the bag; its
  // card's count badge waits for the landing.
  const [arrival] = useState(() =>
    context.from === 'product' && addSerial > (memory.addSerial ?? 0) ? added : null,
  );
  const [arriving, setArriving] = useState(arrival?.productId ?? null);
  const counts: Record<string, number> = {};
  for (const line of model.cart)
    counts[line.productId] = (counts[line.productId] ?? 0) + line.quantity;
  // Every add (here or on the product screen just closed) replaces the toast with
  // that line's name; a quantity that grows by itself (availability) shows none.
  // Adds made on the upsell or cart screens are not announced again on return.
  const announced = useRef(context.from === 'product' ? (memory.addSerial ?? 0) : addSerial);
  const [toast, setToast] = useState<{ message: string; id: number } | null>(null);
  const addedMessage = added ? t.addedToCart + ': ' + added.product.name : t.addedToCart;
  useEffect(() => {
    if (addSerial > announced.current)
      setToast((current) => ({ message: addedMessage, id: (current?.id ?? 0) + 1 }));
    announced.current = addSerial;
    memory.addSerial = addSerial;
  }, [addSerial, addedMessage, memory]);
  const select = (key: Category) => {
    model.touch();
    memory.category = key;
    memory.offsets[key] = 0;
    setCategory(key);
    setRevision((v) => v + 1);
  };
  return (
    <ScreenSurface
      testID="kiosk-screen-menu"
      tone="redesign"
      entrance={
        // Arrival from the dining choice and from a product has its own reveal.
        context.from === 'mode' || context.from === 'product' || context.from === 'boot'
          ? 'none'
          : context.direction
      }
    >
      <Header
        {...context}
        title={t.menu}
        subtitle={pilotBranch}
        dining={model.mode}
        onDining={(mode) => (mode === model.mode ? true : model.setMode(mode))}
        minimal
      />
      <Wrapper dir="row" flex={1}>
        <CategoryRail
          category={category}
          products={products}
          locale={context.locale}
          onSelect={select}
          footer={
            <PhotoEntry
              locale={context.locale}
              onInteraction={model.touch}
              disabled={model.busy || !!sheet || model.idleWarningSeconds !== null}
            />
          }
        />
        <MenuGrid
          key={category + '-' + revision}
          products={products.filter((p) => inCategory(p, category))}
          category={category}
          memory={memory}
          locale={context.locale}
          busy={model.busy}
          cartCounts={counts}
          arriving={arriving}
          onInteraction={model.touch}
          onOpen={open}
          onAdd={(p) => {
            const selected = defaultSelections(p);
            if (p.modifier_groups.length || !validSelections(p, selected)) open(p);
            else void model.addToCart(p.id, selected);
          }}
        />
      </Wrapper>
      <CartBar
        lines={model.cart}
        previousQuantity={previousQuantity.current}
        quantity={quantity}
        total={model.cartTotalMinor}
        previousTotal={previousTotal.current}
        valid={model.cartValid}
        empty={!model.cart.length && !model.unavailableCartLines.length}
        busy={model.busy}
        locale={context.locale}
        arrival={arrival}
        onLanded={() => setArriving(null)}
        onCheckout={model.openUpsell}
        onOpenCart={model.openCart}
      />
      <Toast
        testID="kiosk-toast"
        message={toast?.message ?? t.addedToCart}
        trigger={toast?.id ?? null}
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
          // The product page's add: the same selections and quantity; the sheet closes once the
          // line is in the cart (the bar below updates and the toast names it).
          onAdd={(selections, count) =>
            void model.addToCart(sheet.id, selections, count).then((added) => {
              if (added) setSheetId(null);
            })
          }
        />
      ) : null}
    </ScreenSurface>
  );
}
