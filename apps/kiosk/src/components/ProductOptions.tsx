import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { PhotoImage } from './PhotoImage';
import type { KioskModifierGroup, KioskSelection } from '../model';
import { money } from '../cart';
import { heinzColor, heinzInk, optionPhoto } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Icon } from './Icon';
import { Stepper } from './Stepper';
import {
  useEnter,
  usePopIn,
  usePress,
  usePulse,
  useShake,
  useSpringTo,
  useTimingTo,
} from './motion';
import { useScrollTarget } from './scroll';
import { fixedText } from './Body';
type Option = KioskModifierGroup['options'][number];
/** Keeps a volume or weight with its number on one line ("Coca-Cola 0.5 л" never breaks at л). */
const tileLabel = (label: string) =>
  label.replace(/(\d)\s+(мл|л|г|кг|шт|ml|l|g|kg|pcs)(?=$|[\s,.)])/giu, '$1\u00A0$2');
const shadow = {
  shadowColor: '#020A28',
  shadowOpacity: 0.18,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
} as const;
const rows = <T,>(items: T[], size: number): T[][] =>
  items.reduce<T[][]>((all, item, i) => {
    if (i % size === 0) all.push([]);
    all[all.length - 1]!.push(item);
    return all;
  }, []);
/** Supplied artwork, a Heinz colour mark, or a neutral glyph on the option tile. */
function OptionArt({ id, dim, selected }: { id: string; dim: number; selected: boolean }) {
  const photo = optionPhoto(id);
  const heinz = heinzColor(id);
  const lift = useSpringTo(selected ? 1 : 0);
  if (photo)
    return (
      <Animated.View
        style={{
          width: dim,
          height: dim,
          padding: photo.cutout ? dim * 0.04 : 0,
          transform: [
            { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
            { rotate: lift.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-4deg'] }) },
          ],
        }}
      >
        <PhotoImage imageId={id} variant="option" />
      </Animated.View>
    );
  if (heinz)
    return (
      <View
        style={{
          width: dim * 0.78,
          height: dim * 0.78,
          borderRadius: dim,
          backgroundColor: heinz,
          borderBottomWidth: dim * 0.05,
          borderColor: 'rgba(0,0,0,.15)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          {...fixedText}
          style={{
            fontFamily: fonts.black,
            fontSize: Math.max(15, dim * 0.16),
            color: heinzInk(id),
          }}
        >
          Heinz
        </Text>
      </View>
    );
  return <Icon name="fast-food-outline" size="large" tone="brand" />;
}
/** Price pill: included (sky), surcharge (peach) or unavailable (grey). */
function PricePill({ option, locale }: { option: Option; locale: Locale }) {
  const { v } = useMetrics();
  const t = copy(locale);
  const plus = BigInt(option.price_delta_minor) > 0n;
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        height: v(28),
        paddingHorizontal: v(10),
        borderRadius: v(14),
        justifyContent: 'center',
        backgroundColor: !option.available ? '#F1F2F5' : plus ? colors.peach : colors.sky,
      }}
    >
      <Text
        {...fixedText}
        numberOfLines={1}
        style={{
          fontFamily: fonts.bold,
          fontSize: Math.max(12, v(14)),
          fontVariant: ['tabular-nums'],
          color: !option.available ? colors.muted : plus ? colors.orangeInk : colors.blue,
        }}
      >
        {!option.available
          ? t.unavailableShort
          : plus
            ? '+' + money(option.price_delta_minor)
            : t.included}
      </Text>
    </View>
  );
}
/** One choice tile: photo on its tile colour, label, price pill, orange ring and badge. */
function OptionTile({
  group,
  option,
  index,
  quantity,
  total,
  drinks,
  visual,
  locale,
  update,
}: {
  group: KioskModifierGroup;
  option: Option;
  index: number;
  quantity: number;
  total: number;
  drinks: boolean;
  visual: boolean;
  locale: Locale;
  update: (id: string, quantity: number) => void;
}) {
  const { v } = useMetrics();
  const enter = useEnter(200 + Math.min(index, 10) * 25, 460);
  const selected = quantity > 0;
  const multi = group.max > 1;
  // Prototype `.opt.sel .ck`: the check (or count) pops in, 380 ms --spring.
  const check = usePopIn(selected ? quantity : 0, 380);
  // Prototype `.opt.sel` ring: box-shadow transition 160 ms.
  const ringIn = useTimingTo(selected ? 1 : 0, 160, 'css');
  // `.opt:active` squeeze, and the pick pulse .94 -> 1.04 -> 1 (340 ms ease-out).
  const press = usePress(0.96);
  const pulse = usePulse(0.94, 1.04, 340, 'out');
  const scale = useMemo(
    () => Animated.multiply(press.scale, pulse.scale),
    [press.scale, pulse.scale],
  );
  const counted = useRef(quantity);
  const play = pulse.play;
  useEffect(() => {
    if (quantity > counted.current) play();
    counted.current = quantity;
  }, [play, quantity]);
  // A pick beyond the limit shakes the tile (prototype `shake`, 420 ms).
  const [refused, setRefused] = useState(0);
  const shake = useShake(refused);
  const full = quantity >= option.max_quantity || total >= group.max;
  const delta = BigInt(option.price_delta_minor) > 0n ? '+ ' + money(option.price_delta_minor) : '';
  const photo = optionPhoto(option.id);
  const art = v(drinks ? 112 : 118);
  const card = (
    <>
      {visual ? (
        <View
          style={{
            height: v(drinks ? 132 : 140),
            backgroundColor: photo?.tile ?? colors.cream,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: option.available ? 1 : 0.7,
          }}
        >
          <OptionArt id={option.id} dim={art} selected={selected} />
        </View>
      ) : null}
      <View
        style={{
          flex: 1,
          paddingTop: v(visual ? 10 : 18),
          paddingHorizontal: v(12),
          paddingBottom: v(visual ? 14 : 18),
          gap: v(6),
        }}
      >
        <Text
          {...fixedText}
          numberOfLines={2}
          style={
            visual
              ? {
                  fontFamily: fonts.medium,
                  fontSize: Math.max(13, v(drinks ? 15 : 16)),
                  lineHeight: Math.max(17, v(drinks ? 19 : 20)),
                  minHeight: Math.max(34, v(drinks ? 38 : 40)),
                  color: colors.navy,
                }
              : {
                  fontFamily: fonts.black,
                  fontSize: v(28),
                  color: colors.navy,
                }
          }
        >
          {tileLabel(option.label)}
        </Text>
        <PricePill option={option} locale={locale} />
      </View>
    </>
  );
  const surface = {
    flex: 1,
    borderRadius: v(24),
    backgroundColor: colors.white,
    overflow: 'hidden' as const,
    opacity: option.available ? 1 : 0.55,
  };
  const ring = (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        borderRadius: v(24),
        borderWidth: v(4),
        borderColor: colors.orange,
        opacity: ringIn,
      }}
    />
  );
  const badge = (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: v(10),
        right: v(10),
        width: v(34),
        height: v(34),
        borderRadius: v(17),
        // A count is small white text; a check mark keeps the brand orange.
        backgroundColor: multi ? colors.orangeInk : colors.orange,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: colors.orange,
        shadowOpacity: selected ? 0.4 : 0,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
        opacity: selected ? check.opacity : 0,
        transform: [{ scale: check.scale }],
      }}
    >
      {multi ? (
        <Text
          {...fixedText}
          testID={`kiosk-modifier-quantity-${group.id}-${option.id}`}
          style={{
            fontFamily: fonts.black,
            fontSize: v(16),
            color: colors.white,
            fontVariant: ['tabular-nums'],
          }}
        >
          {quantity}
        </Text>
      ) : (
        <Icon name="checkmark" size="small" tone="inverse" />
      )}
    </Animated.View>
  );
  return (
    <Animated.View
      style={{
        flex: 1,
        minWidth: 0,
        borderRadius: v(24),
        ...shadow,
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [34, 0] }) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
        ],
      }}
    >
      {multi ? (
        <Animated.View
          testID={`kiosk-modifier-${group.id}-${option.id}`}
          style={{ flex: 1, transform: [{ translateX: shake }, { scale }] }}
        >
          <Pressable
            testID={`kiosk-modifier-plus-${group.id}-${option.id}`}
            accessibilityRole="button"
            // No override: the name comes from the visible tile text (WCAG 2.5.3).
            accessibilityState={{ disabled: !option.available || full }}
            disabled={!option.available || full}
            onPress={() => update(option.id, quantity + 1)}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            style={surface}
          >
            {card}
          </Pressable>
          {option.available && full ? (
            // Silent layer over a tile already at its limit: a tap only shakes it.
            <Pressable
              accessible={false}
              importantForAccessibility="no"
              tabIndex={-1}
              onPress={() => setRefused((n) => n + 1)}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
          {ring}
          {badge}
          <Pressable
            testID={`kiosk-modifier-minus-${group.id}-${option.id}`}
            accessibilityRole="button"
            accessibilityLabel={'- ' + option.label}
            accessibilityState={{ disabled: quantity <= 0 }}
            disabled={quantity <= 0}
            onPress={() => update(option.id, quantity - 1)}
            hitSlop={8}
            style={({ pressed }) => ({
              position: 'absolute',
              top: v(10),
              left: v(10),
              width: v(34),
              height: v(34),
              borderRadius: v(17),
              backgroundColor: colors.white,
              alignItems: 'center',
              justifyContent: 'center',
              shadowColor: '#020A28',
              shadowOpacity: selected ? 0.25 : 0,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
              opacity: selected ? 1 : 0,
              transform: [{ scale: pressed ? 0.9 : 1 }],
            })}
          >
            <Icon name="remove" size="small" tone="navy" />
          </Pressable>
        </Animated.View>
      ) : (
        <Animated.View style={{ flex: 1, transform: [{ scale }] }}>
          <Pressable
            testID={`kiosk-modifier-${group.id}-${option.id}`}
            accessibilityRole="radio"
            accessibilityLabel={option.label + (delta ? ', ' + delta : '')}
            accessibilityState={{ checked: selected, disabled: !option.available }}
            aria-checked={selected}
            disabled={!option.available}
            onPress={() => update(option.id, selected && group.min === 0 ? 0 : 1)}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            style={surface}
          >
            {card}
          </Pressable>
          {ring}
          {badge}
        </Animated.View>
      )}
    </Animated.View>
  );
}
/** Optional extras as v3 rows: photo, label, surcharge and a stepper. */
function ExtraRow({
  group,
  option,
  index,
  quantity,
  total,
  locale,
  update,
}: {
  group: KioskModifierGroup;
  option: Option;
  index: number;
  quantity: number;
  total: number;
  locale: Locale;
  update: (id: string, quantity: number) => void;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const enter = useEnter(200 + Math.min(index, 10) * 30, 460);
  const photo = optionPhoto(option.id);
  const selected = quantity > 0;
  // Prototype `.xrow.on` ring (160 ms) and the shake when + is already at its limit.
  const ringIn = useTimingTo(selected ? 1 : 0, 160, 'css');
  const [refused, setRefused] = useState(0);
  const shake = useShake(refused);
  return (
    <Animated.View
      testID={`kiosk-modifier-${group.id}-${option.id}`}
      style={{
        minHeight: v(92),
        borderRadius: v(24),
        backgroundColor: colors.white,
        ...shadow,
        flexDirection: 'row',
        alignItems: 'center',
        gap: v(16),
        paddingLeft: v(10),
        paddingRight: v(12),
        paddingVertical: v(10),
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [34, 0] }) },
          { translateX: shake },
        ],
      }}
    >
      <View
        style={{
          width: v(72),
          height: v(72),
          borderRadius: v(18),
          overflow: 'hidden',
          backgroundColor: photo?.tile ?? '#FFF8EE',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: option.available ? 1 : 0.55,
        }}
      >
        <OptionArt id={option.id} dim={v(72)} selected={false} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: v(2) }}>
        <Text
          {...fixedText}
          numberOfLines={2}
          style={{ fontFamily: fonts.medium, fontSize: Math.max(16, v(19)), color: colors.navy }}
        >
          {tileLabel(option.label)}
        </Text>
        <Text
          {...fixedText}
          style={{
            fontFamily: fonts.bold,
            fontSize: Math.max(14, v(16)),
            fontVariant: ['tabular-nums'],
            color: option.available ? colors.orangeInk : colors.muted,
          }}
        >
          {option.available ? '+' + money(option.price_delta_minor) : t.unavailableShort}
        </Text>
      </View>
      <Stepper
        quantity={quantity}
        locale={locale}
        min={0}
        max={
          option.available ? Math.min(option.max_quantity, quantity + group.max - total) : quantity
        }
        ids={{
          minus: `kiosk-modifier-minus-${group.id}-${option.id}`,
          quantity: `kiosk-modifier-quantity-${group.id}-${option.id}`,
          plus: `kiosk-modifier-plus-${group.id}-${option.id}`,
        }}
        labels={{ minus: '- ' + option.label, plus: '+ ' + option.label }}
        onMinus={() => update(option.id, quantity - 1)}
        onPlus={() => update(option.id, quantity + 1)}
        onLimit={option.available ? () => setRefused((n) => n + 1) : undefined}
      />
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          borderRadius: v(24),
          borderWidth: v(3),
          borderColor: colors.orange,
          opacity: ringIn,
        }}
      />
    </Animated.View>
  );
}
/** Group status chip: chosen names, "n of m" while incomplete, or "optional". */
function GroupChip({
  group,
  options,
  selections,
  total,
  locale,
}: {
  group: KioskModifierGroup;
  options: Option[];
  selections: KioskSelection[];
  total: number;
  locale: Locale;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  // Prototype `.gchip.flash`: pop (scale .3 -> 1, fade in) 360 ms --spring on any
  // change inside the group.
  const change = selections
    .filter((s) => s.group_id === group.id)
    .map((s) => s.option_id + ':' + s.quantity)
    .join(',');
  const pop = usePopIn(change, 360, 0, false);
  if (group.min === 0)
    return (
      <Animated.View style={{ opacity: pop.opacity, transform: [{ scale: pop.scale }] }}>
        <Text
          {...fixedText}
          style={{
            fontFamily: fonts.body,
            fontSize: Math.max(15, v(16)),
            color: colors.onBlueMuted,
          }}
        >
          {t.optional}
          {total ? ` · ${total} ${t.pieces}` : ''}
        </Text>
      </Animated.View>
    );
  const done = total >= group.min && total <= group.max;
  const names = selections
    .filter(
      (s) => s.group_id === group.id && options.some((o) => o.id === s.option_id && o.available),
    )
    .map((s) => {
      const label = options.find((o) => o.id === s.option_id)?.label ?? '';
      return s.quantity > 1 ? `${label} × ${s.quantity}` : label;
    })
    .join(', ');
  return (
    <Animated.View
      style={{
        flexShrink: 1,
        maxWidth: '42%',
        height: v(38),
        paddingHorizontal: v(14),
        borderRadius: 999,
        backgroundColor: done ? colors.white : colors.peach,
        flexDirection: 'row',
        alignItems: 'center',
        gap: v(6),
        opacity: pop.opacity,
        transform: [{ scale: pop.scale }],
      }}
    >
      {done ? <Icon name="checkmark" size="small" tone="brand" /> : null}
      <Text
        {...fixedText}
        numberOfLines={1}
        style={{
          flexShrink: 1,
          fontFamily: fonts.bold,
          fontSize: Math.max(13, v(15)),
          color: done ? colors.blue : colors.orangeInk,
        }}
      >
        {done
          ? names
          : t.chosenOf.replace('{n}', String(total)).replace('{max}', String(group.max))}
      </Text>
    </Animated.View>
  );
}
/**
 * v3 modifier group. Photo options become tiles (drinks five across, others four),
 * optional multi-quantity extras become rows with a stepper, and options without
 * artwork (sizes) become large text tiles. Selection logic and limits are unchanged.
 * Inside a ScrollArea the group is a `focus` target named by its id; a new
 * `attention` value shakes its options 380 ms later (the guest tried to add the
 * product while this choice was missing).
 */
export function ModifierOptions({
  group,
  selections,
  setSelections,
  locale,
  limit,
  attention,
}: {
  group: KioskModifierGroup;
  selections: KioskSelection[];
  setSelections: (s: KioskSelection[]) => void;
  locale: Locale;
  limit?: number;
  /** Bump to point the guest at this group (scroll first, shake after 380 ms). */
  attention?: number;
}) {
  const { v } = useMetrics();
  const target = useScrollTarget(group.id);
  const [nudge, setNudge] = useState(0);
  const shake = useShake(nudge);
  useEffect(() => {
    if (!attention) return;
    const timer = setTimeout(() => setNudge((n) => n + 1), 380);
    return () => clearTimeout(timer);
  }, [attention]);
  // A pick stopped while the page is open does not count (the chip shows the group as open).
  const total = selections
    .filter(
      (s) =>
        s.group_id === group.id && group.options.some((o) => o.id === s.option_id && o.available),
    )
    .reduce((n, s) => n + s.quantity, 0);
  const update = (id: string, quantity: number) => {
    const others = selections.filter(
      (s) => !(s.group_id === group.id && (group.max === 1 || s.option_id === id)),
    );
    setSelections(
      quantity > 0 ? [...others, { group_id: group.id, option_id: id, quantity }] : others,
    );
  };
  const options = group.options.slice(0, limit);
  const quantityOf = (id: string) =>
    selections.find((s) => s.group_id === group.id && s.option_id === id)?.quantity ?? 0;
  const extras = group.min === 0 && group.max > 1;
  const visual = group.options.some((o) => optionPhoto(o.id) || heinzColor(o.id));
  const drinks = group.id === 'drink';
  const columns = visual ? (drinks ? 5 : 4) : Math.min(4, Math.max(2, options.length));
  return (
    <View ref={target} collapsable={false} style={{ gap: v(16) }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: v(12),
        }}
      >
        <Text
          {...fixedText}
          accessibilityRole="header"
          style={{
            flexShrink: 1,
            fontFamily: fonts.black,
            fontSize: v(27),
            color: colors.white,
          }}
        >
          {group.title}
        </Text>
        <GroupChip
          group={group}
          options={group.options}
          selections={selections}
          total={total}
          locale={locale}
        />
      </View>
      {extras ? (
        <Animated.View style={{ gap: v(10), transform: [{ translateX: shake }] }}>
          {options.map((option, index) => (
            <ExtraRow
              key={option.id}
              group={group}
              option={option}
              index={index}
              quantity={quantityOf(option.id)}
              total={total}
              locale={locale}
              update={update}
            />
          ))}
        </Animated.View>
      ) : (
        <Animated.View style={{ gap: v(12), transform: [{ translateX: shake }] }}>
          {rows(options, columns).map((row, r) => (
            <View key={r} style={{ flexDirection: 'row', gap: v(12) }}>
              {row.map((option, i) => (
                <OptionTile
                  key={option.id}
                  group={group}
                  option={option}
                  index={r * columns + i}
                  quantity={quantityOf(option.id)}
                  total={total}
                  drinks={drinks}
                  visual={visual}
                  locale={locale}
                  update={update}
                />
              ))}
              {Array.from({ length: columns - row.length }, (_, k) => (
                <View key={'gap' + k} style={{ flex: 1 }} />
              ))}
            </View>
          ))}
        </Animated.View>
      )}
    </View>
  );
}
