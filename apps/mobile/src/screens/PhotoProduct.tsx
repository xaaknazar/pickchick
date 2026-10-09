import { useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CartLine, ModifierGroup, Product, ScreenProps, Selection } from '../model';
import { defaultSelections, lineUnitPrice, money, validSelections } from '../domain';
import {
  comboSlots,
  isComboProduct,
  setPhotoChoice,
  replaceComboSlot,
  setExtraQuantity,
  recommendedExtras,
  comboCompanions,
  photoCartLimit,
} from '../product-photo-selection';
import { optionPhotos, extraPhotos } from '../product-photo-assets';
import { ProductPhoto, productPhoto } from '../components/ProductPhoto';
import { MotionModal, MotionPressable as Pressable, useReducedMotion } from '../components/Motion';
import { CloseButton, Icon, Row } from '../components/UI';
import { colors, font } from '../theme';

type Props = ScreenProps & {
  product: Product;
  editing?: CartLine;
  onSave?(selections: Selection[], quantity: number): void;
};
type Picker = { group: ModifierGroup; index: number; chosen: string | null };
const ink = '#271C15';
const paper = '#FFF8EE';
const priceButton = { surface: colors.accent, ink: colors.orangeInk };
const gradient = 'linear-gradient(180deg, rgba(255,248,238,0) 0%, #FFF8EE 100%)';
const blueGradient =
  'linear-gradient(180deg, rgba(0,71,187,0) 0%, rgba(6,51,126,0.4) 45%, #06337E 100%)';
const blueBlend = (
  Platform.OS === 'web'
    ? { backgroundImage: blueGradient }
    : { experimental_backgroundImage: blueGradient }
) as ViewStyle;
const blend = (
  Platform.OS === 'web' ? { backgroundImage: gradient } : { experimental_backgroundImage: gradient }
) as ViewStyle;

export function PhotoProduct(props: Props) {
  const { product } = props;
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const reduced = useReducedMotion();
  const scroll = useRef<ScrollView>(null);
  const choicesY = useRef(0);
  const [selections, setSelections] = useState<Selection[]>(
    () => props.editing?.selections ?? defaultSelections(product),
  );
  const [quantity, setQuantity] = useState(props.editing?.quantity ?? 1);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const afterPickerDismiss = useRef<(() => void) | null>(null);
  const [info, setInfo] = useState(false);
  const [footerHeight, setFooterHeight] = useState(110);
  const [companionCounts, setCompanionCounts] = useState<Record<string, number>>({});
  const combo = isComboProduct(product.id);
  const blue = combo;
  const s = blue ? blueStyles : warmStyles;
  const pageInk = blue ? '#FFFFFF' : ink;
  const pagePaper = blue ? '#0047BB' : paper;
  const heroHeight = Math.min(width, height * 0.61, 600);
  const pageGradient = `linear-gradient(180deg, #0047BB 0px, #0047BB ${heroHeight - 150}px, #06337E ${heroHeight}px, #08265A ${heroHeight + 300}px, #04143A 100%)`;
  const gradientSurface = (
    Platform.OS === 'web'
      ? { backgroundImage: pageGradient }
      : { experimental_backgroundImage: pageGradient }
  ) as ViewStyle;
  const extraWidth = Math.min(160, Math.max(144, width * 0.39));
  const title = product.name.replace(/,?\s*1 шт\.?$/, '');
  const columns = fontScale > 1.3 || width < 375 ? 2 : 3;
  const optionWidth = (Math.min(width, 768) - 24 - (columns - 1) * 8) / columns;
  const drinkPhotoSize = Math.min(180, optionWidth - 16);
  const unit = lineUnitPrice({ product, selections });
  const companions = comboCompanions(product.id, props.model.products);
  const companionLines = (counts = companionCounts): CartLine[] =>
    companions
      .filter((line) => (counts[line.product.id] ?? 0) > 0)
      .map((line) => ({ ...line, quantity: (counts[line.product.id] ?? 0) * quantity }));
  const selectedCompanions = companionLines();
  const totalPrice = (
    BigInt(unit) * BigInt(quantity) +
    selectedCompanions.reduce(
      (sum, line) => sum + BigInt(lineUnitPrice(line)) * BigInt(line.quantity),
      0n,
    )
  ).toString();
  const reasonFor = (choices: Selection[]) =>
    (product.available === false ? 'Сейчас нет в наличии' : null) ??
    photoCartLimit(
      props.model.cart,
      { product, selections: choices, quantity },
      props.editing,
      selectedCompanions,
    ) ??
    (!validSelections(product, choices)
      ? 'Завершите выбор состава и доступных вариантов.'
      : null) ??
    (Object.entries(companionCounts).some(
      ([id, count]) => count > 0 && !companions.some((line) => line.product.id === id),
    )
      ? 'Одно из дополнений сейчас недоступно. Откройте блюдо заново.'
      : null);
  const reason = reasonFor(selections);
  const replacement = picker?.chosen
    ? replaceComboSlot(selections, picker.group, picker.index, picker.chosen)
    : null;
  const replacementReason = props.editing && replacement ? reasonFor(replacement) : null;
  const save = (choices: Selection[]) => {
    if (reasonFor(choices)) return;
    if (props.onSave) props.onSave(choices, quantity);
    else props.model.addToCart(product.id, choices, quantity);
    for (const line of selectedCompanions)
      props.model.addToCart(line.product.id, line.selections, line.quantity);
    if (!props.onSave) props.goBack();
  };
  const companionCard = (line: CartLine) => {
    const id = line.product.id;
    const count = companionCounts[id] ?? 0;
    const label = id === 'sauce' ? 'Фирменный соус, 300 мл' : 'Бургер';
    return (
      <View
        key={id}
        testID={`photo-extra-${id === 'sauce' ? 'large-sauce' : id}`}
        style={[s.extraCard, { width: extraWidth }, count > 0 && s.extraSelected]}
      >
        <ProductPhoto
          photo={productPhoto(line.product, 'card', 'hero')}
          contentFit="contain"
          style={{
            width: extraWidth - 24,
            height: 104,
            borderRadius: 12,
            backgroundColor: '#FFFFFF',
          }}
          accessible={false}
        />
        <Text style={s.extraName}>{label}</Text>
        <Text style={s.choiceLabel}>+{money(lineUnitPrice(line))}</Text>
        <View style={s.extraControls}>
          <Counter
            blue={blue}
            value={count}
            name={label}
            minus={() =>
              setCompanionCounts((current) => ({
                ...current,
                [id]: Math.max(0, (current[id] ?? 0) - 1),
              }))
            }
            plus={() =>
              setCompanionCounts((current) => ({
                ...current,
                [id]: Math.min(20, (current[id] ?? 0) + 1),
              }))
            }
            minusDisabled={!count}
            plusDisabled={
              !!photoCartLimit(
                props.model.cart,
                { product, selections, quantity },
                props.editing,
                companionLines({ ...companionCounts, [id]: count + 1 }),
              )
            }
          />
        </View>
      </View>
    );
  };
  const groups = (product.modifierGroups ?? []).filter(
    (g) => ['drink', 'sauce'].includes(g.id) && g.min <= 4,
  );
  const otherGroups = (product.modifierGroups ?? []).filter(
    (g) => g.id !== 'extras' && !groups.includes(g),
  );
  const extras = product.modifierGroups?.find((g) => g.id === 'extras');
  const sizeGroup = product.modifierGroups?.find((g) => g.id === 'size');
  const chosenSize = sizeGroup?.options.find((o) =>
    selections.some((v) => v.group_id === sizeGroup.id && v.option_id === o.id),
  );
  const servingLabel = chosenSize?.label ?? product.servingLabel;
  const resolvedHero = productPhoto(product, 'hero', 'hero');
  // The seed sauce hero shows the small bottle while the included size is chosen.
  const hero =
    resolvedHero.kind === 'id' &&
    product.id === 'sauce' &&
    chosenSize?.price_delta_minor === '0' &&
    optionPhotos.pick
      ? { kind: 'id' as const, source: optionPhotos.pick }
      : resolvedHero;
  const nutritionMultiplier =
    product.nutrition?.basis === 'per_serving' ? (chosenSize?.nutrition_multiplier ?? 1) : 1;
  const infoContent = (
    <View style={s.infoCopy}>
      <Text style={s.modalMuted}>
        {servingLabel} ·{' '}
        {product.nutrition?.basis === 'per_100_g' ? 'На 100 г' : 'На выбранную порцию'}
      </Text>
      {product.nutrition ? (
        <View style={s.nutritionGrid}>
          {[
            [product.nutrition.energy_kcal, 'ккал'],
            [product.nutrition.protein_g, 'Белки, г'],
            [product.nutrition.fat_g, 'Жиры, г'],
            [product.nutrition.carbs_g, 'Углеводы, г'],
          ].map(([value, label]) => (
            <View key={String(label)} style={s.nutrient}>
              <Text style={s.nutrientValue}>
                {typeof value === 'number'
                  ? Math.round(value * nutritionMultiplier * 10) / 10
                  : value}
              </Text>
              <Text style={s.modalMuted}>{label}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={s.modalMuted}>Данные уточняются.</Text>
      )}
      <Text style={s.modalMuted}>Без учёта дополнительных опций.</Text>
      <Text style={s.modalMuted}>
        {product.allergens?.length
          ? `Аллергены: ${product.allergens.join(', ')}`
          : 'Уточните аллергены у сотрудников ресторана.'}
      </Text>
    </View>
  );
  return (
    <View style={s.page} testID={`photo-product-${product.id}`}>
      <StatusBar style={pickerVisible || info || blue ? 'light' : 'dark'} />
      <View
        style={{ flex: 1 }}
        aria-hidden={pickerVisible || info}
        accessibilityElementsHidden={pickerVisible || info}
        importantForAccessibility={pickerVisible || info ? 'no-hide-descendants' : 'auto'}
      >
        <ScrollView
          ref={scroll}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            { paddingBottom: footerHeight + 24, flexGrow: 1 },
            blue && gradientSurface,
          ]}
          testID="photo-product-scroll"
        >
          <View style={{ height: heroHeight, backgroundColor: pagePaper }}>
            {hero ? (
              <ProductPhoto
                photo={hero}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
                accessibilityLabel={title}
              />
            ) : (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  { alignItems: 'center', justifyContent: 'center', gap: 12 },
                ]}
              >
                <Icon name="image-outline" color="#65594F" size={48} />
                <Text style={s.noPhoto}>Фото скоро</Text>
              </View>
            )}
            <View pointerEvents="none" style={[s.blend, blue ? blueBlend : blend]} />
            {combo ? (
              <Pressable
                style={s.photoAction}
                accessibilityRole="button"
                testID="photo-configure"
                onPress={() =>
                  scroll.current?.scrollTo({ y: choicesY.current, animated: !reduced })
                }
              >
                <Icon name="options-outline" color="#8A3309" size={20} />
                <Text style={s.photoActionText}>Настроить комбо</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={s.intro}>
            <Text style={s.title} testID="photo-product-title">
              {title}
            </Text>
            <Text style={s.description}>{product.description}</Text>
            <View style={s.productMeta}>
              <Text style={s.serving}>
                {servingLabel}
                {product.category === 'На двоих' ? ' · На двоих' : ''}
              </Text>
              <Pressable
                accessibilityRole="button"
                testID="photo-nutrition-open"
                style={s.nutritionTrigger}
                onPress={() => setInfo(true)}
              >
                <Icon name="information-circle-outline" color={pageInk} size={16} />
                <Text style={s.nutritionLabel}>Пищевая ценность</Text>
              </Pressable>
            </View>
          </View>
          <View
            style={s.choices}
            onLayout={(e) => {
              choicesY.current = e.nativeEvent.layout.y;
            }}
          >
            {combo ? (
              <View style={{ gap: 6 }}>
                <Text style={s.sectionTitle}>Ваше комбо</Text>
                <Text style={s.choiceLabel}>
                  {groups.length
                    ? 'Включённые позиции уже выбраны. Можно заменить каждую отдельно.'
                    : 'Настройте состав под себя.'}
                </Text>
              </View>
            ) : null}
            {otherGroups.map((group) => {
              const total = selections
                .filter((v) => v.group_id === group.id)
                .reduce((n, v) => n + v.quantity, 0);
              return (
                <View key={group.id} style={{ gap: 10 }}>
                  <Text style={s.sectionTitle}>{group.title}</Text>
                  {group.max > 1 ? (
                    <Text style={s.choiceLabel}>
                      Выбрано {total} из {group.max}
                    </Text>
                  ) : null}
                  {group.options.map((option) => {
                    const count =
                      selections.find((v) => v.group_id === group.id && v.option_id === option.id)
                        ?.quantity ?? 0;
                    const change = (delta: number) =>
                      setSelections((current) => {
                        const previous =
                          current.find((v) => v.group_id === group.id && v.option_id === option.id)
                            ?.quantity ?? 0;
                        return setPhotoChoice(
                          current,
                          group,
                          option.id,
                          group.max === 1 ? 1 : previous + delta,
                        );
                      });
                    return group.max === 1 ? (
                      <Pressable
                        key={option.id}
                        accessibilityRole="radio"
                        aria-checked={count > 0}
                        accessibilityState={{
                          checked: count > 0,
                          disabled: option.available === false,
                        }}
                        disabled={option.available === false}
                        onPress={() => change(1)}
                        testID={`photo-choice-${group.id}-${option.id}`}
                        style={[s.choice, count > 0 && s.variantSelected]}
                      >
                        <View style={{ flex: 1, gap: 4 }}>
                          <Text style={s.choiceName}>{option.label}</Text>
                          <Text style={s.choiceLabel}>
                            {option.available === false
                              ? 'Временно нет'
                              : option.price_delta_minor === '0'
                                ? 'Включено'
                                : `+${money(option.price_delta_minor)}`}
                          </Text>
                        </View>
                        <Icon
                          name={count ? 'radio-button-on' : 'radio-button-off'}
                          color={blue ? colors.accent : '#9A3F00'}
                          size={24}
                        />
                      </Pressable>
                    ) : (
                      <View key={option.id} style={[s.choice, { flexWrap: 'wrap' }]}>
                        <OptionImage id={option.id} size={54} />
                        <View style={{ flex: 1 }}>
                          <Text style={s.choiceName}>{option.label}</Text>
                          <Text style={s.choiceLabel}>
                            {option.available === false ? 'Временно нет' : 'Включено'}
                          </Text>
                        </View>
                        <View
                          style={
                            width < 375 || fontScale > 1.3
                              ? { width: '100%', alignItems: 'flex-end' }
                              : undefined
                          }
                        >
                          <Counter
                            blue={blue}
                            value={count}
                            name={option.label}
                            minus={() => change(-1)}
                            plus={() => change(1)}
                            minusDisabled={!count}
                            plusDisabled={
                              option.available === false ||
                              total >= group.max ||
                              count >= (option.max_quantity ?? group.max)
                            }
                          />
                        </View>
                      </View>
                    );
                  })}
                </View>
              );
            })}
            {groups.flatMap((group) =>
              comboSlots(group, selections).map((optionId, index) => {
                const option = group.options.find((o) => o.id === optionId);
                return (
                  <Pressable
                    key={`${group.id}-${index}`}
                    style={s.choice}
                    accessibilityRole="button"
                    accessibilityLabel={`Заменить ${group.id === 'drink' ? 'напиток' : 'соус'} ${index + 1}: ${option?.label ?? 'не выбран'}`}
                    testID={`photo-replace-${group.id}-${index}`}
                    onPress={() => {
                      setPicker({ group, index, chosen: optionId });
                      setPickerVisible(true);
                    }}
                  >
                    <OptionImage id={optionId} size={82} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={s.choiceLabel}>
                        {group.id === 'drink' ? 'Напиток' : 'Соус'} {index + 1} из {group.min}
                      </Text>
                      <Text style={s.choiceName}>{option?.label ?? 'Выберите'}</Text>
                      {option ? (
                        <Text style={s.choiceLabel}>
                          {option.price_delta_minor === '0'
                            ? 'Входит в комбо'
                            : `Доплата +${money(option.price_delta_minor)}`}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={s.replace}>Заменить</Text>
                  </Pressable>
                );
              }),
            )}
          </View>
          {extras ? (
            <View style={s.extrasSection}>
              <Text style={[s.sectionTitle, { paddingHorizontal: 20 }]}>Добавить к комбо</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                directionalLockEnabled
                nestedScrollEnabled
                decelerationRate="fast"
                snapToInterval={extraWidth + 12}
                snapToAlignment="start"
                contentContainerStyle={s.extrasTrack}
                testID="photo-extras-track"
                accessibilityLabel="Дополнения к комбо, горизонтальный список"
              >
                {companions.filter((line) => line.product.id === 'burger').map(companionCard)}
                {recommendedExtras(extras, selections).map((option) => {
                  const count =
                    selections.find((v) => v.group_id === extras.id && v.option_id === option.id)
                      ?.quantity ?? 0;
                  const total = selections
                    .filter((v) => v.group_id === extras.id)
                    .reduce((n, v) => n + v.quantity, 0);
                  const unavailable = option.available === false;
                  const change = (delta: number) =>
                    setSelections((current) => {
                      const previous =
                        current.find((v) => v.group_id === extras.id && v.option_id === option.id)
                          ?.quantity ?? 0;
                      return setExtraQuantity(current, extras, option.id, previous + delta);
                    });
                  return (
                    <View
                      key={option.id}
                      testID={`photo-extra-${option.id}`}
                      style={[s.extraCard, { width: extraWidth }, count > 0 && s.extraSelected]}
                    >
                      <OptionImage id={option.id} size={extraWidth - 24} height={104} extra />
                      <Text style={s.extraName}>{option.label}</Text>
                      <Text style={s.choiceLabel}>
                        {unavailable ? 'Временно нет' : `+${money(option.price_delta_minor)}`}
                      </Text>
                      <View style={s.extraControls}>
                        <Counter
                          blue={blue}
                          value={count}
                          name={option.label}
                          minus={() => change(-1)}
                          plus={() => change(1)}
                          minusDisabled={!count}
                          plusDisabled={
                            unavailable ||
                            count >= (option.max_quantity ?? extras.max) ||
                            total >= extras.max
                          }
                        />
                      </View>
                    </View>
                  );
                })}
                {companions.filter((line) => line.product.id !== 'burger').map(companionCard)}
              </ScrollView>
            </View>
          ) : null}
          <View style={s.choices}>
            <View style={s.moreRow}>
              <Text style={s.choiceName}>Количество</Text>
              <Counter
                blue={blue}
                value={quantity}
                minus={() => setQuantity(quantity - 1)}
                plus={() => setQuantity(quantity + 1)}
                minusDisabled={quantity <= 1}
                plusDisabled={quantity >= 20}
                name={product.name}
              />
            </View>
          </View>
        </ScrollView>
        <View
          pointerEvents="box-none"
          onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
          style={[s.footer, { paddingBottom: Math.max(16, insets.bottom) }]}
        >
          {reason ? (
            <Text accessibilityLiveRegion="polite" style={s.reason}>
              {reason}
            </Text>
          ) : null}
          <Pressable
            testID="product-add"
            accessibilityRole="button"
            accessibilityLabel={`${props.editing ? 'Сохранить' : 'Добавить в корзину'}: ${money(totalPrice)}`}
            accessibilityState={{ disabled: !!reason }}
            disabled={!!reason}
            style={[s.add, s.priceAction, !!reason && { opacity: 0.5 }]}
            onPress={() => save(selections)}
          >
            <Icon name={props.editing ? 'checkmark' : 'add'} color={priceButton.ink} size={27} />
            <Text style={[s.addText, { color: priceButton.ink }]}>{money(totalPrice)}</Text>
          </Pressable>
        </View>
        <CloseButton
          testID="product-close"
          label="Закрыть блюдо"
          onPress={props.goBack}
          style={[s.close, { top: Math.max(0, insets.top - 16), left: 16 }]}
        />
      </View>
      <MotionModal
        visible={pickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerVisible(false)}
        onDismiss={() => {
          const complete = afterPickerDismiss.current;
          afterPickerDismiss.current = null;
          complete?.();
        }}
      >
        {/* Keep the outgoing content mounted until the native dismissal finishes. */}
        {picker ? (
          <View
            style={[s.modal, { paddingTop: insets.top }]}
            accessibilityViewIsModal
            testID="photo-replacement-dialog"
          >
            <Row style={s.modalHeader}>
              <CloseButton
                label="Закрыть замену без сохранения"
                onPress={() => setPickerVisible(false)}
              />
              <Text style={s.modalTitle}>
                {picker.group.id === 'drink' ? 'Напиток' : 'Соус'} {picker.index + 1} из{' '}
                {picker.group.min}
              </Text>
            </Row>
            <ScrollView contentContainerStyle={s.grid} showsVerticalScrollIndicator={false}>
              {picker.group.options.map((option) => {
                const chosen = option.id === picker.chosen;
                const possible = replaceComboSlot(
                  selections,
                  picker.group,
                  picker.index,
                  option.id,
                );
                const unavailable =
                  option.available === false ||
                  comboSlots(picker.group, possible)[picker.index] !== option.id;
                return (
                  <Pressable
                    key={option.id}
                    testID={`photo-option-${option.id}`}
                    accessibilityRole="radio"
                    accessibilityLabel={`${option.label}, ${option.price_delta_minor === '0' ? 'без доплаты' : '+' + money(option.price_delta_minor)}`}
                    accessibilityState={{ checked: chosen, disabled: unavailable }}
                    aria-checked={chosen}
                    disabled={unavailable}
                    onPress={() => setPicker({ ...picker, chosen: option.id })}
                    style={[
                      s.tile,
                      { width: optionWidth },
                      chosen && s.tileSelected,
                      unavailable && { opacity: 0.4 },
                    ]}
                  >
                    <OptionImage id={option.id} size={drinkPhotoSize} />
                    <Text style={[s.tileName, chosen && { color: colors.orangeInk }]}>
                      {option.label}
                    </Text>
                    <Text style={[s.tilePrice, chosen && { color: colors.orangeInk }]}>
                      {unavailable
                        ? 'Временно нет'
                        : option.price_delta_minor === '0' && chosen
                          ? 'В комбо'
                          : `+${money(option.price_delta_minor)}`}
                    </Text>
                    {chosen ? (
                      <View style={s.check}>
                        <Icon name="checkmark-circle" color={colors.orangeInk} size={23} />
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={[s.modalFooter, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              {replacement ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={{ fontFamily: font.medium, color: colors.text, textAlign: 'center' }}
                >
                  Комбо с выбором ·{' '}
                  {money(
                    (
                      BigInt(lineUnitPrice({ product, selections: replacement })) *
                        BigInt(quantity) +
                      selectedCompanions.reduce(
                        (sum, line) => sum + BigInt(lineUnitPrice(line)) * BigInt(line.quantity),
                        0n,
                      )
                    ).toString(),
                  )}
                </Text>
              ) : null}
              {replacementReason ? (
                <Text accessibilityLiveRegion="polite" style={s.reason}>
                  {replacementReason}
                </Text>
              ) : null}
              <Pressable
                testID="photo-replacement-apply"
                accessibilityRole="button"
                disabled={!replacement || !!replacementReason}
                accessibilityState={{ disabled: !replacement || !!replacementReason }}
                style={[s.add, (!replacement || !!replacementReason) && { opacity: 0.5 }]}
                onPress={() => {
                  if (!replacement || replacementReason) return;
                  setSelections(replacement);
                  setPickerVisible(false);
                  // iOS must dismiss its modal before saving unmounts the editor.
                  if (props.editing && props.onSave) {
                    if (Platform.OS === 'ios') afterPickerDismiss.current = () => save(replacement);
                    else save(replacement);
                  }
                }}
              >
                <Text style={s.addText}>Готово</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </MotionModal>
      <MotionModal
        visible={info}
        transparent
        animationType="slide"
        onRequestClose={() => setInfo(false)}
      >
        <View style={[s.nutritionOverlay, { paddingTop: insets.top + 16 }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel="Закрыть пищевую ценность"
            onPress={() => setInfo(false)}
          />
          <View
            style={[s.nutritionWindow, { paddingBottom: Math.max(insets.bottom, 16) }]}
            role="dialog"
            aria-modal
            accessibilityViewIsModal
            accessibilityLabel="Пищевая ценность"
            testID="photo-nutrition-dialog"
          >
            <Row style={s.modalHeader}>
              <CloseButton label="Закрыть окно пищевой ценности" onPress={() => setInfo(false)} />
              <Text style={s.modalTitle}>Пищевая ценность</Text>
            </Row>
            <ScrollView>{infoContent}</ScrollView>
          </View>
        </View>
      </MotionModal>
    </View>
  );
}
function OptionImage({
  id,
  size,
  extra = false,
  height,
}: {
  id: string | null;
  size: number;
  extra?: boolean;
  height?: number;
}) {
  const s = warmStyles;
  const source = id ? (extra ? extraPhotos[id] : optionPhotos[id]) : undefined;
  return (
    <View style={[s.optionPhoto, { width: size, height: height ?? size }]}>
      {source ? (
        <Image
          source={source}
          contentFit="contain"
          style={StyleSheet.absoluteFill}
          accessible={false}
        />
      ) : (
        <>
          <Icon name="image-outline" color="#65594F" size={24} />
          <Text style={s.noPhoto}>Фото скоро</Text>
        </>
      )}
    </View>
  );
}
function Counter({
  blue = false,
  value,
  minus,
  plus,
  minusDisabled,
  plusDisabled,
  name,
}: {
  blue?: boolean;
  value: number;
  minus(): void;
  plus(): void;
  minusDisabled: boolean;
  plusDisabled: boolean;
  name: string;
}) {
  const s = blue ? blueStyles : warmStyles;
  const counterInk = blue ? '#FFFFFF' : ink;
  return (
    <Row style={s.counter}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Уменьшить: ${name}`}
        disabled={minusDisabled}
        accessibilityState={{ disabled: minusDisabled }}
        style={[s.countButton, minusDisabled && { opacity: 0.35 }]}
        onPress={minus}
      >
        <Icon name="remove" color={counterInk} />
      </Pressable>
      <Text style={s.count}>{value}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Увеличить: ${name}`}
        disabled={plusDisabled}
        accessibilityState={{ disabled: plusDisabled }}
        style={[s.countButton, plusDisabled && { opacity: 0.35 }]}
        onPress={plus}
      >
        <Icon name="add" color={counterInk} />
      </Pressable>
    </Row>
  );
}
function makeStyles(blue: boolean) {
  const ink = blue ? '#FFFFFF' : '#271C15';
  const paper = blue ? '#0047BB' : '#FFF8EE';
  const muted = blue ? '#D4E5FF' : '#594635';
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: blue ? '#04143A' : paper },
    blend: { position: 'absolute', bottom: -1, left: 0, right: 0, height: 150 },
    close: { position: 'absolute' },
    photoAction: {
      position: 'absolute',
      bottom: 22,
      right: 20,
      backgroundColor: '#FFE2C3',
      borderRadius: 28,
      paddingHorizontal: 18,
      paddingVertical: 14,
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
      minHeight: 48,
    },
    photoActionText: { fontFamily: font.bold, fontSize: 14, color: '#8A3309' },
    intro: {
      paddingHorizontal: 24,
      paddingTop: 6,
      paddingBottom: 24,
      gap: 10,
      alignItems: 'center',
    },
    title: {
      fontFamily: font.display,
      fontSize: 34,
      lineHeight: 41,
      color: ink,
      textAlign: 'center',
    },
    description: {
      fontFamily: font.body,
      fontSize: 15,
      lineHeight: 23,
      color: ink,
      textAlign: 'center',
      maxWidth: 560,
    },
    serving: { fontFamily: font.medium, fontSize: 13, color: muted },
    choices: { paddingHorizontal: 20, gap: 10, maxWidth: 680, width: '100%', alignSelf: 'center' },
    sectionTitle: { fontFamily: font.heading, fontSize: 21, lineHeight: 28, color: ink },
    choice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: blue ? '#073987' : '#EADBC5',
      padding: 12,
      borderRadius: 16,
    },
    choiceLabel: { fontFamily: font.body, fontSize: 12, lineHeight: 18, color: muted },
    choiceName: { fontFamily: font.medium, fontSize: 14, lineHeight: 21, color: ink },
    replace: { fontFamily: font.bold, fontSize: 12, color: blue ? '#FF8A4C' : '#A33B00' },
    moreRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      minHeight: 60,
      paddingVertical: 10,
    },
    productMeta: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      alignItems: 'center',
      columnGap: 12,
    },
    nutritionLabel: { fontFamily: font.medium, fontSize: 12, lineHeight: 18, color: ink },
    extrasSection: { gap: 14, marginTop: 24 },
    extrasTrack: { gap: 12, paddingHorizontal: 20, paddingBottom: 4 },
    extraCard: {
      padding: 10,
      gap: 6,
      borderRadius: 16,
      backgroundColor: blue ? '#0C2B5D' : '#EADBC5',
      borderWidth: 1,
      borderColor: 'transparent',
    },
    extraSelected: { borderColor: colors.accent },
    variantSelected: { borderWidth: 1, borderColor: blue ? colors.accent : '#9A3F00' },
    extraControls: { alignItems: 'center', marginTop: 'auto', paddingTop: 4 },
    extraName: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, color: ink },
    priceAction: { backgroundColor: priceButton.surface },
    footer: {
      paddingTop: 12,
      paddingHorizontal: 24,
      backgroundColor: 'transparent',
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      gap: 8,
    },
    add: {
      minHeight: 56,
      borderRadius: 30,
      backgroundColor: colors.accent,
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingVertical: 14,
      width: '100%',
      maxWidth: 540,
      alignSelf: 'center',
    },
    addText: { fontFamily: font.bold, fontSize: 20, lineHeight: 28, color: colors.orangeInk },
    reason: { fontFamily: font.medium, color: ink, fontSize: 13, textAlign: 'center' },
    counter: { backgroundColor: blue ? '#133668' : '#F2DFC7', borderRadius: 25, gap: 0 },
    countButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
    count: { fontFamily: font.bold, fontSize: 15, minWidth: 18, textAlign: 'center', color: ink },
    modal: { flex: 1, backgroundColor: colors.background },
    modalHeader: { paddingHorizontal: 16, paddingVertical: 14, gap: 14 },
    modalTitle: {
      fontFamily: font.heading,
      fontSize: 22,
      lineHeight: 28,
      color: colors.text,
      flex: 1,
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      paddingHorizontal: 12,
      paddingBottom: 20,
      alignItems: 'stretch',
      maxWidth: 768,
      alignSelf: 'center',
      width: '100%',
    },
    tile: {
      borderRadius: 22,
      backgroundColor: colors.surface,
      paddingHorizontal: 8,
      paddingVertical: 16,
      gap: 12,
      alignItems: 'center',
      minHeight: 260,
    },
    tileSelected: { backgroundColor: colors.accent },
    tileName: {
      fontFamily: font.medium,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
      color: colors.text,
    },
    tilePrice: {
      fontFamily: font.bold,
      fontSize: 14,
      lineHeight: 20,
      textAlign: 'center',
      color: colors.text,
      marginTop: 'auto',
      paddingTop: 8,
    },
    check: { position: 'absolute', top: 7, right: 7 },
    optionPhoto: {
      backgroundColor: '#FFFFFF',
      borderRadius: 12,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      maxWidth: '100%',
    },
    noPhoto: { fontFamily: font.body, fontSize: 10, color: '#65594F' },
    modalFooter: { paddingHorizontal: 24, paddingTop: 12 },
    nutritionTrigger: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      paddingHorizontal: 4,
      minHeight: 48,
    },
    nutritionOverlay: { flex: 1, backgroundColor: '#00000080', justifyContent: 'flex-end' },
    nutritionWindow: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      maxHeight: '82%',
      width: '100%',
      maxWidth: 600,
      alignSelf: 'center',
    },
    nutritionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    nutrient: {
      flexGrow: 1,
      flexBasis: '42%',
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      gap: 4,
    },
    nutrientValue: { fontFamily: font.display, fontSize: 30, lineHeight: 38, color: colors.text },
    infoCopy: { padding: 24, gap: 18 },
    modalMuted: { fontFamily: font.body, fontSize: 14, lineHeight: 22, color: colors.muted },
  });
}
const warmStyles = makeStyles(false);
const blueStyles = makeStyles(true);
