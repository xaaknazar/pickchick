import { useEffect, useRef, useState, type SetStateAction } from 'react';
import type { KioskModel, KioskModifierGroup, KioskProduct, KioskSelection } from '../model';
import {
  LINE_LIMIT,
  defaultSelections,
  selectedPriceMinor,
  testLineId,
  validSelections,
} from '../cart';
import { copy } from '../i18n';
import { productCopy } from '../productCopy';
import {
  cardGroups,
  chooseText,
  firstMissing,
  groupComplete,
  groupCount,
  includedLabel,
  kindLabel,
  productKind,
  selectionSummary,
  servingOf,
} from '../product-presentation';
import {
  Dialog,
  Heading,
  IconButton,
  ScreenSurface,
  ScrollArea,
  Wrapper,
  type ScreenContext,
  type ScrollFocus,
} from '../components/UI';
import { RevealCircle } from '../components/RevealCircle';
import { ComboHeader } from '../components/ComboHeader';
import { ComboHero } from '../components/ComboHero';
import { ComboSection } from '../components/ComboSection';
import { ComboOptionSheet } from '../components/ComboOptionSheet';
import { ComboPanel } from '../components/ComboPanel';
import { ProductNutrition } from '../components/ProductNutrition';
import { Toast } from '../components/Toast';
// Prototype: 420 ms after a pick completes a section, the next section scrolls up.
const advanceDelay = 420;
const signature = (selections: KioskSelection[], group: KioskModifierGroup) =>
  selections
    .filter((s) => s.group_id === group.id)
    .map((s) => s.option_id + ':' + s.quantity)
    .join(',');
/**
 * Product card of the kiosk redesign 2026-10-13 (product-and-payment.md §1-2): header, cream
 * hero, one numbered section per choice (drinks with the «Ещё N» sheet), and the glass panel
 * with the quantity, the picks and «В корзину». Pick Combo fits one 1024x1366 screen; more
 * sections scroll under the fixed panel. Selection rules, prices and the cart are unchanged.
 */
export function ProductScreen({
  model,
  context,
  product,
}: {
  model: KioskModel;
  context: ScreenContext;
  product: KioskProduct;
}) {
  const t = copy(context.locale);
  const tp = productCopy(context.locale);
  // "Изменить" in the cart: the page opens with that line's choice and saves over it.
  const [editing] = useState(() =>
    model.editingLine?.productId === product.id ? model.editingLine : null,
  );
  const [selections, setSelectionState] = useState(() =>
    editing ? editing.selections : defaultSelections(product),
  );
  const [focus, setFocus] = useState<ScrollFocus | undefined>(undefined);
  const [attention, setAttention] = useState<{ group: string; request: number } | null>(null);
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopAdvance = () => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
  };
  useEffect(() => () => stopAdvance(), []);
  const focusOn = (target: string, ahead: boolean) =>
    setFocus((now) => ({ target, request: (now?.request ?? 0) + 1, ahead }));
  const [quantity, setQuantityState] = useState(() => editing?.quantity ?? 1);
  const setQuantity = (next: SetStateAction<number>) => {
    model.touch();
    setQuantityState(next);
  };
  // The sheet keeps only the group id: its options always show the current availability.
  const [sheetGroupId, setSheetGroupState] = useState<string | null>(null);
  const sheetGroup = product.modifier_groups.find((g) => g.id === sheetGroupId) ?? null;
  const setSheetGroup = (next: KioskModifierGroup | null) => {
    model.touch();
    setSheetGroupState(next?.id ?? null);
  };
  const [details, setDetailsState] = useState(false);
  const setDetails = (open: boolean) => {
    model.touch();
    setDetailsState(open);
  };
  // iOS shows one modal at a time: the idle countdown closes the sheets first.
  const warned = model.idleWarningSeconds !== null;
  useEffect(() => {
    if (!warned) return;
    setSheetGroupState(null);
    setDetailsState(false);
  }, [warned]);
  const [stopNotice, setStopNotice] = useState<{ message: string; id: number } | null>(null);
  const current = useRef(selections);
  current.current = selections;
  const groups = cardGroups(product);
  const valid = validSelections(product, selections);
  // Cart limits for this exact choice: what is already in the cart counts.
  const lineId = testLineId(product.id, selections);
  // The edited line itself is replaced, so it takes no room.
  const inCart =
    model.cart.find((l) => l.lineId === lineId && l.lineId !== editing?.lineId)?.quantity ?? 0;
  const room = LINE_LIMIT - inCart;
  const limit = room > 0 ? null : t.limitLine;
  const shownQuantity = Math.max(1, Math.min(quantity, room));
  const price = valid
    ? (BigInt(selectedPriceMinor(product, selections)) * BigInt(shownQuantity)).toString()
    : null;
  const kind = productKind(product.category);
  const included = includedLabel(kind, tp);
  const missing = firstMissing(groups, selections);
  const serving = servingOf(product);
  const setSelections = (next: KioskSelection[]) => {
    model.touch();
    stopAdvance();
    // A pick (not a removal) that leaves its section complete brings the next section up.
    const index = groups.findIndex((g) => signature(selections, g) !== signature(next, g));
    const group = groups[index];
    const following = groups[index + 1];
    if (
      group &&
      following &&
      groupCount(group, next) >= groupCount(group, selections) &&
      groupComplete(group, next)
    )
      advance.current = setTimeout(() => {
        advance.current = null;
        focusOn(following.id, true);
      }, advanceDelay);
    setSelectionState(next);
  };
  // A pick stopped while the page is open (availability long-poll) is taken out, the group's
  // other defaults come back if any, and the guest is told and pointed at the section.
  useEffect(() => {
    const available = (s: KioskSelection) =>
      product.modifier_groups
        .find((g) => g.id === s.group_id)
        ?.options.some((o) => o.id === s.option_id && o.available) ?? false;
    const previous = current.current;
    const stopped = previous.filter((s) => !available(s));
    if (!stopped.length) return;
    let next = previous.filter(available);
    for (const group of product.modifier_groups)
      if (!next.some((s) => s.group_id === group.id))
        next = [...next, ...defaultSelections(product).filter((s) => s.group_id === group.id)];
    setSelectionState(next);
    const names = stopped
      .map(
        (s) =>
          product.modifier_groups
            .find((g) => g.id === s.group_id)
            ?.options.find((o) => o.id === s.option_id)?.label,
      )
      .filter(Boolean)
      .join(', ');
    setStopNotice((now) => ({
      message: t.optionStopped.replace('{name}', names),
      id: (now?.id ?? 0) + 1,
    }));
    const empty = cardGroups(product).find((g) => groupCount(g, next) < g.min);
    if (empty) {
      focusOn(empty.id, false);
      setAttention((now) => ({ group: empty.id, request: (now?.request ?? 0) + 1 }));
    }
    // Runs on every availability change of the shown product only.
  }, [product]);
  // The pale "to cart" button was tapped: bring the first empty section up and shake it.
  const pointAtMissing = () => {
    model.touch();
    stopAdvance();
    if (!missing) return;
    focusOn(missing.id, false);
    setAttention((now) => ({ group: missing.id, request: (now?.request ?? 0) + 1 }));
  };
  return (
    <RevealCircle>
      <ScreenSurface testID="kiosk-screen-product" tone="redesign">
        <ComboHeader
          locale={context.locale}
          setLocale={context.setLocale}
          title={product.name}
          subtitle={[kindLabel(kind, tp), serving].filter(Boolean).join(' · ')}
          back={context.from === 'upsell' || context.from === 'cart' ? t.back : t.menu}
          onBack={model.closeProduct}
          onHelp={context.onHelp}
        />
        <ScrollArea testID="kiosk-product-scroll" onInteraction={model.touch} focus={focus}>
          <Wrapper paddingX={16} paddingY={20} gap={26}>
            <ComboHero
              product={product}
              selections={selections}
              locale={context.locale}
              onDetails={() => setDetails(true)}
            />
            {groups.map((group, index) => (
              <ComboSection
                key={group.id}
                number={index + 1}
                group={group}
                selections={selections}
                setSelections={setSelections}
                included={included}
                locale={context.locale}
                attention={attention?.group === group.id ? attention.request : undefined}
                onMore={() => setSheetGroup(group)}
              />
            ))}
            {/* Room under the last section for the fixed panel (22 + 112 from the bottom). */}
            <Wrapper paddingY={58} />
          </Wrapper>
        </ScrollArea>
        <ComboPanel
          locale={context.locale}
          quantity={shownQuantity}
          max={Math.max(1, room)}
          limit={limit}
          price={price}
          valid={valid}
          available={product.available !== false}
          busy={model.busy}
          save={!!editing}
          summary={groups.length ? selectionSummary(groups, selections) : ''}
          status={groups.length ? (missing ? chooseText(missing, tp) : tp.allChosen) : product.name}
          onMinus={() => setQuantity((q) => Math.max(1, Math.min(q, room) - 1))}
          onPlus={() => setQuantity((q) => Math.min(room, q + 1))}
          onAdd={() => void model.addToCart(product.id, selections, shownQuantity, editing?.lineId)}
          onAttention={pointAtMissing}
        />
        <Toast
          testID="kiosk-product-toast"
          message={stopNotice?.message ?? ''}
          trigger={stopNotice?.id ?? null}
        />
        <ComboOptionSheet
          visible={!!sheetGroup && !warned}
          group={sheetGroup}
          productName={product.name}
          selections={selections}
          setSelections={setSelections}
          included={included}
          locale={context.locale}
          onClose={() => setSheetGroup(null)}
        />
        <Dialog
          visible={details && !warned}
          onClose={() => setDetails(false)}
          testID="kiosk-product-details-sheet"
          placement="bottom"
          tone="brand"
        >
          <Wrapper dir="row" justify="space-between" align="center" gap={16}>
            <Heading size="section" tone="inverse">
              {product.name}
            </Heading>
            <IconButton
              name="close"
              label={t.close}
              tone="inverse"
              testID="kiosk-product-details-close"
              onPress={() => setDetails(false)}
            />
          </Wrapper>
          <ProductNutrition product={product} locale={context.locale} />
        </Dialog>
      </ScreenSurface>
    </RevealCircle>
  );
}
