import { useEffect, useRef, useState } from 'react';
import type { KioskModel } from '../model';
import { copy } from '../i18n';
import { defaultSelections, validSelections } from '../cart';
import { Header, ScreenSurface, Wrapper, type ScreenContext } from '../components/UI';
import { CategoryRail } from '../components/CategoryRail';
import { MenuGrid } from '../components/MenuGrid';
import { CartBar } from '../components/CartBar';
import { inCategory, type Category, type MenuMemory } from '../components/categories';
export type { MenuMemory } from '../components/categories';
// Single pilot point; the catalog carries only a branch id, not its display name.
const branchName = 'ТЦ Abay Plaza';
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
  const featured =
    products.find((p) => p.name === 'Master Combo') ??
    products.find((p) => inCategory(p, 'combo')) ??
    null;
  const quantity = model.cart.reduce((sum, line) => sum + line.quantity, 0);
  const previousQuantity = useRef(memory.cartQuantity ?? quantity);
  useEffect(() => {
    memory.cartQuantity = quantity;
  }, [memory, quantity]);
  return (
    <ScreenSurface testID="kiosk-screen-menu" tone="brand">
      <Header
        {...context}
        title={t.menu}
        subtitle={branchName}
        mode={model.mode === 'dine_in' ? t.hereChip : t.togo}
        onMode={model.goMode}
      />
      <Wrapper dir="row" flex={1}>
        <CategoryRail
          category={category}
          products={products}
          locale={context.locale}
          onSelect={(key) => {
            model.touch();
            memory.category = key;
            memory.offsets[key] = 0;
            setCategory(key);
            setRevision((v) => v + 1);
          }}
        />
        <MenuGrid
          key={category + '-' + revision}
          products={products.filter((p) => inCategory(p, category))}
          category={category}
          memory={memory}
          locale={context.locale}
          busy={model.busy}
          featured={featured}
          onInteraction={model.touch}
          onOpen={(p) => model.openProduct(p.id)}
          onAdd={(p) => {
            const selected = defaultSelections(p);
            if (p.modifier_groups.length || !validSelections(p, selected)) model.openProduct(p.id);
            else void model.addToCart(p.id, selected);
          }}
        />
      </Wrapper>
      <CartBar
        previousQuantity={previousQuantity.current}
        quantity={model.cart.reduce((s, l) => s + l.quantity, 0)}
        total={model.cartTotalMinor}
        valid={model.cartValid}
        empty={!model.cart.length && !model.unavailableCartLines.length}
        busy={model.busy}
        locale={context.locale}
        onCheckout={model.cartValid ? model.openUpsell : model.openCart}
      />
    </ScreenSurface>
  );
}
