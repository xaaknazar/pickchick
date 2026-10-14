import { glassSurface } from './glassSurface';
import { useEffect, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import type { KioskModifierGroup, KioskSelection } from '../model';
import { money } from '../cart';
import { optionPhoto } from '../assets';
import { copy, type Locale } from '../i18n';
import { productCopy } from '../productCopy';
import {
  applyPick,
  chooseText,
  gridColumns,
  groupComplete,
  groupCount,
  isDrinkGroup,
  optionGrid,
  picked,
  pickedNames,
  sectionTitle,
  surchargeMinor,
} from '../product-presentation';
import { colors, fonts, useMetrics } from '../theme';
import { ComboOptionTile } from './ComboOptionTile';
import { Icon } from './Icon';
import { PhotoImage } from './PhotoImage';
import { usePopIn, usePress, useShake } from './motion';
import { useScrollTarget } from './scroll';
import { fixedText } from './Body';
type Option = KioskModifierGroup['options'][number];
/** Design green of a complete section (product-and-payment.md §1). */
const DONE = '#2E9E5B';
const rows = <T,>(items: T[], size: number): T[][] =>
  items.reduce<T[][]>((all, item, i) => {
    if (i % size === 0) all.push([]);
    all[all.length - 1]!.push(item);
    return all;
  }, []);
/** «Ещё N · Показать все»: dashed tile with small photos of the options in the sheet. */
function MoreTile({
  groupId,
  hidden,
  tall,
  locale,
  onPress,
}: {
  groupId: string;
  hidden: Option[];
  tall: boolean;
  locale: Locale;
  onPress: () => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const tp = productCopy(locale);
  const press = usePress(0.96);
  const previews = hidden.filter((option) => optionPhoto(option.id)).slice(0, 3);
  const more = tp.more.replace('{n}', String(hidden.length));
  return (
    <Animated.View
      style={{
        flex: 1,
        minWidth: 0,
        height: px(tall ? 172 : 164),
        transform: [{ scale: press.scale }],
      }}
    >
      <Pressable
        testID={`kiosk-modifier-expand-${groupId}`}
        accessibilityRole="button"
        accessibilityLabel={`${more}, ${t.showAll}`}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={{
          flex: 1,
          borderRadius: px(24),
          ...glassSurface(),
          alignItems: 'center',
          justifyContent: 'center',
          gap: px(6),
          padding: px(10),
        }}
      >
        {previews.length ? (
          <View
            style={{
              flexDirection: 'row',
              height: px(70),
              paddingHorizontal: px(6),
              paddingVertical: px(5),
              borderRadius: px(14),
              backgroundColor: 'rgba(255,255,255,.12)',
              marginBottom: px(4),
            }}
          >
            {previews.map((option) => (
              <View key={option.id} style={{ width: px(38), height: '100%' }}>
                <PhotoImage imageId={option.id} variant="option" />
              </View>
            ))}
          </View>
        ) : null}
        <Text
          {...fixedText}
          numberOfLines={1}
          style={{ fontFamily: fonts.black, fontSize: px(20), color: colors.white }}
        >
          {more}
        </Text>
        <Text
          {...fixedText}
          numberOfLines={1}
          style={{
            fontFamily: fonts.medium,
            fontSize: px(14),
            lineHeight: px(18),
            color: colors.onGlass,
          }}
        >
          {t.showAll}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
/**
 * Numbered section of the product card (kiosk redesign 2026-10-13, product-and-payment.md §1):
 * a white number disc and the title («① Напиток»), on the right the pill with the pick
 * («✓ Coca-Cola 0.5 л», «✓ Лимонад 0.5 л +200 ₸»; peach «Выберите соус» while empty), then
 * the option tiles: drinks five across in two rows of 172, other choices four across (164).
 * More drinks than fit: nine tiles and «Ещё N · Показать все», which opens the sheet; a pick
 * from the sheet takes the last tile so it stays in view. Inside a ScrollArea the section is a
 * `focus` target named by the group id; a new `attention` value shakes its tiles 380 ms later.
 */
export function ComboSection({
  number,
  group,
  selections,
  setSelections,
  included,
  locale,
  attention,
  onMore,
}: {
  /** Position of the section (the number in the disc). */
  number: number;
  group: KioskModifierGroup;
  selections: KioskSelection[];
  setSelections: (next: KioskSelection[]) => void;
  /** Status of a free option («Входит в комбо»). */
  included: string;
  locale: Locale;
  /** Bump to point the guest at this section (scroll first, shake after 380 ms). */
  attention?: number;
  /** The «Ещё» tile: the sheet with every option of the group. */
  onMore: () => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const tp = productCopy(locale);
  const target = useScrollTarget(group.id);
  const [nudge, setNudge] = useState(0);
  const shake = useShake(nudge);
  useEffect(() => {
    if (!attention) return;
    const timer = setTimeout(() => setNudge((n) => n + 1), 380);
    return () => clearTimeout(timer);
  }, [attention]);
  const columns = gridColumns(group);
  const tall = isDrinkGroup(group);
  const items = picked(group, selections);
  const done = groupComplete(group, selections);
  const total = groupCount(group, selections);
  const extra = surchargeMinor(items);
  const grid = optionGrid(
    group.options,
    items.map((item) => item.option.id),
    columns * 2,
  );
  const quantityOf = (id: string) =>
    selections
      .filter((s) => s.group_id === group.id && s.option_id === id)
      .reduce((sum, s) => sum + s.quantity, 0);
  const value = done
    ? pickedNames(items) + (BigInt(extra) > 0n ? ' +' + money(extra) : '')
    : total > 0 && group.max > 1
      ? t.chosenOf.replace('{n}', String(total)).replace('{max}', String(group.max))
      : chooseText(group, tp);
  const pop = usePopIn(value, 360, 0, false);
  const cells: (Option | 'more')[] = [
    ...grid.shown,
    ...(grid.hidden.length ? ['more' as const] : []),
  ];
  return (
    <View
      ref={target}
      collapsable={false}
      testID={`kiosk-section-${group.id}`}
      style={{ gap: px(16) }}
    >
      <View style={{ minHeight: px(44), flexDirection: 'row', alignItems: 'center', gap: px(12) }}>
        <View
          style={{
            width: px(42),
            height: px(42),
            borderRadius: px(21),
            backgroundColor: colors.white,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            {...fixedText}
            style={{ fontFamily: fonts.black, fontSize: px(22), color: colors.blue }}
          >
            {number}
          </Text>
        </View>
        <Text
          {...fixedText}
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            flexShrink: 1,
            fontFamily: fonts.black,
            fontSize: px(30),
            lineHeight: px(36),
            letterSpacing: -0.3,
            color: colors.white,
          }}
        >
          {sectionTitle(group, tp)}
        </Text>
        <View style={{ flex: 1 }} />
        <Animated.View
          testID={`kiosk-section-value-${group.id}`}
          style={{
            flexShrink: 1,
            maxWidth: '55%',
            height: px(44),
            paddingLeft: done ? px(8) : px(18),
            paddingRight: px(18),
            borderRadius: 999,
            backgroundColor: done ? 'rgba(255,255,255,.12)' : '#FFE7D6',
            borderWidth: 1,
            borderColor: done ? 'rgba(255,255,255,.24)' : '#FFE7D6',
            flexDirection: 'row',
            alignItems: 'center',
            gap: px(8),
            opacity: pop.opacity,
            transform: [{ scale: pop.scale }],
          }}
        >
          {done ? (
            <View
              style={{
                width: px(28),
                height: px(28),
                borderRadius: px(14),
                backgroundColor: DONE,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="checkmark" size="small" tone="inverse" />
            </View>
          ) : null}
          <Text
            {...fixedText}
            numberOfLines={1}
            style={{
              flexShrink: 1,
              fontFamily: fonts.heavy,
              fontSize: px(17),
              color: done ? colors.white : colors.orangeInk,
              fontVariant: ['tabular-nums'],
            }}
          >
            {value}
          </Text>
        </Animated.View>
      </View>
      <Animated.View style={{ gap: px(12), transform: [{ translateX: shake }] }}>
        {rows(cells, columns).map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', gap: px(12) }}>
            {row.map((cell, i) =>
              cell === 'more' ? (
                <MoreTile
                  key="more"
                  groupId={group.id}
                  hidden={grid.hidden}
                  tall={tall}
                  locale={locale}
                  onPress={onMore}
                />
              ) : (
                <ComboOptionTile
                  key={cell.id}
                  groupId={group.id}
                  option={cell}
                  quantity={quantityOf(cell.id)}
                  multi={group.max > 1}
                  full={quantityOf(cell.id) >= cell.max_quantity || total >= group.max}
                  clearable={group.min === 0}
                  included={included}
                  tall={tall}
                  index={r * columns + i}
                  locale={locale}
                  onChange={(quantity) =>
                    setSelections(applyPick(group, selections, cell.id, quantity))
                  }
                />
              ),
            )}
            {Array.from({ length: columns - row.length }, (_, k) => (
              <View key={'gap' + k} style={{ flex: 1 }} />
            ))}
          </View>
        ))}
      </Animated.View>
    </View>
  );
}
