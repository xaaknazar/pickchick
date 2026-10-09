import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { KioskProduct } from '../model';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { checkoutCopy } from '../checkoutCopy';
import { productImage, productPhoto } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
/**
 * Design 05: the upsell lives inside the cart as a white card with an orange top
 * stripe, a title and a row of cream tiles; a product already in the cart gets a
 * green ring and "✓ Добавлен", the others "+ price".
 */
export function CartUpsell({
  products,
  addedIds,
  busy,
  locale,
  onAdd,
}: {
  products: KioskProduct[];
  addedIds: string[];
  busy: boolean;
  locale: Locale;
  onAdd: (p: KioskProduct) => void;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const c = checkoutCopy(locale);
  if (!products.length) return null;
  return (
    <View
      testID="kiosk-cart-upsell"
      style={{
        marginTop: v(8),
        borderRadius: v(32),
        backgroundColor: colors.white,
        borderTopWidth: v(6),
        borderTopColor: colors.orange,
        paddingHorizontal: v(16),
        paddingTop: v(18),
        paddingBottom: v(18),
        gap: v(16),
      }}
    >
      <View style={{ paddingHorizontal: v(6), gap: v(4) }}>
        <Text
          accessibilityRole="header"
          style={{
            fontFamily: fonts.black,
            fontSize: Math.max(24, v(27)),
            color: colors.navy,
          }}
        >
          {t.upsellTitle}
        </Text>
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: Math.max(16, v(18)),
            color: colors.muted,
          }}
        >
          {c.moreUp}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: v(12) }}>
        {products.map((p) => {
          const added = addedIds.includes(p.id);
          const photo = productPhoto(p.image_id) ?? {
            source: productImage(p.image_id),
            tile: colors.cream,
            cutout: false,
          };
          return (
            <Pressable
              key={p.id}
              testID={'kiosk-cart-upsell-' + p.id}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy, selected: added }}
              disabled={busy}
              onPress={() => onAdd(p)}
              style={{
                flexBasis: '22%',
                flexGrow: 1,
                minWidth: v(130),
                borderRadius: v(22),
                backgroundColor: colors.cream,
                borderWidth: 3,
                borderColor: added ? colors.ok : 'transparent',
                paddingTop: v(12),
                paddingHorizontal: v(10),
                paddingBottom: v(14),
                alignItems: 'center',
                gap: v(8),
              }}
            >
              <Image
                accessible={false}
                accessibilityLabel=""
                source={photo.source}
                contentFit="contain"
                style={{ width: '100%', height: v(96) }}
              />
              <Text
                numberOfLines={2}
                style={{
                  fontFamily: fonts.medium,
                  fontSize: Math.max(15, v(16)),
                  lineHeight: Math.max(19, v(20)),
                  color: colors.navy,
                  textAlign: 'center',
                }}
              >
                {p.name}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: v(4) }}>
                <Icon name={added ? 'checkmark' : 'add'} tone={added ? 'success' : 'deep'} />
                <Text
                  style={{
                    fontFamily: fonts.bold,
                    fontSize: Math.max(15, v(16)),
                    color: added ? colors.ok : colors.orangeInk,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {added ? c.added : money(p.price_minor)}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
