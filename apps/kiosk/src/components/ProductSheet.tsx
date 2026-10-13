import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { KioskProduct, KioskSelection } from '../model';
import { money } from '../cart';
import { displayCopy, type Locale } from '../i18n';
import { fitTitle } from '../menu-presentation';
import {
  initialSize,
  sheetFacts,
  sheetLineId,
  sheetRoom,
  sheetSelections,
  sheetSizeGroup,
  sheetUnitMinor,
} from '../productSheet';
import { sheetCopy } from '../sheetCopy';
import { cardBackgroundRatio, cardBackgrounds, productArtworkId, productPhoto } from '../assets';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { Icon } from './Icon';
import { PhotoImage } from './PhotoImage';
import { ownerOrange } from './ownerOrange';
import { useEnter, usePopIn, usePress } from './motion';

/** Darkening over the menu (as the option sheets of the product page): navy .6, blur 6 on web. */
const SCRIM = 'rgba(2,10,31,.6)';
/** Glass ✕ on the cream sheet: the design's grey disc (navy glass, a little denser than on blue). */
const CLOSE_GLASS = 'rgba(14,22,48,.56)';
const HANDLE = 'rgba(21,33,58,.2)';
/** Disabled add button (sold out, cart limit): grey under navy text. */
const DISABLED = '#D5DBE6';
/** The bg2 illustration spans 142 % of the sheet's width from its top-right corner (design). */
const ART_WIDTH = '142%';
/** bg2: the lines-and-stars illustration the design puts at the sheet's top right. */
const ART = 1;
/** A studio photo shot on (near) white multiplies onto the cream, as on the menu cards. */
const lightTile = (tile: string) =>
  /^#[0-9A-F]{6}$/i.test(tile) &&
  [1, 3, 5].every((at) => parseInt(tile.slice(at, at + 2), 16) >= 0xf0);

/**
 * Simple-product sheet over the menu (kiosk redesign 2026-10-13, product-and-payment.md §3,
 * `images/product-sauce-sheet.webp`, `images/product-simple-sheet.webp`); sizes in the 1024-pt
 * layout. A cream #FEF8F0 sheet (top radius 44) with the bg2 illustration at the top right
 * rises from the bottom over the darkened menu: a handle, the glass ✕ (62), the photo 340×300
 * on the left (multiplied onto the cream), and on the right the name (Montserrat 900 44, a
 * second line or a smaller size before it is cut), the description 19/27 and «60 г · 230 ккал ·
 * КБЖУ» from the catalog («КБЖУ» opens the protein, fat and carbs line). A product with a size
 * choice lists up to four white size tiles 96 high («60 мл / 390 ₸»), the chosen one with the
 * orange ring. At the bottom: the white quantity capsule (discs 72) and the orange 96-pt «В
 * корзину · 390 ₸» (price × quantity). The quantity stops at the cart's room for this line, and
 * the button tells why when there is none. Tapping the dimmed menu or ✕ closes the sheet.
 * Static under reduced motion.
 */
export function ProductSheet({
  product,
  locale,
  busy,
  cart,
  lineCount,
  onAdd,
  onClose,
  onInteraction,
}: {
  product: KioskProduct;
  locale: Locale;
  busy: boolean;
  /** The cart's lines (id and quantity): the add keeps to the cart's room for its line. */
  cart: readonly { lineId: string; quantity: number }[];
  /** Lines in the cart, stopped ones included (the cart holds 11 at most). */
  lineCount: number;
  /** The product page's add: these selections, this many. */
  onAdd: (selections: KioskSelection[], quantity: number) => void;
  onClose: () => void;
  /** Any tap inside (keeps the idle timer away). */
  onInteraction?: () => void;
}) {
  const { px, height } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = sheetCopy(locale);
  const shade = useEnter(0, 240, 'css');
  const rise = useEnter(0, 440);
  const distance = useRef(new Animated.Value(height)).current;
  const offset = useMemo(
    () => Animated.multiply(Animated.subtract(1, rise), distance),
    [distance, rise],
  );
  const group = sheetSizeGroup(product);
  const [picked, setPicked] = useState(() => initialSize(group));
  // A size stopped while the sheet is open gives way to the default (or first) available one.
  const size = group?.options.some((o) => o.id === picked && o.available)
    ? picked
    : initialSize(group);
  const [quantity, setQuantity] = useState(1);
  const [macros, setMacros] = useState(false);
  const { room, limit } = sheetRoom(sheetLineId(product, size), cart, lineCount);
  const shown = Math.max(1, Math.min(quantity, room));
  const unit = sheetUnitMinor(product, size);
  const available = product.available !== false && (!group || size !== null);
  const blocked = !available || !!limit;
  const label = !available
    ? t.unavailable
    : limit
      ? limit === 'line'
        ? t.limitLine
        : t.limitLines
      : `${t.toCart} · ${money((BigInt(unit) * BigInt(shown)).toString())}`;
  const facts = sheetFacts(product, size);
  const factParts = [
    facts.serving,
    facts.kcal === null ? null : `${facts.kcal} ${t.kcal}` + (facts.per100g ? ` ${t.per100g}` : ''),
  ].filter((part): part is string => !!part);
  const touch = () => onInteraction?.();
  const close = () => {
    touch();
    onClose();
  };
  const [column, setColumn] = useState(0);
  const title = fitTitle(product.name, column, px(44), px(44) * 0.8, 2);
  const imageId = productArtworkId(product);
  const shot = productPhoto(imageId);
  const blend = !shot || lightTile(shot.tile);
  const inset = Math.max(safe.bottom, px(28));
  const glass = (
    Platform.OS === 'web'
      ? {
          backdropFilter: 'blur(18px) saturate(150%)',
          WebkitBackdropFilter: 'blur(18px) saturate(150%)',
          boxShadow: `inset 0 1px 0 ${redesign.glassHighlight}, 0 ${px(10)}px ${px(30)}px ${redesign.glassShadow}`,
        }
      : {}
  ) as ViewStyle;
  const blur = (
    Platform.OS === 'web' ? { backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' } : {}
  ) as ViewStyle;
  const lift = (
    Platform.OS === 'web'
      ? { boxShadow: `0 -${px(10)}px ${px(40)}px rgba(2,10,31,.28)` }
      : {
          shadowColor: '#020A1F',
          shadowOpacity: 0.28,
          shadowRadius: px(20),
          shadowOffset: { width: 0, height: -px(10) },
        }
  ) as ViewStyle;
  return (
    // Modal for VoiceOver: the menu behind (the layer's siblings) is out of reach while open.
    <View
      style={StyleSheet.absoluteFill}
      testID="kiosk-product-sheet-layer"
      accessibilityViewIsModal
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM, opacity: shade }, blur]}
      />
      <Pressable
        testID="kiosk-sheet-scrim"
        accessible={false}
        importantForAccessibility="no"
        tabIndex={-1}
        onPress={close}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View
        testID="kiosk-product-sheet"
        accessibilityLabel={t.sheet}
        onTouchStart={touch}
        onLayout={(event) => distance.setValue(event.nativeEvent.layout.height)}
        style={[
          {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            borderTopLeftRadius: px(44),
            borderTopRightRadius: px(44),
            backgroundColor: redesign.cream,
            transform: [{ translateY: offset }],
          },
          lift,
        ]}
      >
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { borderTopLeftRadius: px(44), borderTopRightRadius: px(44), overflow: 'hidden' },
          ]}
        >
          <Image
            accessible={false}
            accessibilityLabel=""
            source={cardBackgrounds[ART]}
            contentFit="cover"
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              width: ART_WIDTH,
              aspectRatio: cardBackgroundRatio,
            }}
          />
          {/* A direct layer of the clip, so its multiply sees the cream and the illustration
              (every web view is its own stacking context). */}
          <View
            style={{
              position: 'absolute',
              left: px(30),
              top: px(40),
              width: px(340),
              height: px(300),
              overflow: 'hidden',
              borderRadius: blend ? 0 : px(28),
              backgroundColor: blend ? 'transparent' : (shot?.tile ?? redesign.cream),
              mixBlendMode: blend ? 'multiply' : 'normal',
              opacity: product.available === false ? 0.5 : 1,
            }}
          >
            <PhotoImage imageId={imageId} />
          </View>
        </View>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: px(18),
            alignSelf: 'center',
            width: px(84),
            height: Math.max(5, px(7)),
            borderRadius: 999,
            backgroundColor: HANDLE,
          }}
        />
        <View
          style={{
            paddingTop: px(40),
            paddingLeft: px(30),
            paddingRight: px(30),
            paddingBottom: inset,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(26) }}>
            {/* The photo itself is drawn in the illustration layer; this keeps its place. */}
            <View style={{ width: px(340), height: px(300), alignSelf: 'flex-start' }} />
            <View
              onLayout={(event) => setColumn(event.nativeEvent.layout.width)}
              style={{ flex: 1, minWidth: 0, paddingRight: px(48), gap: px(10) }}
            >
              <Text
                {...fixedText}
                testID="kiosk-sheet-name"
                accessibilityRole="header"
                numberOfLines={title.lines}
                style={{
                  fontFamily: fonts.black,
                  fontSize: title.size,
                  lineHeight: Math.round(title.size * 1.14),
                  letterSpacing: -0.4,
                  color: redesign.cardInk,
                }}
              >
                {displayCopy(product.name)}
              </Text>
              {product.description ? (
                <Text
                  {...fixedText}
                  numberOfLines={3}
                  style={{
                    fontFamily: fonts.body,
                    fontSize: Math.max(15, px(19)),
                    lineHeight: Math.max(21, px(27)),
                    color: redesign.cardMuted,
                  }}
                >
                  {displayCopy(product.description)}
                </Text>
              ) : null}
              {factParts.length || facts.macros ? (
                <View
                  testID="kiosk-sheet-facts"
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    columnGap: Math.max(3, px(5)),
                  }}
                >
                  {factParts.length ? (
                    <Text
                      {...fixedText}
                      style={{
                        fontFamily: fonts.body,
                        fontSize: Math.max(13, px(16)),
                        lineHeight: Math.max(20, px(24)),
                        color: redesign.cardMuted,
                      }}
                    >
                      {factParts.join(' · ') + (facts.macros ? ' ·' : '')}
                    </Text>
                  ) : null}
                  {facts.macros ? (
                    <Pressable
                      testID="kiosk-sheet-kbju"
                      accessibilityRole="button"
                      accessibilityLabel={macros ? t.hideNutrition : t.nutrition}
                      accessibilityState={{ expanded: macros }}
                      aria-expanded={macros}
                      hitSlop={px(12)}
                      onPress={() => {
                        touch();
                        setMacros((open) => !open);
                      }}
                    >
                      <Text
                        {...fixedText}
                        style={{
                          fontFamily: fonts.medium,
                          fontSize: Math.max(13, px(16)),
                          lineHeight: Math.max(20, px(24)),
                          color: redesign.cardMuted,
                          textDecorationLine: 'underline',
                        }}
                      >
                        {t.nutrition}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
              {macros && facts.macros ? (
                <Text
                  {...fixedText}
                  testID="kiosk-sheet-macros"
                  style={{
                    fontFamily: fonts.body,
                    fontSize: Math.max(13, px(16)),
                    lineHeight: Math.max(20, px(24)),
                    color: redesign.cardInk,
                  }}
                >
                  {[
                    `${t.protein} ${facts.macros.protein} ${t.grams}`,
                    `${t.fat} ${facts.macros.fat} ${t.grams}`,
                    `${t.carbs} ${facts.macros.carbs} ${t.grams}`,
                  ].join(' · ')}
                </Text>
              ) : null}
            </View>
          </View>
          {group ? (
            <View style={{ marginTop: px(10), gap: px(16) }}>
              <Text
                {...fixedText}
                accessibilityRole="header"
                style={{
                  fontFamily: fonts.black,
                  fontSize: Math.max(18, px(24)),
                  lineHeight: Math.max(24, px(30)),
                  color: redesign.cardInk,
                }}
              >
                {t.size}
              </Text>
              <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: px(12) }}>
                {Array.from({ length: 4 }, (_, index) => {
                  const option = group.options[index];
                  return option ? (
                    <SizeTile
                      key={option.id}
                      id={option.id}
                      label={option.label}
                      price={money(
                        (BigInt(product.price_minor) + BigInt(option.price_delta_minor)).toString(),
                      )}
                      selected={option.id === size}
                      available={option.available}
                      onPress={() => {
                        touch();
                        setPicked(option.id);
                      }}
                    />
                  ) : (
                    <View key={'slot-' + index} style={{ flex: 1 }} />
                  );
                })}
              </View>
            </View>
          ) : null}
          <View
            style={{
              marginTop: px(group ? 24 : 36),
              flexDirection: 'row',
              alignItems: 'center',
              gap: px(16),
            }}
          >
            <Quantity
              quantity={shown}
              max={Math.max(1, room)}
              busy={busy}
              minus={t.decrease}
              plus={t.increase}
              onMinus={() => {
                touch();
                setQuantity(Math.max(1, Math.min(quantity, room) - 1));
              }}
              onPlus={() => {
                touch();
                setQuantity(Math.min(room, shown + 1));
              }}
            />
            <AddButton
              label={label}
              disabled={blocked}
              busy={busy}
              onPress={() => {
                touch();
                onAdd(sheetSelections(product, size), shown);
              }}
            />
          </View>
        </View>
        <View style={{ position: 'absolute', top: px(32), right: px(26) }}>
          <Pressable
            testID="kiosk-sheet-close"
            accessibilityRole="button"
            accessibilityLabel={t.close}
            hitSlop={px(10)}
            onPress={close}
            style={[
              {
                width: Math.max(48, px(62)),
                height: Math.max(48, px(62)),
                borderRadius: 999,
                backgroundColor: CLOSE_GLASS,
                borderWidth: 1,
                borderColor: redesign.glassLine,
                alignItems: 'center',
                justifyContent: 'center',
              },
              glass,
            ]}
          >
            <Icon name="close" size="small" tone="inverse" />
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

/** White size tile 96 high: the size (Montserrat 800 24) over its price; chosen = orange ring. */
function SizeTile({
  id,
  label,
  price,
  selected,
  available,
  onPress,
}: {
  id: string;
  label: string;
  price: string;
  selected: boolean;
  available: boolean;
  onPress: () => void;
}) {
  const { px } = useMetrics();
  const press = usePress(0.96);
  const ring = Math.max(3, px(4));
  const soft = (
    Platform.OS === 'web'
      ? { boxShadow: `0 ${px(4)}px ${px(14)}px rgba(2,10,31,.06)` }
      : {
          shadowColor: '#020A1F',
          shadowOpacity: 0.06,
          shadowRadius: px(7),
          shadowOffset: { width: 0, height: px(4) },
        }
  ) as ViewStyle;
  return (
    <Animated.View style={{ flex: 1, minWidth: 0, transform: [{ scale: press.scale }] }}>
      <Pressable
        testID={'kiosk-sheet-size-' + id}
        accessibilityRole="radio"
        accessibilityLabel={`${label}, ${price}`}
        accessibilityState={{ checked: selected, disabled: !available }}
        aria-checked={selected}
        disabled={!available}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[
          {
            height: Math.max(72, px(96)),
            borderRadius: px(22),
            backgroundColor: colors.white,
            borderWidth: ring,
            borderColor: selected ? redesign.cta : colors.white,
            alignItems: 'center',
            justifyContent: 'center',
            gap: px(2),
            paddingHorizontal: px(8),
            opacity: available ? 1 : 0.5,
          },
          soft,
        ]}
      >
        <Text
          {...fixedText}
          numberOfLines={1}
          style={{
            fontFamily: fonts.heavy,
            fontSize: Math.max(18, px(24)),
            lineHeight: Math.max(23, px(30)),
            color: redesign.cardInk,
          }}
        >
          {label}
        </Text>
        <Text
          {...fixedText}
          numberOfLines={1}
          style={{
            fontFamily: fonts.body,
            fontSize: Math.max(12, px(15)),
            lineHeight: Math.max(16, px(20)),
            color: redesign.cardMuted,
            fontVariant: ['tabular-nums'],
          }}
        >
          {price}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/** White capsule: soft minus disc, the count (pops on change) and the orange plus disc, 72 each. */
function Quantity({
  quantity,
  max,
  busy,
  minus,
  plus,
  onMinus,
  onPlus,
}: {
  quantity: number;
  max: number;
  busy: boolean;
  minus: string;
  plus: string;
  onMinus: () => void;
  onPlus: () => void;
}) {
  const { px } = useMetrics();
  const pop = usePopIn(quantity, 300, 0, false);
  const disc = Math.max(56, px(72));
  const lift = (
    Platform.OS === 'web'
      ? { boxShadow: `0 ${px(8)}px ${px(22)}px rgba(2,10,31,.12)` }
      : {
          shadowColor: '#020A1F',
          shadowOpacity: 0.12,
          shadowRadius: px(11),
          shadowOffset: { width: 0, height: px(8) },
        }
  ) as ViewStyle;
  const button = (
    id: string,
    label: string,
    icon: 'remove' | 'add',
    disabled: boolean,
    onPress: () => void,
  ) => (
    <Disc
      id={id}
      label={label}
      icon={icon}
      size={disc}
      disabled={disabled}
      accent={icon === 'add'}
      onPress={onPress}
    />
  );
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: px(6),
          padding: px(6),
          borderRadius: 999,
          backgroundColor: colors.white,
        },
        lift,
      ]}
    >
      {button('kiosk-sheet-minus', minus, 'remove', quantity <= 1 || busy, onMinus)}
      <Animated.View
        style={{
          minWidth: px(44),
          alignItems: 'center',
          opacity: pop.opacity,
          transform: [{ scale: pop.scale }],
        }}
      >
        <Text
          {...fixedText}
          testID="kiosk-sheet-quantity"
          style={{
            fontFamily: fonts.black,
            fontSize: Math.max(22, px(28)),
            color: redesign.cardInk,
            fontVariant: ['tabular-nums'],
          }}
        >
          {quantity}
        </Text>
      </Animated.View>
      {button('kiosk-sheet-plus', plus, 'add', quantity >= max || busy, onPlus)}
    </View>
  );
}

function Disc({
  id,
  label,
  icon,
  size,
  disabled,
  accent,
  onPress,
}: {
  id: string;
  label: string;
  icon: 'remove' | 'add';
  size: number;
  disabled: boolean;
  accent: boolean;
  onPress: () => void;
}) {
  const press = usePress(0.9);
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <Pressable
        testID={id}
        {...(accent ? ownerOrange : {})}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: accent ? redesign.cta : colors.soft,
          // The minus keeps its soft disc at 1 (as on the product page); a full cart dims the plus.
          opacity: accent && disabled ? 0.4 : 1,
        }}
      >
        <Icon name={icon} tone={accent ? 'inverse' : 'navy'} />
      </Pressable>
    </Animated.View>
  );
}

/** Orange «В корзину · 390 ₸», 96 high; grey with the reason when it cannot add. */
function AddButton({
  label,
  disabled,
  busy,
  onPress,
}: {
  label: string;
  disabled: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const { px } = useMetrics();
  const press = usePress(0.98);
  const height = Math.max(64, px(96));
  const glow = (
    disabled
      ? {}
      : Platform.OS === 'web'
        ? { boxShadow: `0 ${px(10)}px ${px(26)}px ${redesign.ctaShadow}` }
        : {
            shadowColor: redesign.cta,
            shadowOpacity: 0.5,
            shadowRadius: px(13),
            shadowOffset: { width: 0, height: px(10) },
          }
  ) as ViewStyle;
  return (
    <Animated.View style={{ flex: 1, minWidth: 0, transform: [{ scale: press.scale }] }}>
      <Pressable
        testID="kiosk-sheet-add"
        {...(disabled ? {} : ownerOrange)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: disabled || busy, busy }}
        disabled={disabled || busy}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[
          {
            height,
            borderRadius: height / 2,
            paddingHorizontal: px(28),
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: disabled ? DISABLED : redesign.cta,
          },
          glow,
        ]}
      >
        <Text
          {...fixedText}
          numberOfLines={1}
          style={{
            fontFamily: fonts.black,
            fontSize: disabled ? Math.max(17, px(22)) : Math.max(22, px(30)),
            color: disabled ? redesign.cardInk : colors.white,
            opacity: busy ? 0 : 1,
            fontVariant: ['tabular-nums'],
          }}
        >
          {label}
        </Text>
        {busy ? (
          <View
            style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
          >
            <ActivityIndicator accessibilityLabel={label} color={colors.white} />
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
