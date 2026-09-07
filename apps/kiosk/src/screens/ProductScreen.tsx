import { useState, type SetStateAction } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { KioskModel, KioskModifierGroup, KioskProduct } from '../model';
import { defaultSelections, money, selectedPriceMinor, validSelections } from '../cart';
import { productImage } from '../assets';
import { copy } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import {
  Body,
  Button,
  Dialog,
  Footer,
  Heading,
  IconButton,
  layout,
  type ScreenContext,
} from '../components/UI';
import { ModifierOptions } from '../components/ProductOptions';
import { Hero } from '../components/Hero';
import { ProductArtwork } from '../components/ProductArtwork';
export function ProductScreen({
  model,
  context,
  product,
}: {
  model: KioskModel;
  context: ScreenContext;
  product: KioskProduct;
}) {
  const { px, landscape, compact } = useMetrics();
  const safe = useSafeAreaInsets();
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
  const dark = !isSet;
  const ink = dark ? colors.white : colors.ink;
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
  const nutrition = product.nutrition;
  return (
    <View
      testID="kiosk-screen-product"
      style={[layout.screen, { backgroundColor: dark ? colors.dark : colors.background }]}
    >
      {dark ? (
        product.id === 'pick-combo' ? (
          <Hero product />
        ) : (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ProductArtwork imageId={product.image_id} crop style={StyleSheet.absoluteFill} />
            <LinearGradient
              colors={[
                'rgba(5,10,22,.68)',
                'rgba(5,10,22,.12)',
                'rgba(5,10,22,.52)',
                'rgba(5,10,22,.92)',
                'rgba(5,10,22,.98)',
              ]}
              locations={[0, 0.24, 0.52, 0.78, 1]}
              style={StyleSheet.absoluteFill}
            />
          </View>
        )
      ) : null}
      <View
        style={{
          paddingTop: Math.max(safe.top, px(28)),
          paddingHorizontal: px(30),
          paddingBottom: px(10),
          flexDirection: 'row',
          alignItems: 'center',
          gap: px(20),
        }}
      >
        <IconButton
          name={isSet && wizardStep ? 'arrow-back' : 'close'}
          label={t.close}
          testID="kiosk-product-close"
          dark={dark}
          size={76}
          onPress={() => (isSet && wizardStep ? setWizardStep(0) : model.goMenu())}
        />
        {isSet ? (
          <View style={{ flex: 1, gap: px(10) }}>
            <Body style={{ color: colors.orange, fontFamily: fonts.bold }}>
              {t.step} {wizardStep + 1} / {optionalGroups.length ? 2 : 1}
            </Body>
            <Heading size={40}>{wizardStep === 0 ? t.saucesTitle : t.extrasTitle}</Heading>
          </View>
        ) : null}
      </View>
      <ScrollView
        testID="kiosk-product-scroll"
        style={layout.grow}
        onScrollBeginDrag={model.touch}
        contentContainerStyle={{ paddingHorizontal: px(44), paddingBottom: px(32), gap: px(30) }}
      >
        <View
          style={{
            minHeight: isSet ? 0 : px(landscape ? 300 : compact ? 350 : 500),
            paddingTop: px(18),
            gap: px(20),
            alignItems: isSet ? 'stretch' : 'center',
          }}
        >
          {isSet ? (
            <View style={[layout.row, { gap: px(26) }]}>
              <Image
                source={productImage(product.image_id)}
                contentFit="cover"
                style={{ width: px(280), height: px(210), borderRadius: px(20) }}
              />
              <View style={{ flex: 1, gap: px(14) }}>
                <Heading size={38} color={colors.blue}>
                  {product.name}
                </Heading>
                <Body style={{ color: colors.muted }}>{product.description}</Body>
              </View>
            </View>
          ) : (
            <>
              <Heading size={50} color={ink} style={{ textAlign: 'center' }}>
                {product.name}
              </Heading>
              <Body style={{ color: ink, textAlign: 'center', maxWidth: px(770) }}>
                {product.description}
              </Body>
              <Body
                style={{ color: '#D7DBE4', textAlign: 'center', fontSize: Math.max(16, px(18)) }}
              >
                {product.serving_label} · {nutrition.energy_kcal} {t.kcal} · {t.protein}{' '}
                {nutrition.protein_g} · {t.fat} {nutrition.fat_g} · {t.carbs} {nutrition.carbs_g}
              </Body>
            </>
          )}
        </View>
        {groups.map((group) => (
          <View key={group.id} style={{ gap: px(14) }}>
            <ModifierOptions
              group={group}
              selections={selections}
              setSelections={setSelections}
              locale={context.locale}
              dark={dark}
              limit={group.id === 'drink' && group.options.length > 4 ? 4 : undefined}
            />
            {group.id === 'drink' && group.options.length > 4 ? (
              <Button
                compact
                label={`${t.showAll} (${group.options.length})`}
                tone={dark ? 'glass' : 'outline'}
                onPress={() => setAllGroup(group)}
                testID={`kiosk-modifier-expand-${group.id}`}
              />
            ) : null}
          </View>
        ))}
        <View testID="kiosk-product-nutrition" style={{ gap: px(18), paddingTop: px(8) }}>
          <Body style={{ color: dark ? '#BBC2D2' : colors.muted }}>
            {t.nutrition} · {nutrition.basis === 'per_100_g' ? t.per100 : t.perServing} ·{' '}
            {context.locale === 'ru' ? 'базовый состав' : 'негізгі құрам'}
          </Body>
          <View style={{ flexDirection: 'row', gap: px(10), flexWrap: 'wrap' }}>
            {[
              [t.kcal, nutrition.energy_kcal],
              [t.protein, `${nutrition.protein_g} ${t.grams}`],
              [t.fat, `${nutrition.fat_g} ${t.grams}`],
              [t.carbs, `${nutrition.carbs_g} ${t.grams}`],
            ].map(([label, value]) => (
              <View
                key={label}
                style={{
                  flex: 1,
                  minWidth: px(120),
                  borderRadius: px(18),
                  backgroundColor: dark ? 'rgba(255,255,255,.08)' : colors.white,
                  padding: px(18),
                  gap: px(6),
                }}
              >
                <Heading size={25} color={ink}>
                  {value}
                </Heading>
                <Body
                  style={{ color: dark ? '#BBC2D2' : colors.muted, fontSize: Math.max(15, px(18)) }}
                >
                  {label}
                </Body>
              </View>
            ))}
          </View>
          <Body style={{ color: dark ? '#BBC2D2' : colors.muted }}>
            <Body style={{ fontFamily: fonts.bold, color: ink }}>{t.ingredients}: </Body>
            {product.ingredients}
          </Body>
          <Body style={{ color: dark ? '#BBC2D2' : colors.muted }}>
            {product.allergens.length
              ? `${t.allergens}: ${product.allergens.join(', ')}`
              : t.unknownAllergens}
          </Body>
        </View>
      </ScrollView>
      <Footer
        style={{
          backgroundColor: dark ? colors.dark : colors.white,
          borderTopColor: dark ? 'rgba(255,255,255,.12)' : colors.border,
        }}
      >
        {isSet && wizardStep === 0 && optionalGroups.length ? (
          <Button
            label={t.next}
            icon="arrow-forward"
            disabled={!requiredValid}
            onPress={() => setWizardStep(1)}
            testID="kiosk-set-next"
          />
        ) : (
          <View style={[layout.row, { gap: px(26) }]}>
            <View style={[layout.row, { gap: px(12) }]}>
              <IconButton
                testID="kiosk-product-decrement"
                name="remove"
                label="−"
                dark={dark}
                size={76}
                disabled={quantity <= 1 || model.busy}
                onPress={() => setQuantity((q) => q - 1)}
              />
              <Heading
                testID="kiosk-product-quantity"
                size={32}
                color={ink}
                style={{ minWidth: px(40), textAlign: 'center' }}
              >
                {quantity}
              </Heading>
              <IconButton
                testID="kiosk-product-increment"
                name="add"
                label="+"
                dark={dark}
                size={76}
                disabled={quantity >= 20 || model.busy}
                onPress={() => setQuantity((q) => q + 1)}
              />
            </View>
            <Button
              testID="kiosk-product-add"
              label={price ? `${t.toCart} · ${price}` : t.required}
              disabled={!valid}
              busy={model.busy}
              onPress={() => void model.addToCart(product.id, selections, quantity)}
              style={{ flex: 1, minHeight: px(120) }}
            />
          </View>
        )}
      </Footer>
      <Dialog
        visible={!!allGroup}
        onClose={() => setAllGroup(null)}
        dark={dark}
        testID="kiosk-drinks-sheet"
        placement="bottom"
        footer={
          <Button label={t.done} testID="kiosk-drinks-done" onPress={() => setAllGroup(null)} />
        }
      >
        <View style={layout.spread}>
          <Heading size={36} color={ink}>
            {allGroup?.title}
          </Heading>
          <IconButton name="close" label={t.close} dark={dark} onPress={() => setAllGroup(null)} />
        </View>
        {allGroup ? (
          <ModifierOptions
            group={allGroup}
            selections={selections}
            setSelections={setSelections}
            locale={context.locale}
            dark={dark}
          />
        ) : null}
      </Dialog>
    </View>
  );
}
