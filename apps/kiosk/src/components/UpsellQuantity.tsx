import { glassSurface } from './glassSurface';
import { Pressable, Text, View } from 'react-native';
import { copy, type Locale } from '../i18n';
import { fonts, redesign, useMetrics } from '../theme';
import { Icon } from './Icon';
import { fixedText } from './Body';
import { ownerOrange } from './ownerOrange';

/** Kept outside the card's press target: quantity taps never also open its size sheet. */
export function UpsellQuantity({
  productId,
  detail,
  name,
  quantity,
  busy,
  increaseDisabled = false,
  locale,
  onIncrease,
  onDecrease,
}: {
  productId: string;
  detail?: string;
  name: string;
  quantity: number;
  busy: boolean;
  increaseDisabled?: boolean;
  locale: Locale;
  onIncrease: () => void;
  onDecrease: () => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const side = Math.max(48, px(52));
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: px(10),
        paddingHorizontal: px(18),
        paddingVertical: px(10),
      }}
    >
      {detail ? (
        <Text
          {...fixedText}
          numberOfLines={2}
          style={{
            flex: 1,
            fontFamily: fonts.medium,
            fontSize: Math.max(13, px(16)),
            color: redesign.cardMuted,
          }}
        >
          {detail}
        </Text>
      ) : null}
      <Pressable
        testID={'kiosk-upsell-minus-' + productId}
        accessibilityRole="button"
        accessibilityLabel={t.removeOne + ': ' + name}
        disabled={busy || quantity === 0}
        accessibilityState={{ disabled: busy || quantity === 0 }}
        onPress={onDecrease}
        style={{
          width: side,
          height: side,
          borderRadius: side / 2,
          alignItems: 'center',
          justifyContent: 'center',
          ...glassSurface('brand'),
          opacity: quantity === 0 ? 0.45 : 1,
        }}
      >
        <Icon name="remove" tone="inverse" />
      </Pressable>
      <Text
        {...fixedText}
        testID={'kiosk-upsell-quantity-' + productId}
        accessibilityLiveRegion="polite"
        style={{
          minWidth: px(34),
          textAlign: 'center',
          fontFamily: fonts.black,
          fontSize: px(27),
          color: redesign.cardInk,
          fontVariant: ['tabular-nums'],
        }}
      >
        {quantity}
      </Text>
      <Pressable
        {...ownerOrange}
        testID={'kiosk-upsell-plus-' + productId}
        accessibilityRole="button"
        accessibilityLabel={'+ ' + name}
        accessibilityState={{ disabled: busy || increaseDisabled }}
        disabled={busy || increaseDisabled}
        onPress={onIncrease}
        style={{
          width: side,
          height: side,
          borderRadius: side / 2,
          alignItems: 'center',
          justifyContent: 'center',
          ...glassSurface('accent'),
          opacity: busy || increaseDisabled ? 0.6 : 1,
        }}
      >
        <Icon name="add" tone="inverse" />
      </Pressable>
    </View>
  );
}
