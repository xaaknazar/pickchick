import { Animated, Pressable, Text, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Icon } from './Icon';
import { usePop, useStagger } from './motion';
import type { KioskPaymentMethod } from '../model';
import { fixedText } from './Body';
/**
 * v3 payment choice: white 28-pt card with a method tile (orange QR, blue phone
 * invoice, soft card), title and explanation. Selected = orange ring + check pop.
 */
export function PaymentMethodCard({
  method,
  selected,
  busy,
  commercial,
  locale,
  onSelect,
  position = 0,
}: {
  method: KioskPaymentMethod;
  selected: boolean;
  busy: boolean;
  commercial: boolean;
  locale: Locale;
  onSelect: () => void;
  position?: number;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const rise = useStagger(position + 2);
  const pop = usePop(selected);
  const invoice = method === 'kaspi_invoice';
  const title = invoice
    ? t.invoiceTitle
    : method === 'kaspi'
      ? commercial
        ? t.payQR
        : 'Kaspi'
      : t.card;
  const description = commercial
    ? invoice
      ? t.invoiceDescription
      : t.qrDescription
    : method === 'kaspi'
      ? t.testKaspiDescription
      : t.testCardDescription;
  const tile = Math.max(56, v(72));
  const check = Math.max(30, v(36));
  return (
    <Animated.View
      style={{
        opacity: rise,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(22), 0] }) },
        ],
      }}
    >
      <Pressable
        testID={'kiosk-payment-method-' + method}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected, disabled: busy }}
        aria-checked={selected}
        disabled={busy}
        onPress={onSelect}
        style={({ pressed }) => ({
          borderRadius: v(28),
          backgroundColor: colors.white,
          shadowColor: '#020A28',
          shadowOpacity: selected ? 0.3 : 0.18,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 10 },
          elevation: 5,
          paddingVertical: v(18),
          paddingLeft: v(18),
          paddingRight: v(22),
          flexDirection: 'row',
          alignItems: 'center',
          gap: v(18),
          opacity: busy ? 0.7 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        })}
      >
        <View
          style={{
            width: tile,
            height: tile,
            borderRadius: v(22),
            backgroundColor:
              method === 'kaspi' ? colors.orange : invoice ? colors.blue : colors.soft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name={
              invoice
                ? 'phone-portrait-outline'
                : method === 'kaspi'
                  ? 'qr-code-outline'
                  : 'card-outline'
            }
            tone={method === 'card' ? 'brand' : 'inverse'}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: v(4) }}>
          <Text
            {...fixedText}
            accessibilityRole="header"
            style={{
              fontFamily: fonts.black,
              fontSize: v(24),
              lineHeight: v(29),
              letterSpacing: -0.3,
              color: colors.navy,
            }}
          >
            {title}
          </Text>
          <Text
            {...fixedText}
            style={{
              fontFamily: fonts.body,
              fontSize: Math.max(15, v(16)),
              lineHeight: Math.max(20, v(21)),
              color: colors.muted,
            }}
          >
            {description}
          </Text>
        </View>
        <Animated.View
          style={{
            width: check,
            height: check,
            borderRadius: check / 2,
            borderWidth: selected ? 0 : 2.5,
            borderColor: '#C9D2E3',
            backgroundColor: selected ? colors.orange : colors.white,
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ scale: pop }],
          }}
        >
          {selected ? <Icon name="checkmark" size="small" tone="inverse" /> : null}
        </Animated.View>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            borderRadius: v(28),
            borderWidth: 4,
            borderColor: selected ? colors.orange : 'transparent',
          }}
        />
      </Pressable>
    </Animated.View>
  );
}
