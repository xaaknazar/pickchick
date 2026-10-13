import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import type { KioskModifierGroup } from '../model';
import { money } from '../cart';
import { heinzColor, heinzInk, optionPhoto } from '../assets';
import { copy, type Locale } from '../i18n';
import { optionText } from '../product-presentation';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { Icon } from './Icon';
import { PhotoImage } from './PhotoImage';
import { useEnter, usePopIn, usePress, usePulse, useShake, useTimingTo } from './motion';
import { ownerOrange } from './ownerOrange';
import { fixedText } from './Body';
type Option = KioskModifierGroup['options'][number];
/** Design colours of the option tile (product-and-payment.md §1). */
const INCLUDED = '#2E9E5B';
const SURCHARGE_FILL = '#FFE7D6';
const SURCHARGE_INK = '#B84500';
const SOLD_OUT = '#8A93A6';
/** A studio photo on a near-white backdrop (#FEFAF6 and the like). */
const lightTile = (tile: string) =>
  /^#[0-9A-F]{6}$/i.test(tile) &&
  [1, 3, 5].every((at) => parseInt(tile.slice(at, at + 2), 16) >= 0xf0);
/** Keeps a volume or weight with its number on one line ("0.5 л" never breaks at л). */
const glue = (text: string) =>
  text.replace(/(\d)\s+(мл|л|г|кг|шт|ml|l|g|kg|pcs)(?=$|[\s,.)])/giu, '$1\u00A0$2');
/** Mark of an option without a photo: Heinz in its colour, anything else its first word. */
function OptionMark({ id, name }: { id: string; name: string }) {
  const { px } = useMetrics();
  const heinz = heinzColor(id);
  const word = heinz ? 'Heinz' : (name.split(' ')[0] ?? name).slice(0, 8);
  return (
    <View
      style={{
        height: '100%',
        maxHeight: px(92),
        aspectRatio: 1,
        borderRadius: 999,
        backgroundColor: heinz ?? colors.sky,
        alignItems: 'center',
        justifyContent: 'center',
        borderBottomWidth: px(4),
        borderColor: 'rgba(0,0,0,.12)',
      }}
    >
      <Text
        {...fixedText}
        numberOfLines={1}
        style={{
          fontFamily: fonts.black,
          fontSize: px(20),
          color: heinz ? heinzInk(id) : colors.blue,
        }}
      >
        {word}
      </Text>
    </View>
  );
}
/**
 * Option tile of the product card and the option sheet (kiosk redesign 2026-10-13,
 * product-and-payment.md §1): a white tile (radius 24; 172 high for drinks, 164 otherwise; a
 * photo shot on a near-white backdrop lends the tile that backdrop) with the photo (contain) on
 * top, the short name in Montserrat 800 15, its caption 13 #55617A and the status: «Входит в
 * комбо» in green #2E9E5B, a surcharge pill «+200 ₸» (#FFE7D6 / #B84500) or «Нет в наличии» (the
 * tile at .5 and not pressable). A pick shows the 4-pt #FF6900 ring around the tile and the
 * orange check disc at the top right; in a group of several picks the disc counts them and a
 * white minus disc takes one back. An option without a photo shows a 92-pt colour disc with its
 * short name (Heinz sauces).
 */
export function ComboOptionTile({
  groupId,
  option,
  quantity,
  multi,
  full,
  clearable,
  included,
  tall = false,
  index = 0,
  locale,
  onChange,
}: {
  groupId: string;
  option: Option;
  /** Units of this option picked now. */
  quantity: number;
  /** The group takes several picks: a tap adds one, the minus disc takes one back. */
  multi: boolean;
  /** No more of this option fits (its own limit or the group's): a tap only shakes. */
  full: boolean;
  /** A single pick may be taken back by a second tap (an optional group). */
  clearable: boolean;
  /** Status of a free option («Входит в комбо»). */
  included: string;
  /** Drinks: the 172-pt tile of the five-column grid. */
  tall?: boolean;
  /** Position, for the entrance cascade. */
  index?: number;
  locale: Locale;
  onChange: (quantity: number) => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const text = optionText(option.label);
  const name = text.name || option.label;
  const photo = optionPhoto(option.id);
  // A photo shot on a light backdrop gives the tile that backdrop, so no box shows around it
  // (multiplying it onto pure white would keep the box); cut-outs stay on white.
  const fill = photo && !photo.cutout && lightTile(photo.tile) ? photo.tile : colors.white;
  const selected = quantity > 0;
  const surcharge = BigInt(option.price_delta_minor) > 0n;
  const enter = useEnter(120 + Math.min(index, 12) * 24, 420);
  const ring = useTimingTo(selected ? 1 : 0, 160, 'css');
  const check = usePopIn(selected ? quantity : 0, 380);
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
  const [refused, setRefused] = useState(0);
  const shake = useShake(refused);
  const fade = useMemo(
    () => Animated.multiply(enter, option.available ? 1 : 0.5),
    [enter, option.available],
  );
  const radius = px(24);
  const status = !option.available
    ? t.unavailableShort
    : surcharge
      ? '+' + money(option.price_delta_minor)
      : included;
  const body = (
    <>
      <View
        style={{
          flex: 1,
          minHeight: px(44),
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {photo ? (
          <PhotoImage imageId={option.id} variant="option" />
        ) : (
          <OptionMark id={option.id} name={name} />
        )}
      </View>
      <View style={{ gap: px(2), marginTop: px(6) }}>
        <Text
          {...fixedText}
          numberOfLines={2}
          style={{
            fontFamily: fonts.heavy,
            fontSize: px(15),
            lineHeight: px(19),
            color: redesign.cardInk,
          }}
        >
          {glue(name)}
        </Text>
        {text.caption ? (
          <Text
            {...fixedText}
            numberOfLines={1}
            style={{
              fontFamily: fonts.body,
              fontSize: px(13),
              lineHeight: px(17),
              color: redesign.cardMuted,
            }}
          >
            {glue(text.caption)}
          </Text>
        ) : null}
      </View>
      <View style={{ height: px(26), marginTop: px(6), justifyContent: 'center' }}>
        {option.available && surcharge ? (
          <View
            style={{
              alignSelf: 'flex-start',
              height: px(26),
              paddingHorizontal: px(10),
              borderRadius: 999,
              backgroundColor: SURCHARGE_FILL,
              justifyContent: 'center',
            }}
          >
            <Text
              {...fixedText}
              numberOfLines={1}
              style={{
                fontFamily: fonts.heavy,
                fontSize: px(13),
                color: SURCHARGE_INK,
                fontVariant: ['tabular-nums'],
              }}
            >
              {status}
            </Text>
          </View>
        ) : (
          <Text
            {...fixedText}
            numberOfLines={1}
            style={{
              fontFamily: fonts.bold,
              fontSize: px(13),
              lineHeight: px(17),
              color: option.available ? INCLUDED : SOLD_OUT,
            }}
          >
            {status}
          </Text>
        )}
      </View>
    </>
  );
  const surface = {
    flex: 1,
    borderRadius: radius,
    backgroundColor: fill,
    paddingTop: px(10),
    paddingHorizontal: px(14),
    paddingBottom: px(12),
    shadowColor: '#020A1F',
    shadowOpacity: 0.16,
    shadowRadius: px(9),
    shadowOffset: { width: 0, height: px(6) },
  };
  const label = [name, text.caption, status].filter(Boolean).join(', ');
  return (
    <Animated.View
      style={{
        flex: 1,
        minWidth: 0,
        height: px(tall ? 172 : 164),
        opacity: fade,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          { translateX: shake },
          { scale },
        ],
      }}
    >
      {multi ? (
        <View testID={`kiosk-modifier-${groupId}-${option.id}`} style={{ flex: 1 }}>
          <Pressable
            testID={`kiosk-modifier-plus-${groupId}-${option.id}`}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: !option.available || full }}
            disabled={!option.available || full}
            onPress={() => onChange(quantity + 1)}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            style={surface}
          >
            {body}
          </Pressable>
          {option.available && full ? (
            // Silent layer over a tile at its limit: a tap only shakes it.
            <Pressable
              accessible={false}
              importantForAccessibility="no"
              tabIndex={-1}
              onPress={() => setRefused((n) => n + 1)}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
        </View>
      ) : (
        <Pressable
          testID={`kiosk-modifier-${groupId}-${option.id}`}
          accessibilityRole="radio"
          accessibilityLabel={label}
          accessibilityState={{ checked: selected, disabled: !option.available }}
          aria-checked={selected}
          disabled={!option.available}
          onPress={() => onChange(selected && clearable ? 0 : 1)}
          onPressIn={press.onPressIn}
          onPressOut={press.onPressOut}
          style={surface}
        >
          {body}
        </Pressable>
      )}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -px(4),
          top: -px(4),
          right: -px(4),
          bottom: -px(4),
          borderRadius: radius + px(4),
          borderWidth: px(4),
          borderColor: redesign.cta,
          opacity: ring,
        }}
      />
      <Animated.View
        pointerEvents="none"
        {...ownerOrange}
        style={{
          position: 'absolute',
          top: px(10),
          right: px(10),
          width: px(32),
          height: px(32),
          borderRadius: px(16),
          backgroundColor: redesign.cta,
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: redesign.cta,
          shadowOpacity: selected ? 0.4 : 0,
          shadowRadius: px(6),
          shadowOffset: { width: 0, height: px(3) },
          opacity: selected ? check.opacity : 0,
          transform: [{ scale: check.scale }],
        }}
      >
        {multi ? (
          <Text
            {...fixedText}
            testID={`kiosk-modifier-quantity-${groupId}-${option.id}`}
            style={{
              fontFamily: fonts.black,
              fontSize: px(16),
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
      {multi ? (
        <Pressable
          testID={`kiosk-modifier-minus-${groupId}-${option.id}`}
          accessibilityRole="button"
          accessibilityLabel={'- ' + name}
          accessibilityState={{ disabled: quantity <= 0 }}
          disabled={quantity <= 0}
          onPress={() => onChange(quantity - 1)}
          hitSlop={px(8)}
          style={({ pressed }) => ({
            position: 'absolute',
            top: px(10),
            left: px(10),
            width: px(32),
            height: px(32),
            borderRadius: px(16),
            backgroundColor: colors.white,
            borderWidth: 1,
            borderColor: 'rgba(21,33,58,.12)',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: selected ? 1 : 0,
            transform: [{ scale: pressed ? 0.9 : 1 }],
          })}
        >
          <Icon name="remove" size="small" tone="navy" />
        </Pressable>
      ) : null}
    </Animated.View>
  );
}
