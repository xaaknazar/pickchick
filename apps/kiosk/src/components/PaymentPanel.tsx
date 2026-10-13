import { useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Locale } from '../i18n';
import type { KioskCartLine } from '../model';
import { productArtworkId } from '../assets';
import { paymentCopy } from '../paymentCopy';
import { orderSummary } from '../smartUpsell';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { useAnnounce } from './announce';
import { fixedText } from './Body';
import { GlassPanel } from './GlassPanel';
import { PhotoImage } from './PhotoImage';
import { useEnter, useLoop, usePress } from './motion';
/** Glass action inside the panel (88 high), like the upsell's «Без допов». */
function GlassAction({
  label,
  testID,
  disabled,
  onPress,
}: {
  label: string;
  testID: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { px } = useMetrics();
  const press = usePress(0.96);
  return (
    <Animated.View style={{ flexShrink: 1, minWidth: 0, transform: [{ scale: press.scale }] }}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={{
          minHeight: Math.max(56, px(88)),
          paddingHorizontal: px(24),
          paddingVertical: px(8),
          borderRadius: 999,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,.24)',
          backgroundColor: 'rgba(255,255,255,.14)',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.55 : 1,
        }}
      >
        <Text
          {...fixedText}
          numberOfLines={2}
          style={{
            fontFamily: fonts.heavy,
            fontSize: Math.max(16, px(20)),
            lineHeight: Math.max(20, px(25)),
            color: colors.white,
            textAlign: 'center',
          }}
        >
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
/**
 * Bottom panel of the Kaspi QR (kiosk redesign 2026-10-13, product-and-payment.md §4, 1024-pt
 * layout): a glass bar 16 from the sides and 22 from the bottom. On the left the round photos of
 * the order (61, overlapping by 14) and their names (15, 75 % white) over a green dot and «Ждём
 * оплату - экран обновится сам» (or «Проверяем оплату…» while a status read runs); VoiceOver
 * hears it change. On the right the glass «Начать заново» (owner decision 2026-10-13, only when
 * `restart`) and the glass action (`actionLabel`: «Позвать сотрудника»; the staff demo puts its
 * cancellation preview there). Long texts wrap; the panel grows rather than cutting them.
 */
export function PaymentPanel({
  lines,
  checking,
  busy,
  locale,
  restart,
  onRestart,
  actionLabel,
  onAction,
}: {
  lines: readonly Pick<KioskCartLine, 'lineId' | 'product' | 'selections' | 'quantity'>[];
  /** A status read is running. */
  checking: boolean;
  busy: boolean;
  locale: Locale;
  /** «Начать заново» is allowed now. */
  restart: boolean;
  onRestart: () => void;
  actionLabel: string;
  onAction: () => void;
}) {
  const { px, width } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = paymentCopy(locale);
  const rise = useEnter(120, 520);
  const halo = useLoop(2000, 0, true);
  const status = checking ? t.checking : t.waiting;
  useAnnounce(status);
  const unique = [...new Set(lines.map((line) => line.product.name))];
  const all = unique.join(', ');
  // The names take one line: the whole list when it fits the column (a conservative 0.6 em per
  // letter), otherwise «Pick Combo +2».
  const [column, setColumn] = useState(0);
  const nameSize = Math.max(13, px(15));
  const names =
    column && all.length * nameSize * 0.6 > column ? orderSummary(unique) : column ? all : '';
  // The 8.3-inch iPad keeps two photos so the actions keep their room.
  const shown = lines.slice(0, width < 900 ? 2 : 3);
  const thumb = Math.max(44, px(61));
  const dot = Math.max(10, px(14));
  return (
    <Animated.View
      style={{
        paddingTop: px(14),
        paddingBottom: Math.max(safe.bottom, px(22)),
        paddingLeft: Math.max(safe.left, px(16)),
        paddingRight: Math.max(safe.right, px(16)),
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [px(160), 0] }) },
        ],
      }}
    >
      <GlassPanel shape="bar" testID="kiosk-payment-panel">
        <View
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: px(115),
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: px(12),
            paddingLeft: px(20),
            paddingRight: px(13),
            gap: px(14),
          }}
        >
          {shown.length ? (
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ flexDirection: 'row' }}
            >
              {shown.map((line, index) => (
                <View
                  key={line.lineId}
                  style={{
                    width: thumb,
                    height: thumb,
                    marginLeft: index ? -px(14) : 0,
                    borderRadius: thumb / 2,
                    backgroundColor: colors.white,
                    borderWidth: Math.max(1, px(2)),
                    borderColor: 'rgba(255,255,255,.9)',
                    overflow: 'hidden',
                    padding: px(4),
                  }}
                >
                  <PhotoImage imageId={productArtworkId(line.product, line.selections)} />
                </View>
              ))}
            </View>
          ) : null}
          <View
            onLayout={(event) => setColumn(Math.round(event.nativeEvent.layout.width))}
            style={{ flex: 1, minWidth: px(120), gap: px(4) }}
          >
            {names ? (
              <Text
                {...fixedText}
                testID="kiosk-payment-items"
                numberOfLines={2}
                style={{
                  fontFamily: fonts.medium,
                  fontSize: nameSize,
                  lineHeight: Math.max(17, px(20)),
                  color: 'rgba(255,255,255,.75)',
                }}
              >
                {names}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(10) }}>
              <View style={{ width: dot, height: dot }}>
                <Animated.View
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: dot,
                    height: dot,
                    borderRadius: dot / 2,
                    backgroundColor: redesign.added,
                    opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
                    transform: [
                      { scale: halo.interpolate({ inputRange: [0, 1], outputRange: [1.6, 2.4] }) },
                    ],
                  }}
                />
                <View
                  style={{
                    width: dot,
                    height: dot,
                    borderRadius: dot / 2,
                    backgroundColor: redesign.added,
                    borderWidth: Math.max(1, px(2)),
                    borderColor: 'rgba(255,255,255,.85)',
                  }}
                />
              </View>
              <Text
                {...fixedText}
                testID="kiosk-payment-waiting-status"
                accessibilityLiveRegion="polite"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: fonts.medium,
                  fontSize: Math.max(14, px(18)),
                  lineHeight: Math.max(18, px(23)),
                  color: colors.white,
                }}
              >
                {status}
              </Text>
            </View>
          </View>
          {restart ? (
            <GlassAction
              testID="kiosk-payment-restart"
              label={t.startOver}
              disabled={busy}
              onPress={onRestart}
            />
          ) : null}
          <GlassAction
            testID="kiosk-payment-cancel"
            label={actionLabel}
            disabled={busy}
            onPress={onAction}
          />
        </View>
      </GlassPanel>
    </Animated.View>
  );
}
