import { useMemo } from 'react';
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { KioskModifierGroup, KioskSelection } from '../model';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { productCopy } from '../productCopy';
import {
  applyPick,
  drinkShelves,
  groupCount,
  isDrinkGroup,
  picked,
  pickedNames,
  sectionTitle,
  surchargeMinor,
} from '../product-presentation';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { ComboOptionTile } from './ComboOptionTile';
import { GlassPanel } from './GlassPanel';
import { Icon } from './Icon';
import { useEnter, usePress } from './motion';
import { ownerOrange } from './ownerOrange';
import { fixedText } from './Body';
type Option = KioskModifierGroup['options'][number];
/** Sheet colours (product-and-payment.md §2). */
const SHEET = '#0A3FA8';
const SCRIM = 'rgba(2,10,31,.6)';
const COLUMNS = 5;
const rows = <T,>(items: T[], size: number): T[][] =>
  items.reduce<T[][]>((all, item, i) => {
    if (i % size === 0) all.push([]);
    all[all.length - 1]!.push(item);
    return all;
  }, []);
/** Mounted on every opening, so the sheet slides up each time. */
function Sheet({
  group,
  productName,
  selections,
  setSelections,
  included,
  locale,
  onClose,
}: {
  group: KioskModifierGroup;
  productName: string;
  selections: KioskSelection[];
  setSelections: (next: KioskSelection[]) => void;
  included: string;
  locale: Locale;
  onClose: () => void;
}) {
  const { px, height } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const tp = productCopy(locale);
  const shade = useEnter(0, 240, 'css');
  const rise = useEnter(0, 440);
  const done = usePress(0.98);
  const close = usePress(0.92);
  const drinks = isDrinkGroup(group);
  const sheetHeight = Math.min(px(1110), height - safe.top - px(24));
  const offset = useMemo(
    () => rise.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight, 0] }),
    [rise, sheetHeight],
  );
  const shelves: { title: string | null; options: Option[] }[] = drinks
    ? drinkShelves(group.options).map((entry) => ({
        title: { soda: tp.shelfSoda, tea: tp.shelfTea, other: tp.shelfOther }[entry.shelf],
        options: entry.options,
      }))
    : [{ title: null, options: group.options }];
  const items = picked(group, selections);
  const total = groupCount(group, selections);
  const extra = surchargeMinor(items);
  const names = pickedNames(items);
  const label = names
    ? `${t.done} · ${names}${BigInt(extra) > 0n ? ' +' + money(extra) : ''}`
    : t.done;
  const quantityOf = (id: string) =>
    selections
      .filter((s) => s.group_id === group.id && s.option_id === id)
      .reduce((sum, s) => sum + s.quantity, 0);
  const blur =
    Platform.OS === 'web'
      ? ({ backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' } as unknown as ViewStyle)
      : null;
  const control = Math.max(48, px(64));
  const title = drinks ? tp.chooseDrink : sectionTitle(group, tp);
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM, opacity: shade }, blur]}
      />
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        tabIndex={-1}
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View
        testID={drinks ? 'kiosk-drinks-sheet' : 'kiosk-option-sheet'}
        accessibilityViewIsModal
        style={{
          height: sheetHeight,
          backgroundColor: SHEET,
          borderTopLeftRadius: px(44),
          borderTopRightRadius: px(44),
          overflow: 'hidden',
          transform: [{ translateY: offset }],
        }}
      >
        <View style={{ alignItems: 'center', paddingTop: px(14) }}>
          <View
            style={{
              width: px(64),
              height: px(6),
              borderRadius: px(3),
              backgroundColor: 'rgba(255,255,255,.35)',
            }}
          />
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: px(16),
            paddingTop: px(16),
            paddingLeft: Math.max(safe.left, px(24)),
            paddingRight: Math.max(safe.right, px(24)),
          }}
        >
          <Text
            {...fixedText}
            accessibilityRole="header"
            numberOfLines={1}
            style={{
              flexShrink: 1,
              fontFamily: fonts.black,
              fontSize: px(34),
              lineHeight: px(40),
              letterSpacing: -0.4,
              color: colors.white,
            }}
          >
            {title}
          </Text>
          <View style={{ flex: 1 }} />
          <Text
            {...fixedText}
            numberOfLines={1}
            style={{
              flexShrink: 1,
              fontFamily: fonts.medium,
              fontSize: Math.max(13, px(17)),
              color: 'rgba(255,255,255,.75)',
            }}
          >
            {tp.includedIn.replace('{product}', productName)}
          </Text>
          <Animated.View style={{ transform: [{ scale: close.scale }] }}>
            <GlassPanel shape="circle">
              <Pressable
                testID={drinks ? 'kiosk-drinks-close' : 'kiosk-option-sheet-close'}
                accessibilityRole="button"
                accessibilityLabel={t.close}
                onPress={onClose}
                onPressIn={close.onPressIn}
                onPressOut={close.onPressOut}
                style={{
                  width: control,
                  height: control,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="close" size="small" tone="inverse" />
              </Pressable>
            </GlassPanel>
          </Animated.View>
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingTop: px(20),
            paddingBottom: px(24),
            paddingLeft: Math.max(safe.left, px(24)),
            paddingRight: Math.max(safe.right, px(24)),
            gap: px(22),
          }}
        >
          {shelves.map((shelf) => (
            <View key={shelf.title ?? 'all'} style={{ gap: px(14) }}>
              {shelf.title ? (
                <Text
                  {...fixedText}
                  accessibilityRole="header"
                  style={{ fontFamily: fonts.black, fontSize: px(22), color: colors.white }}
                >
                  {shelf.title}
                </Text>
              ) : null}
              {rows(shelf.options, COLUMNS).map((row, r) => (
                <View key={r} style={{ flexDirection: 'row', gap: px(12) }}>
                  {row.map((option, i) => (
                    <ComboOptionTile
                      key={option.id}
                      groupId={group.id}
                      option={option}
                      quantity={quantityOf(option.id)}
                      multi={group.max > 1}
                      full={quantityOf(option.id) >= option.max_quantity || total >= group.max}
                      clearable={group.min === 0}
                      included={included}
                      tall
                      index={r * COLUMNS + i}
                      locale={locale}
                      onChange={(quantity) =>
                        setSelections(applyPick(group, selections, option.id, quantity))
                      }
                    />
                  ))}
                  {Array.from({ length: COLUMNS - row.length }, (_, k) => (
                    <View key={'gap' + k} style={{ flex: 1 }} />
                  ))}
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
        <View
          style={{
            paddingTop: px(12),
            paddingLeft: Math.max(safe.left, px(24)),
            paddingRight: Math.max(safe.right, px(24)),
            paddingBottom: Math.max(safe.bottom, px(26)),
          }}
        >
          <Animated.View style={{ transform: [{ scale: done.scale }] }}>
            <Pressable
              testID={drinks ? 'kiosk-drinks-done' : 'kiosk-option-sheet-done'}
              {...ownerOrange}
              accessibilityRole="button"
              accessibilityLabel={label}
              onPress={onClose}
              onPressIn={done.onPressIn}
              onPressOut={done.onPressOut}
              style={{
                height: Math.max(56, px(88)),
                borderRadius: 999,
                backgroundColor: redesign.cta,
                shadowColor: redesign.cta,
                shadowOpacity: 0.5,
                shadowRadius: px(13),
                shadowOffset: { width: 0, height: px(10) },
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: px(28),
              }}
            >
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{
                  fontFamily: fonts.black,
                  fontSize: px(26),
                  color: colors.white,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {label}
              </Text>
            </Pressable>
          </Animated.View>
        </View>
      </Animated.View>
    </View>
  );
}
/**
 * Option sheet over the product card (kiosk redesign 2026-10-13, product-and-payment.md §2):
 * the scrim rgba(2,10,31,.6) (blur 6 on the web) and a #0A3FA8 sheet up to 1110 high with top
 * corners of 44, a handle, «Выберите напиток» with «Входит в Pick Combo» and a glass ✕. Drinks
 * stand on shelves («Газировка», «Холодный чай», «Лимонад, вода, сок»), five tiles across, the
 * same tiles as the card; any other group is one shelf. A tap picks at once (the card follows);
 * the orange «Готово · Лимонад 0.5 л +200 ₸» shows the pick and its surcharge and closes.
 */
export function ComboOptionSheet({
  visible,
  group,
  productName,
  selections,
  setSelections,
  included,
  locale,
  onClose,
}: {
  visible: boolean;
  group: KioskModifierGroup | null;
  productName: string;
  selections: KioskSelection[];
  setSelections: (next: KioskSelection[]) => void;
  /** Status of a free option («Входит в комбо»). */
  included: string;
  locale: Locale;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible && !!group}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {group ? (
        <Sheet
          group={group}
          productName={productName}
          selections={selections}
          setSelections={setSelections}
          included={included}
          locale={locale}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  );
}
