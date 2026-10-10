import { useEffect, useRef, useState, type SetStateAction } from 'react';
import type { KioskModel, KioskModifierGroup, KioskProduct, KioskSelection } from '../model';
import {
  LINE_LIMIT,
  LINES_LIMIT,
  defaultSelections,
  selectedPriceMinor,
  testLineId,
  validSelections,
} from '../cart';
import { copy } from '../i18n';
import {
  Body,
  Button,
  Dialog,
  IconButton,
  ScreenSurface,
  ScrollArea,
  Wrapper,
  type ScreenContext,
  type ScrollFocus,
} from '../components/UI';
import { RevealCircle } from '../components/RevealCircle';
import { ModifierOptions } from '../components/ProductOptions';
import { ProductIntro } from '../components/ProductIntro';
import { ProductToolbar } from '../components/ProductToolbar';
import { ProductActions } from '../components/ProductActions';
import { Toast } from '../components/Toast';
// One v3 row of drinks (five across) stays inline; the full list opens in the sheet.
const inlineDrinks = 5;
// Prototype: 420 ms after a pick completes a group, the next group scrolls up.
const advanceDelay = 420;
/** Picks that still count: an option stopped while the page is open no longer fills its group. */
const countIn = (selections: KioskSelection[], group: KioskModifierGroup) =>
  selections
    .filter(
      (s) =>
        s.group_id === group.id && group.options.some((o) => o.id === s.option_id && o.available),
    )
    .reduce((n, s) => n + s.quantity, 0);
const complete = (selections: KioskSelection[], group: KioskModifierGroup) => {
  const count = countIn(selections, group);
  return count >= group.min && count <= group.max;
};
const signature = (selections: KioskSelection[], group: KioskModifierGroup) =>
  selections
    .filter((s) => s.group_id === group.id)
    .map((s) => s.option_id + ':' + s.quantity)
    .join(',');
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
  const [allGroupId, setAllGroupState] = useState<string | null>(null);
  const allGroup = product.modifier_groups.find((g) => g.id === allGroupId) ?? null;
  const setAllGroup = (next: KioskModifierGroup | null) => {
    model.touch();
    setAllGroupState(next?.id ?? null);
  };
  // iOS shows one modal at a time: the idle countdown closes the sheet first.
  const warned = model.idleWarningSeconds !== null;
  useEffect(() => {
    if (warned) setAllGroupState(null);
  }, [warned]);
  const [stopNotice, setStopNotice] = useState<{ message: string; id: number } | null>(null);
  const current = useRef(selections);
  current.current = selections;
  const [wizardStep, setWizardState] = useState(0);
  const setWizardStep = (next: number) => {
    model.touch();
    setWizardState(next);
  };
  const isSet = product.category === 'На компанию';
  const valid = validSelections(product, selections);
  const requiredGroups = product.modifier_groups.filter((g) => g.min > 0);
  const optionalGroups = product.modifier_groups.filter((g) => g.min === 0);
  const groups = isSet
    ? wizardStep === 0
      ? requiredGroups
      : optionalGroups
    : product.modifier_groups;
  const requiredValid = requiredGroups.every((g) => complete(selections, g));
  // Cart limits for this exact choice: what is already in the cart counts.
  const lineId = testLineId(product.id, selections);
  // The edited line itself is replaced, so it takes no room.
  const inCart =
    model.cart.find((l) => l.lineId === lineId && l.lineId !== editing?.lineId)?.quantity ?? 0;
  const linesFull =
    !inCart && !editing && model.cart.length + model.unavailableCartLines.length >= LINES_LIMIT;
  const room = linesFull ? 0 : LINE_LIMIT - inCart;
  const limit = room > 0 ? null : linesFull ? t.limitLines : t.limitLine;
  const shownQuantity = Math.max(1, Math.min(quantity, room));
  const price = valid
    ? (BigInt(selectedPriceMinor(product, selections)) * BigInt(shownQuantity)).toString()
    : null;
  const collapsed = (group: KioskModifierGroup) =>
    group.id === 'drink' && group.options.length > inlineDrinks;
  const setSelections = (next: typeof selections) => {
    model.touch();
    stopAdvance();
    // A pick (not a removal) that leaves its group complete brings the next group up.
    const index = groups.findIndex((g) => signature(selections, g) !== signature(next, g));
    const group = groups[index];
    const following = groups[index + 1];
    if (
      group &&
      following &&
      countIn(next, group) >= countIn(selections, group) &&
      complete(next, group)
    )
      advance.current = setTimeout(() => {
        advance.current = null;
        focusOn(following.id, true);
      }, advanceDelay);
    setSelectionState(next);
  };
  // A pick stopped while the page is open (availability long-poll) is taken out, the group's
  // other defaults come back if any, and the guest is told and pointed at the group.
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
    const missing = product.modifier_groups.find((g) => countIn(next, g) < g.min);
    if (missing) {
      focusOn(missing.id, false);
      setAttention((now) => ({ group: missing.id, request: (now?.request ?? 0) + 1 }));
    }
    // Runs on every availability change of the shown product only.
  }, [product]);
  // The pale "to cart" pill was tapped: bring the first missing group up and shake it.
  const pointAtMissing = () => {
    model.touch();
    stopAdvance();
    const missing = groups.find((g) => !complete(selections, g));
    if (!missing) return;
    focusOn(missing.id, false);
    setAttention((now) => ({ group: missing.id, request: (now?.request ?? 0) + 1 }));
  };

  return (
    <RevealCircle>
      <ScreenSurface testID="kiosk-screen-product" tone="brand">
        <ScrollArea
          // A new set step opens at the top, so the hero's back disc is in view again.
          key={'step-' + wizardStep}
          testID="kiosk-product-scroll"
          onInteraction={model.touch}
          parallax
          focus={focus}
        >
          <ProductIntro product={product} locale={context.locale}>
            {groups.map((group) => (
              <Wrapper key={group.id} gap={14}>
                <ModifierOptions
                  group={group}
                  selections={selections}
                  setSelections={setSelections}
                  locale={context.locale}
                  limit={collapsed(group) ? inlineDrinks : undefined}
                  attention={attention?.group === group.id ? attention.request : undefined}
                />
                {collapsed(group) ? (
                  <Button
                    size="compact"
                    label={`${t.showAll} (${group.options.length})`}
                    tone="secondary"
                    onPress={() => setAllGroup(group)}
                    testID={`kiosk-modifier-expand-${group.id}`}
                  />
                ) : null}
              </Wrapper>
            ))}
          </ProductIntro>
          {/* Design: the close disc sits in the hero and scrolls away with the page. */}
          <ProductToolbar
            locale={context.locale}
            step={isSet ? wizardStep + 1 : undefined}
            steps={optionalGroups.length ? 2 : 1}
            onClose={() => (isSet && wizardStep ? setWizardStep(0) : model.closeProduct())}
          />
        </ScrollArea>
        <ProductActions
          locale={context.locale}
          quantity={shownQuantity}
          max={Math.max(1, room)}
          limit={limit}
          price={price}
          valid={valid}
          available={product.available !== false}
          busy={model.busy}
          next={!!(isSet && wizardStep === 0 && optionalGroups.length)}
          requiredValid={requiredValid}
          onNext={() => setWizardStep(1)}
          onMinus={() => setQuantity((q) => Math.max(1, Math.min(q, room) - 1))}
          onPlus={() => setQuantity((q) => Math.min(room, q + 1))}
          save={!!editing}
          onAdd={() => void model.addToCart(product.id, selections, shownQuantity, editing?.lineId)}
          onAttention={pointAtMissing}
        />
        <Toast
          testID="kiosk-product-toast"
          message={stopNotice?.message ?? ''}
          trigger={stopNotice?.id ?? null}
        />
        <Dialog
          visible={!!allGroup && !warned}
          onClose={() => setAllGroup(null)}
          testID="kiosk-drinks-sheet"
          placement="bottom"
          tone="brand"
          footer={
            <Button
              label={t.done}
              testID="kiosk-drinks-done"
              onPress={() => setAllGroup(null)}
              fullWidth
            />
          }
        >
          <Wrapper dir="row" justify="space-between" align="center" gap={16}>
            <Body tone="onBlue">{t.choose}</Body>
            <IconButton
              name="close"
              label={t.close}
              tone="inverse"
              onPress={() => setAllGroup(null)}
            />
          </Wrapper>
          {allGroup ? (
            <ModifierOptions
              group={allGroup}
              selections={selections}
              setSelections={setSelections}
              locale={context.locale}
            />
          ) : null}
        </Dialog>
      </ScreenSurface>
    </RevealCircle>
  );
}
