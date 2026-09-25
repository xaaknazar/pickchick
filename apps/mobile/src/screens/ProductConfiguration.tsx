import { MotionPressable as Pressable } from '../components/Motion';
import { useState } from 'react';
import { Image } from 'expo-image';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CartLine, ModifierGroup, Product, ScreenProps, Selection } from '../model';
import { cartLineKey, defaultSelections, lineUnitPrice, validSelections } from '../domain';
import { HeroVideo } from '../components/Brand';
import {
  Body,
  BottomActions,
  Button,
  Caption,
  Empty,
  Heading,
  Icon,
  IconButton,
  MinorMoney,
  NavRow,
  Page,
  Row,
  styles as ui,
} from '../components/UI';
import { colors, font } from '../theme';

export function ProductConfiguration(props: ScreenProps) {
  const product = props.model.selectedProduct ?? props.model.products[0];
  if (!product)
    return (
      <Page props={props} title="Блюдо">
        <Empty
          title="Блюдо не выбрано"
          detail="Выберите любимое в меню."
          action={<Button title="В меню" onPress={() => props.navigate('M06')} />}
        />
      </Page>
    );
  return (
    <ConfiguredProduct
      key={`${product.source}:${product.catalogVersion}:${product.id}`}
      {...props}
      product={product}
    />
  );
}
export function ConfiguredProduct(
  props: ScreenProps & {
    product: Product;
    editing?: CartLine;
    onSave?(selections: Selection[], quantity: number): void;
  },
) {
  const { product } = props;
  const insets = useSafeAreaInsets();
  const { fontScale, width, height } = useWindowDimensions();
  const [selections, setSelections] = useState<Selection[]>(
    () => props.editing?.selections ?? defaultSelections(product),
  );
  const [quantity, setQuantity] = useState(props.editing?.quantity ?? 1);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState(false);
  const candidate = { product, selections };
  const unitPrice = lineUnitPrice(candidate);
  const existing = props.model.cart.find(
    (line) =>
      cartLineKey(line) === cartLineKey(candidate) &&
      (!props.editing || cartLineKey(line) !== cartLineKey(props.editing)),
  );
  const full = !props.editing && !existing && props.model.cart.length >= 11;
  const valid =
    validSelections(product, selections) && !full && (existing?.quantity ?? 0) + quantity <= 20;
  const incompleteGroup = product.modifierGroups?.find((group) => {
    const total = selections
      .filter((selection) => selection.group_id === group.id)
      .reduce((sum, selection) => sum + selection.quantity, 0);
    return total < group.min || total > group.max;
  });
  const blockedReason = full
    ? 'В корзине уже 11 разных позиций. Удалите одну, чтобы добавить новую.'
    : (existing?.quantity ?? 0) + quantity > 20
      ? 'В одном заказе можно до 20 одинаковых наборов.'
      : incompleteGroup
        ? `Завершите выбор: ${incompleteGroup.title.toLowerCase()}.`
        : !valid
          ? 'Проверьте выбранные добавки: часть вариантов недоступна.'
          : null;
  const select = (group: ModifierGroup, optionId: string, value: number) => {
    const rest = selections.filter((s) =>
      group.max === 1
        ? s.group_id !== group.id
        : !(s.group_id === group.id && s.option_id === optionId),
    );
    setSelections(
      value ? [...rest, { group_id: group.id, option_id: optionId, quantity: value }] : rest,
    );
  };
  const multiplier = selections.reduce(
    (n, s) =>
      n *
      (product.modifierGroups
        ?.find((g) => g.id === s.group_id)
        ?.options.find((o) => o.id === s.option_id)?.nutrition_multiplier ?? 1),
    1,
  );
  const nutrition = product.nutrition;
  const serving =
    product.modifierGroups
      ?.find((g) => g.id === 'size')
      ?.options.find((o) => selections.some((s) => s.group_id === 'size' && s.option_id === o.id))
      ?.label ?? product.servingLabel;
  return (
    <View testID={`screen-${props.screenId}`} style={ui.page}>
      <ScrollView
        testID={`scroll-${props.screenId}`}
        style={ui.scroll}
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        <View
          testID="product-media"
          style={{
            height: Math.min(width, height * 0.55, 560),
            backgroundColor: colors.background,
          }}
        >
          {product.id === 'pick-combo' ? (
            <HeroVideo shaded={false} blendBottom />
          ) : (
            <Image source={product.image} style={StyleSheet.absoluteFill} contentFit="cover" />
          )}
          <IconButton
            testID="product-close"
            name="close"
            label="Закрыть блюдо"
            onPress={props.goBack}
            color="#12151C"
            style={[s.close, { top: insets.top + 8 }]}
          />
        </View>
        <View testID="product-content" style={s.body}>
          <Heading style={s.title}>{product.name}</Heading>
          <Body muted style={s.description}>
            {product.description}
          </Body>
          {serving ? <Caption>{serving}</Caption> : null}
          {nutrition ? (
            <View testID="product-nutrition" style={s.nutrition}>
              <Caption style={{ width: '100%', fontFamily: font.bold }}>
                КБЖУ · {nutrition.basis === 'per_serving' ? 'базовая порция' : 'на 100 г'}
              </Caption>
              {[
                [nutrition.energy_kcal, 'ккал'],
                [nutrition.protein_g, 'белки, г'],
                [nutrition.fat_g, 'жиры, г'],
                [nutrition.carbs_g, 'углеводы, г'],
              ].map(([value, label], index) => (
                <View
                  key={String(label)}
                  style={{
                    flexGrow: 1,
                    flexBasis: fontScale > 1.3 ? '40%' : '20%',
                    gap: 3,
                    alignItems: 'center',
                    backgroundColor: colors.raised,
                    borderRadius: 14,
                    paddingVertical: 10,
                    paddingHorizontal: 5,
                  }}
                >
                  <Heading
                    small
                    style={{
                      fontSize: 19,
                      lineHeight: 26,
                      color: index === 0 ? colors.accent : colors.text,
                    }}
                  >
                    {Math.round(Number(value) * multiplier)}
                  </Heading>
                  <Caption style={{ fontSize: 11.5, lineHeight: 17, textAlign: 'center' }}>
                    {label}
                  </Caption>
                </View>
              ))}
            </View>
          ) : null}
          <NavRow
            title="Подробнее о составе"
            subtitle="Ингредиенты и пищевая ценность"
            icon="information-circle-outline"
            onPress={() => setDetails(!details)}
          />
          {details ? (
            <View style={s.info}>
              <Body muted>{product.ingredients || product.description}</Body>
              <Caption>
                {product.allergens?.length
                  ? `Аллергены: ${product.allergens.join(', ')}.`
                  : 'Сведения об аллергенах ресторан ещё не подтвердил.'}
              </Caption>
              <Caption>
                Описание и КБЖУ перенесены из макета. Пищевая ценность дополнительных опций не
                включена.
              </Caption>
            </View>
          ) : null}
          {(product.modifierGroups ?? []).map((group) => {
            const total = selections
              .filter((s) => s.group_id === group.id)
              .reduce((n, s) => n + s.quantity, 0);
            const radio = group.max === 1;
            const groupSelections = selections.filter(
              (selection) => selection.group_id === group.id,
            );
            const selectedLabels = groupSelections
              .map(
                (selection) =>
                  group.options.find((option) => option.id === selection.option_id)?.label,
              )
              .filter(Boolean);
            const visible =
              group.id !== 'drink' || expanded[group.id] || group.options.length <= 5
                ? group.options
                : group.options.slice(0, 4);
            return (
              <View key={group.id} testID={`modifier-group-${group.id}`} style={s.group}>
                <View style={{ gap: 4 }}>
                  <Heading small style={s.groupTitle}>
                    {group.title}
                  </Heading>
                  <Caption>
                    {group.min === 0
                      ? 'По желанию'
                      : `Выберите ${group.min === group.max ? group.min : `${group.min}-${group.max}`}`}{' '}
                    {!radio ? `· выбрано ${total}` : ''}
                  </Caption>
                  {radio && total > 0 ? (
                    <Caption
                      testID={`modifier-selection-${group.id}`}
                      style={s.selectionSummary}
                      accessibilityLiveRegion="polite"
                    >
                      Выбрано: {selectedLabels.join(', ')}
                    </Caption>
                  ) : null}
                </View>
                <View style={s.options}>
                  {radio && group.min === 0 ? (
                    <Pressable
                      testID={`modifier-none-${group.id}`}
                      accessibilityRole="radio"
                      accessibilityLabel={`${group.title}: не добавлять`}
                      aria-checked={total === 0}
                      accessibilityState={{ checked: total === 0 }}
                      onPress={() =>
                        setSelections(
                          selections.filter((selection) => selection.group_id !== group.id),
                        )
                      }
                      style={({ pressed }) => [
                        s.option,
                        total === 0 && s.selected,
                        pressed && ui.pressed,
                      ]}
                    >
                      <Icon
                        name={total === 0 ? 'radio-button-on' : 'radio-button-off'}
                        color={total === 0 ? colors.accent : colors.muted}
                        size={23}
                      />
                      <Body style={s.optionName}>Не добавлять</Body>
                    </Pressable>
                  ) : null}
                  {visible.map((option) => {
                    const selected =
                      selections.find((s) => s.group_id === group.id && s.option_id === option.id)
                        ?.quantity ?? 0;
                    const unavailable = option.available === false;
                    const label = (
                      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                        <Body style={s.optionName}>{option.label}</Body>
                        <Caption>
                          {unavailable
                            ? 'Временно нет'
                            : option.price_delta_minor === '0'
                              ? 'Входит в стоимость'
                              : `+${MinorMoney(option.price_delta_minor)}`}
                        </Caption>
                      </View>
                    );
                    return radio ? (
                      <Pressable
                        key={option.id}
                        testID={`modifier-${group.id}-${option.id}`}
                        accessibilityRole="radio"
                        accessibilityLabel={`${group.title}: ${option.label}, ${unavailable ? 'временно нет' : option.price_delta_minor === '0' ? 'входит в стоимость' : '+' + MinorMoney(option.price_delta_minor)}`}
                        aria-checked={!!selected}
                        accessibilityState={{ checked: !!selected, disabled: unavailable }}
                        disabled={unavailable}
                        onPress={() => select(group, option.id, 1)}
                        style={({ pressed }) => [
                          s.option,
                          fontScale > 1.3 && { flexWrap: 'wrap' },
                          selected > 0 && s.selected,
                          unavailable && { opacity: 0.45 },
                          pressed && ui.pressed,
                        ]}
                      >
                        <Icon
                          name={selected ? 'radio-button-on' : 'radio-button-off'}
                          color={selected ? colors.accent : colors.muted}
                          size={23}
                        />
                        <Body style={[s.optionName, { flex: 1, minWidth: 0 }]}>{option.label}</Body>
                        <Caption
                          style={{ maxWidth: fontScale > 1.3 ? '100%' : 100, textAlign: 'right' }}
                        >
                          {unavailable
                            ? 'Нет'
                            : option.price_delta_minor === '0'
                              ? 'Включено'
                              : `+${MinorMoney(option.price_delta_minor)}`}
                        </Caption>
                      </Pressable>
                    ) : (
                      <View
                        key={option.id}
                        style={[s.option, { flexWrap: 'wrap' }, unavailable && { opacity: 0.45 }]}
                      >
                        {label}
                        <Row style={s.stepper}>
                          <IconButton
                            name="remove"
                            label={`Убрать ${option.label}`}
                            testID={`modifier-minus-${group.id}-${option.id}`}
                            disabled={selected === 0}
                            onPress={() => select(group, option.id, selected - 1)}
                          />
                          <Body
                            testID={`modifier-count-${group.id}-${option.id}`}
                            style={s.quantity}
                          >
                            {selected}
                          </Body>
                          <IconButton
                            name="add"
                            label={`Добавить ${option.label}`}
                            testID={`modifier-plus-${group.id}-${option.id}`}
                            disabled={
                              unavailable ||
                              total >= group.max ||
                              selected >= (option.max_quantity ?? 40)
                            }
                            onPress={() => select(group, option.id, selected + 1)}
                          />
                        </Row>
                      </View>
                    );
                  })}
                </View>
                {group.id === 'drink' && group.options.length > 5 ? (
                  <Button
                    title={
                      expanded[group.id]
                        ? 'Свернуть'
                        : `Показать все варианты (${group.options.length})`
                    }
                    testID={`modifier-expand-${group.id}`}
                    secondary
                    onPress={() => setExpanded({ ...expanded, [group.id]: !expanded[group.id] })}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      </ScrollView>
      <BottomActions safeArea={!props.inTabLayout}>
        {blockedReason ? (
          <Caption
            testID="product-add-reason"
            accessibilityLiveRegion="polite"
            style={{ color: colors.warning }}
          >
            {blockedReason}
          </Caption>
        ) : null}
        <Row style={{ gap: 10, flexWrap: fontScale > 1.4 || width < 360 ? 'wrap' : 'nowrap' }}>
          <Row style={s.stepper}>
            <IconButton
              name="remove"
              label="Уменьшить количество"
              disabled={quantity <= 1}
              onPress={() => setQuantity(quantity - 1)}
            />
            <Body testID="product-quantity" style={s.quantity}>
              {quantity}
            </Body>
            <IconButton
              name="add"
              label="Увеличить количество"
              disabled={quantity >= 20}
              onPress={() => setQuantity(quantity + 1)}
            />
          </Row>
          <Button
            title={`${props.editing ? 'Сохранить' : 'Добавить'} · ${MinorMoney(BigInt(unitPrice) * BigInt(quantity))}`}
            testID="product-add"
            style={{ flex: 1, minWidth: 170 }}
            disabled={!valid}
            onPress={() => {
              if (props.onSave) {
                props.onSave(selections, quantity);
                return;
              }
              props.model.addToCart(product.id, selections, quantity);
              props.navigate('M09');
            }}
          />
        </Row>
      </BottomActions>
    </View>
  );
}
const s = StyleSheet.create({
  close: { position: 'absolute', right: 16, backgroundColor: '#FFFFFFE6', width: 48, height: 48 },
  body: { paddingHorizontal: 18, paddingVertical: 20, gap: 16 },
  title: { fontFamily: font.display, fontSize: 30, lineHeight: 38 },
  description: { fontSize: 14.5, lineHeight: 23 },
  nutrition: {
    borderRadius: 20,
    backgroundColor: colors.surface,
    padding: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  info: { gap: 10, paddingHorizontal: 4 },
  group: { gap: 12, marginTop: 8 },
  groupTitle: { fontSize: 20, lineHeight: 27 },
  options: { gap: 0, borderRadius: 20, overflow: 'hidden', backgroundColor: colors.surface },
  option: {
    minHeight: 66,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 13,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  selected: { backgroundColor: colors.raised },
  selectionSummary: { color: colors.success, fontFamily: font.medium },
  optionName: { fontFamily: font.body, fontSize: 15, lineHeight: 22 },
  stepper: { gap: 0, borderRadius: 22, backgroundColor: colors.raised },
  quantity: {
    minWidth: 20,
    textAlign: 'center',
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
  },
});
