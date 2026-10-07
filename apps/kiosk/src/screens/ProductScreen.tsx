import { useState, type SetStateAction } from 'react';
import type { KioskModel, KioskModifierGroup, KioskProduct } from '../model';
import { defaultSelections, money, selectedPriceMinor, validSelections } from '../cart';
import { copy } from '../i18n';
import {
  Body,
  Button,
  Dialog,
  Heading,
  IconButton,
  ScreenSurface,
  ScrollArea,
  Wrapper,
  type ScreenContext,
} from '../components/UI';
import { ModifierOptions } from '../components/ProductOptions';
import { ProductIntro } from '../components/ProductIntro';
import { ProductNutrition } from '../components/ProductNutrition';
import { ProductToolbar } from '../components/ProductToolbar';
import { ProductActions } from '../components/ProductActions';
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
  const [selections, setSelectionState] = useState(() => defaultSelections(product));
  const setSelections = (next: typeof selections) => {
    model.touch();
    setSelectionState(next);
  };
  const [quantity, setQuantityState] = useState(1);
  const setQuantity = (next: SetStateAction<number>) => {
    model.touch();
    setQuantityState(next);
  };
  const [allGroup, setAllGroupState] = useState<KioskModifierGroup | null>(null);
  const setAllGroup = (next: KioskModifierGroup | null) => {
    model.touch();
    setAllGroupState(next);
  };
  const [wizardStep, setWizardState] = useState(0);
  const setWizardStep = (next: number) => {
    model.touch();
    setWizardState(next);
  };
  const isSet = product.category === 'На компанию';
  const valid = validSelections(product, selections);
  const price = valid
    ? money((BigInt(selectedPriceMinor(product, selections)) * BigInt(quantity)).toString())
    : null;
  const requiredGroups = product.modifier_groups.filter((g) => g.min > 0);
  const optionalGroups = product.modifier_groups.filter((g) => g.min === 0);
  const groups = isSet
    ? wizardStep === 0
      ? requiredGroups
      : optionalGroups
    : product.modifier_groups;
  const requiredValid = requiredGroups.every((g) => {
    const count = selections.filter((s) => s.group_id === g.id).reduce((n, s) => n + s.quantity, 0);
    return count >= g.min && count <= g.max;
  });

  return (
    <ScreenSurface testID="kiosk-screen-product">
      <ProductToolbar
        locale={context.locale}
        step={isSet ? wizardStep + 1 : undefined}
        steps={optionalGroups.length ? 2 : 1}
        onClose={() => (isSet && wizardStep ? setWizardStep(0) : model.goMenu())}
      />
      <ScrollArea testID="kiosk-product-scroll" onInteraction={model.touch}>
        <Wrapper padding={28} gap={32}>
          <ProductIntro product={product} locale={context.locale} />
          {groups.map((group) => (
            <Wrapper key={group.id} gap={14}>
              <ModifierOptions
                group={group}
                selections={selections}
                setSelections={setSelections}
                locale={context.locale}
                limit={group.id === 'drink' && group.options.length > 4 ? 4 : undefined}
              />
              {group.id === 'drink' && group.options.length > 4 ? (
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
          <ProductNutrition product={product} locale={context.locale} />
        </Wrapper>
      </ScrollArea>
      <ProductActions
        locale={context.locale}
        quantity={quantity}
        price={price}
        valid={valid}
        available={product.available !== false}
        busy={model.busy}
        next={!!(isSet && wizardStep === 0 && optionalGroups.length)}
        requiredValid={requiredValid}
        onNext={() => setWizardStep(1)}
        onMinus={() => setQuantity((q) => q - 1)}
        onPlus={() => setQuantity((q) => q + 1)}
        onAdd={() => void model.addToCart(product.id, selections, quantity)}
      />
      <Dialog
        visible={!!allGroup}
        onClose={() => setAllGroup(null)}
        testID="kiosk-drinks-sheet"
        placement="bottom"
        footer={
          <Button
            label={t.done}
            testID="kiosk-drinks-done"
            onPress={() => setAllGroup(null)}
            fullWidth
          />
        }
      >
        <Wrapper dir="row" justify="space-between" align="center">
          <Heading size="section">{allGroup?.title}</Heading>
          <IconButton name="close" label={t.close} onPress={() => setAllGroup(null)} />
        </Wrapper>
        <Body tone="muted">{t.choose}</Body>
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
  );
}
