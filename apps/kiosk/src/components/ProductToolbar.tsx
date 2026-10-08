import { Animated, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { IconButton } from './IconButton';
import { useEnter } from './motion';
/**
 * Floating v3 product controls over the photo: a white 72-pt close disc (a back arrow
 * on the second set step) and, inside the set wizard, a step pill beside it.
 */
export function ProductToolbar({
  locale,
  onClose,
  step,
  steps,
}: {
  locale: Locale;
  onClose: () => void;
  step?: number;
  steps?: number;
}) {
  const { v } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const enter = useEnter(120, 420);
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: safe.top + v(28),
        left: Math.max(safe.left, v(28)),
        right: Math.max(safe.right, v(28)),
        flexDirection: 'row',
        alignItems: 'center',
        gap: v(14),
      }}
    >
      <IconButton
        name={step === 2 ? 'arrow-back' : 'close'}
        label={t.close}
        tone="light"
        size="large"
        testID="kiosk-product-close"
        onPress={onClose}
      />
      {step ? (
        <Animated.View
          pointerEvents="none"
          style={{
            opacity: enter,
            transform: [
              { translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) },
            ],
            height: v(56),
            paddingHorizontal: v(20),
            borderRadius: 999,
            backgroundColor: 'rgba(4,20,58,.62)',
            borderWidth: 1,
            borderColor: colors.glassLine,
            justifyContent: 'center',
          }}
        >
          <Text
            numberOfLines={1}
            style={{ fontFamily: fonts.heavy, fontSize: Math.max(15, v(17)), color: colors.white }}
          >
            {step === 1 ? t.saucesTitle : t.extrasTitle}
            <Text style={{ fontFamily: fonts.medium, color: colors.onBlueMuted }}>
              {`  ·  ${t.step} ${step} / ${steps}`}
            </Text>
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}
