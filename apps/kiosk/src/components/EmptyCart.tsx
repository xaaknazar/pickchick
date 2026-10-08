import { Animated } from 'react-native';
import { Image } from 'expo-image';
import { copy, type Locale } from '../i18n';
import { assets } from '../assets';
import { useMetrics } from '../theme';
import { Heading, Wrapper } from './UI';
import { useEnter, useLoop } from './motion';
/** v3 empty cart on the blue surface: the assembling chef bobbing above white copy. */
export function EmptyCart({ locale }: { locale: Locale }) {
  const { v } = useMetrics();
  const enter = useEnter(80);
  const bob = useLoop(3200, 600, true);
  const size = v(260);
  return (
    <Wrapper paddingY={56} gap={20} align="center">
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: size,
          height: size,
          opacity: enter,
          transform: [
            { translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -v(12)] }) },
            { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
          ],
        }}
      >
        <Image
          accessible={false}
          accessibilityLabel=""
          source={assets.chefAssembly}
          contentFit="contain"
          style={{ width: '100%', height: '100%' }}
        />
      </Animated.View>
      <Wrapper maxWidth={size * 2.2}>
        <Heading size="section" align="center" tone="inverse">
          {copy(locale).empty}
        </Heading>
      </Wrapper>
    </Wrapper>
  );
}
