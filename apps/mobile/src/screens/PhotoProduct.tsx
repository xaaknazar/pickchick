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
import { cartLineKey, defaultSelections, lineUnitPrice, money, validSelections } from '../domain';
import { comboSlots, replaceComboSlot } from '../product-photo-selection';
import { optionPhotos, photoHeroes } from '../product-photo-assets';
import { MotionModal, MotionPressable as Pressable, useReducedMotion } from '../components/Motion';
import { Icon, Row } from '../components/UI';
import { colors, font } from '../theme';

type Props = ScreenProps & {
  product: Product;
  editing?: CartLine;
  onSave?(selections: Selection[], quantity: number): void;
};
type Picker = { group: ModifierGroup; index: number; chosen: string | null };
const ink = '#271C15';
const paper = '#D8C5A7';
const gradient = 'linear-gradient(180deg, rgba(216,197,167,0) 0%, #D8C5A7 100%)';
const blueGradient = 'linear-gradient(180deg, rgba(0,71,187,0) 0%, #0047BB 100%)';
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
  const [info, setInfo] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const blue = product.id === 'burger-duo';
  const combo = product.id === 'finger-duo' || blue;
  const s = blue ? blueStyles : warmStyles;
  const pageInk = blue ? '#FFFFFF' : ink;
  const pagePaper = blue ? '#0047BB' : paper;
  const title = product.id === 'burger' ? 'Бургер' : product.name;
  const columns = fontScale > 1.3 || width < 375 ? 2 : 3;
  const optionWidth = (Math.min(width, 768) - 24 - (columns - 1) * 8) / columns;
  const drinkPhotoSize = Math.min(180, optionWidth - 16);
  const unit = lineUnitPrice({ product, selections });
  const candidateKey = cartLineKey({ product, selections });
  const existing = props.model.cart.find(
    (line) =>
      cartLineKey(line) === candidateKey &&
      (!props.editing || cartLineKey(line) !== cartLineKey(props.editing)),
  );
  const full = !props.editing && !existing && props.model.cart.length >= 11;
  const reason = full
    ? 'В корзине уже 11 разных позиций.'
    : (existing?.quantity ?? 0) + quantity > 20
      ? 'Можно добавить до 20 одинаковых позиций.'
      : !validSelections(product, selections)
        ? 'Выберите доступные напитки и соусы.'
        : null;
  const groups = (product.modifierGroups ?? []).filter((g) => ['drink', 'sauce'].includes(g.id));
  const extras = product.modifierGroups?.find((g) => g.id === 'extras');
  const infoContent = (
    <View style={s.infoCopy}>
      <Text style={s.modalMuted}>
        {product.servingLabel} ·{' '}
        {product.nutrition?.basis === 'per_100_g' ? 'На 100 г' : 'На базовую порцию'}
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
              <Text style={s.nutrientValue}>{value}</Text>
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
      <StatusBar style={picker || info || blue ? 'light' : 'dark'} />
      <View
        style={{ flex: 1 }}
        aria-hidden={!!picker || info}
        accessibilityElementsHidden={!!picker || info}
        importantForAccessibility={picker || info ? 'no-hide-descendants' : 'auto'}
      >
        <ScrollView
          ref={scroll}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 24 }}
          testID="photo-product-scroll"
        >
          <View style={{ height: Math.min(width, height * 0.61, 600), backgroundColor: pagePaper }}>
            <Image
              source={photoHeroes[product.id] ?? product.image}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              accessibilityLabel={title}
            />
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
                <Icon name="options-outline" color={ink} size={20} />
                <Text style={s.photoActionText}>Настроить комбо</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={s.intro}>
            <Text style={s.title} testID="photo-product-title">
              {title}
            </Text>
            <Text style={s.description}>{product.description}</Text>
            <Text style={s.serving}>
              {product.servingLabel}
              {combo ? ' · На двоих' : ''}
            </Text>
          </View>
          <View
            style={s.choices}
            onLayout={(e) => {
              choicesY.current = e.nativeEvent.layout.y;
            }}
          >
            {combo ? <Text style={s.sectionTitle}>Соберите своё комбо</Text> : null}
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
                    onPress={() => setPicker({ group, index, chosen: optionId })}
                  >
                    <OptionImage id={optionId} size={82} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={s.choiceLabel}>
                        {group.id === 'drink' ? 'Напиток' : 'Соус'} {index + 1}
                      </Text>
                      <Text style={s.choiceName}>{option?.label ?? 'Выберите'}</Text>
                      {option && option.price_delta_minor !== '0' ? (
                        <Text style={s.choiceLabel}>+{money(option.price_delta_minor)}</Text>
                      ) : null}
                    </View>
                    <Text style={s.replace}>Заменить</Text>
                  </Pressable>
                );
              }),
            )}
            {extras ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: extrasOpen }}
                  style={s.moreRow}
                  onPress={() => setExtrasOpen(!extrasOpen)}
                >
                  <Text style={s.sectionTitle}>Добавить к комбо</Text>
                  <Icon name={extrasOpen ? 'remove' : 'add'} color={pageInk} />
                </Pressable>
                {extrasOpen
                  ? extras.options.map((option) => {
                      const count =
                        selections.find(
                          (v) => v.group_id === extras.id && v.option_id === option.id,
                        )?.quantity ?? 0;
                      const total = selections
                        .filter((v) => v.group_id === extras.id)
                        .reduce((n, v) => n + v.quantity, 0);
                      const change = (n: number) =>
                        setSelections([
                          ...selections.filter(
                            (v) => !(v.group_id === extras.id && v.option_id === option.id),
                          ),
                          ...(n
                            ? [{ group_id: extras.id, option_id: option.id, quantity: n }]
                            : []),
                        ]);
                      return (
                        <View key={option.id} style={s.extra}>
                          <View style={{ flex: 1, gap: 4 }}>
                            <Text style={s.choiceName}>{option.label}</Text>
                            <Text style={s.choiceLabel}>
                              {option.available === false
                                ? 'Временно нет'
                                : `+${money(option.price_delta_minor)}`}
                            </Text>
                          </View>
                          <Counter
                            blue={blue}
                            value={count}
                            minus={() => change(count - 1)}
                            plus={() => change(count + 1)}
                            minusDisabled={!count}
                            plusDisabled={
                              option.available === false ||
                              count >= (option.max_quantity ?? 40) ||
                              total >= extras.max
                            }
                            name={option.label}
                          />
                        </View>
                      );
                    })
                  : null}
              </>
            ) : null}
            <Pressable
              accessibilityRole="button"
              testID="photo-nutrition-open"
              style={s.nutritionTrigger}
              onPress={() => setInfo(true)}
            >
              <Icon name="information-circle-outline" color={pageInk} />
              <Text style={s.choiceName}>Пищевая ценность</Text>
            </Pressable>
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
        <View style={[s.footer, { paddingBottom: Math.max(16, insets.bottom) }]}>
          {reason ? (
            <Text accessibilityLiveRegion="polite" style={s.reason}>
              {reason}
            </Text>
          ) : null}
          <Pressable
            testID="product-add"
            accessibilityRole="button"
            accessibilityLabel={`${props.editing ? 'Сохранить' : 'Добавить в корзину'}: ${money((BigInt(unit) * BigInt(quantity)).toString())}`}
            accessibilityState={{ disabled: !!reason }}
            disabled={!!reason}
            style={[s.add, !!reason && { opacity: 0.5 }]}
            onPress={() => {
              if (props.onSave) props.onSave(selections, quantity);
              else {
                props.model.addToCart(product.id, selections, quantity);
                props.goBack();
              }
            }}
          >
            <Icon name={props.editing ? 'checkmark' : 'add'} color={colors.orangeInk} size={27} />
            <Text style={s.addText}>{money((BigInt(unit) * BigInt(quantity)).toString())}</Text>
          </Pressable>
        </View>
        <Pressable
          testID="product-close"
          accessibilityRole="button"
          accessibilityLabel="Закрыть блюдо"
          onPress={props.goBack}
          style={[s.close, { top: insets.top + 10, left: 16 }]}
        >
          <Icon name="close" color={colors.white} size={30} />
        </Pressable>
      </View>
      <MotionModal visible={!!picker} animationType="slide" onRequestClose={() => setPicker(null)}>
        {picker ? (
          <View
            style={[s.modal, { paddingTop: insets.top }]}
            accessibilityViewIsModal
            testID="photo-replacement-dialog"
          >
            <Row style={s.modalHeader}>
              <Pressable
                style={s.modalClose}
                accessibilityRole="button"
                accessibilityLabel="Закрыть замену без сохранения"
                onPress={() => setPicker(null)}
              >
                <Icon name="close" size={29} />
              </Pressable>
              <Text style={s.modalTitle}>
                Заменить {picker.group.id === 'drink' ? 'напиток' : 'соус'}
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
                    <Text style={[s.tileName, chosen && { color: ink }]}>{option.label}</Text>
                    <Text style={[s.tilePrice, chosen && { color: ink }]}>
                      {unavailable
                        ? 'Временно нет'
                        : option.price_delta_minor === '0' && chosen
                          ? 'В комбо'
                          : `+${money(option.price_delta_minor)}`}
                    </Text>
                    {chosen ? (
                      <View style={s.check}>
                        <Icon name="checkmark-circle" color={colors.action} size={23} />
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={[s.modalFooter, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              <Pressable
                testID="photo-replacement-apply"
                accessibilityRole="button"
                disabled={!picker.chosen}
                accessibilityState={{ disabled: !picker.chosen }}
                style={s.add}
                onPress={() => {
                  if (picker.chosen)
                    setSelections(
                      replaceComboSlot(selections, picker.group, picker.index, picker.chosen),
                    );
                  setPicker(null);
                }}
              >
                <Text style={s.addText}>Назад в комбо</Text>
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
              <Text style={s.modalTitle}>Пищевая ценность</Text>
              <Pressable
                style={s.modalClose}
                accessibilityRole="button"
                accessibilityLabel="Закрыть окно пищевой ценности"
                onPress={() => setInfo(false)}
              >
                <Icon name="close" size={27} />
              </Pressable>
            </Row>
            <ScrollView>{infoContent}</ScrollView>
          </View>
        </View>
      </MotionModal>
    </View>
  );
}
function OptionImage({ id, size }: { id: string | null; size: number }) {
  const s = warmStyles;
  const source = id ? optionPhotos[id] : undefined;
  return (
    <View style={[s.optionPhoto, { width: size, height: size }]}>
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
  const paper = blue ? '#0047BB' : '#D8C5A7';
  const muted = blue ? '#D4E5FF' : '#594635';
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: paper },
    blend: { position: 'absolute', bottom: -1, left: 0, right: 0, height: 70 },
    close: {
      position: 'absolute',
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: '#271C15B8',
      alignItems: 'center',
      justifyContent: 'center',
    },
    photoAction: {
      position: 'absolute',
      bottom: 22,
      right: 20,
      backgroundColor: '#FFF9ED',
      borderRadius: 28,
      paddingHorizontal: 18,
      paddingVertical: 14,
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
      minHeight: 48,
    },
    photoActionText: { fontFamily: font.bold, fontSize: 14, color: '#271C15' },
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
    replace: { fontFamily: font.bold, fontSize: 12, color: ink },
    moreRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      minHeight: 60,
      paddingVertical: 10,
    },
    extra: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
    footer: { paddingTop: 12, paddingHorizontal: 24, backgroundColor: paper, gap: 8 },
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
    counter: { backgroundColor: blue ? '#103B86' : '#C8B395', borderRadius: 25, gap: 0 },
    countButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
    count: { fontFamily: font.bold, fontSize: 15, minWidth: 18, textAlign: 'center', color: ink },
    modal: { flex: 1, backgroundColor: colors.background },
    modalHeader: { paddingHorizontal: 16, paddingVertical: 14, gap: 14 },
    modalClose: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
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
    tileSelected: { backgroundColor: '#FFF9ED' },
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
      backgroundColor: '#F6F6F6',
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
      gap: 8,
      alignSelf: 'center',
      paddingHorizontal: 20,
      paddingVertical: 14,
      minHeight: 48,
      borderRadius: 24,
      backgroundColor: blue ? '#073987' : '#EADBC5',
      marginTop: 12,
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
