import { Animated, Pressable, Text, View } from 'react-native';
import { PhotoImage } from './PhotoImage';
import type { KioskCartLine } from '../model';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { heroPhoto, productImage, productPhoto, productArtworkId, type Photo } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { inCategory } from './categories';
import { usePop, useStagger } from './motion';
/** One line per chosen option, in the same wording as the summary ("Соус × 2"). */
function selectionLines(line: KioskCartLine) {
  return line.selections
    .map((selection) => {
      const option = line.product.modifier_groups
        .find((g) => g.id === selection.group_id)
        ?.options.find((o) => o.id === selection.option_id);
      return option
        ? `${option.label}${selection.quantity > 1 ? ` × ${selection.quantity}` : ''}`
        : '';
    })
    .filter(Boolean);
}
/**
 * v3 cart line: white 30-pt card, 140-pt photo tile (blue studio shot for combos,
 * duos and sets), name, chosen options with blue checks, remove capsule, the line
 * total and a soft capsule stepper (white minus, orange plus). Rows rise in stagger.
 */
export function CartRow({
  line,
  locale,
  busy,
  onQuantity,
  position = 0,
}: {
  line: KioskCartLine;
  locale: Locale;
  busy: boolean;
  onQuantity: (quantity: number) => void;
  position?: number;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const rise = useStagger(position);
  const tick = usePop(line.quantity);
  const product = line.product;
  const set = !inCategory(product, 'extras');
  const imageId = productArtworkId(product, line.selections);
  const photo: Photo = (set ? heroPhoto(imageId) : productPhoto(imageId)) ?? {
    source: productImage(imageId),
    tile: colors.cream,
    cutout: false,
  };
  const options = selectionLines(line);
  const prefix = 'kiosk-cart-line-' + line.lineId;
  const max = 20;
  const step = Math.max(48, v(54));
  return (
    <Animated.View
      testID={prefix}
      style={{
        opacity: rise,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(34), 0] }) },
          { scale: rise.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
        ],
        borderRadius: v(30),
        backgroundColor: colors.white,
        shadowColor: '#020A28',
        shadowOpacity: 0.22,
        shadowRadius: 28,
        shadowOffset: { width: 0, height: 12 },
        elevation: 6,
        padding: v(16),
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: v(20),
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: v(140),
          height: v(140),
          borderRadius: v(22),
          backgroundColor: photo.tile,
          padding: photo.cutout ? v(12) : 0,
          overflow: 'hidden',
        }}
      >
        <PhotoImage imageId={imageId} variant={set ? 'cart' : 'card'} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: v(8), paddingVertical: v(4) }}>
        <Text
          accessibilityRole="header"
          style={{
            fontFamily: fonts.heavy,
            fontSize: v(25),
            lineHeight: v(29),
            letterSpacing: -0.2,
            color: colors.navy,
          }}
        >
          {product.name}
        </Text>
        {options.length ? (
          <View style={{ gap: v(4) }}>
            {options.map((option, index) => (
              <View
                key={option + index}
                style={{ flexDirection: 'row', alignItems: 'center', gap: v(8) }}
              >
                <Icon name="checkmark" size="small" tone="brand" />
                <Text
                  style={{
                    flexShrink: 1,
                    fontFamily: fonts.body,
                    fontSize: Math.max(15, v(16)),
                    lineHeight: Math.max(20, v(20)),
                    color: colors.muted,
                  }}
                >
                  {option}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.remove}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => onQuantity(0)}
          style={({ pressed }) => ({
            marginTop: 'auto',
            alignSelf: 'flex-start',
            minHeight: Math.max(44, v(46)),
            paddingLeft: v(12),
            paddingRight: v(16),
            borderRadius: 999,
            borderWidth: 2,
            borderColor: '#E3E9F5',
            flexDirection: 'row',
            alignItems: 'center',
            gap: v(8),
            opacity: busy ? 0.45 : 1,
            transform: [{ scale: pressed ? 0.95 : 1 }],
          })}
        >
          <Icon name="trash-outline" size="small" tone="accent" />
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: Math.max(15, v(16)),
              color: colors.navy,
            }}
          >
            {t.remove}
          </Text>
        </Pressable>
      </View>
      <View
        style={{
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: v(12),
          paddingTop: v(6),
          paddingRight: v(4),
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            fontFamily: fonts.black,
            fontSize: v(27),
            letterSpacing: -0.3,
            color: colors.navy,
            fontVariant: ['tabular-nums'],
          }}
        >
          {money(line.lineTotalMinor)}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: v(6),
            padding: v(5),
            borderRadius: 999,
            backgroundColor: colors.soft,
          }}
        >
          <Pressable
            testID={prefix + '-minus'}
            accessibilityRole="button"
            accessibilityLabel={locale === 'ru' ? 'Уменьшить количество' : 'Санын азайту'}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => onQuantity(line.quantity - 1)}
            style={({ pressed }) => ({
              width: step,
              height: step,
              borderRadius: step / 2,
              backgroundColor: colors.white,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: busy ? 0.35 : 1,
              transform: [{ scale: pressed ? 0.9 : 1 }],
            })}
          >
            <Icon name="remove" tone="navy" />
          </Pressable>
          <Animated.Text
            testID={prefix + '-quantity'}
            style={{
              minWidth: v(30),
              textAlign: 'center',
              fontFamily: fonts.black,
              fontSize: v(23),
              color: colors.navy,
              fontVariant: ['tabular-nums'],
              transform: [{ scale: tick }],
            }}
          >
            {line.quantity}
          </Animated.Text>
          <Pressable
            testID={prefix + '-plus'}
            accessibilityRole="button"
            accessibilityLabel={locale === 'ru' ? 'Увеличить количество' : 'Санын көбейту'}
            accessibilityState={{ disabled: busy || line.quantity >= max }}
            disabled={busy || line.quantity >= max}
            onPress={() => onQuantity(line.quantity + 1)}
            style={({ pressed }) => ({
              width: step,
              height: step,
              borderRadius: step / 2,
              backgroundColor: colors.orange,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: busy || line.quantity >= max ? 0.35 : 1,
              transform: [{ scale: pressed ? 0.9 : 1 }],
            })}
          >
            <Icon name="add" tone="inverse" />
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}
