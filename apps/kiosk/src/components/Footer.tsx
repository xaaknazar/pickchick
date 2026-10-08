import { useState, type ReactNode } from 'react';
import { Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, useMetrics } from '../theme';
import { useEnter } from './motion';
/**
 * v3 footers: `default` is the white rounded sheet, `brand` the blue action bar
 * with a hairline, `clear` sits directly on a blue screen. `entrance` slides the
 * sheet up from below as the screen opens (prototype `.cfoot` sheetUp, 520 ms);
 * it only moves, so its buttons take taps from the first frame.
 */
export function Footer({
  children,
  tone = 'default',
  testID,
  entrance = false,
}: {
  children?: ReactNode;
  tone?: 'default' | 'brand' | 'clear';
  testID?: string;
  entrance?: boolean;
}) {
  const { v } = useMetrics();
  const safe = useSafeAreaInsets();
  const sheet = tone === 'default';
  const rise = useEnter(0, entrance ? 520 : 0);
  const [height, setHeight] = useState(v(320));
  return (
    <Animated.View
      testID={testID}
      onLayout={entrance ? (event) => setHeight(event.nativeEvent.layout.height) : undefined}
      style={{
        paddingTop: v(sheet ? 22 : 18),
        paddingBottom: Math.max(safe.bottom, v(sheet ? 26 : 24)),
        paddingLeft: Math.max(safe.left, v(28)),
        paddingRight: Math.max(safe.right, v(28)),
        backgroundColor: sheet ? colors.white : tone === 'brand' ? colors.blue : 'transparent',
        borderTopLeftRadius: sheet ? v(36) : 0,
        borderTopRightRadius: sheet ? v(36) : 0,
        borderTopWidth: tone === 'brand' ? 1 : 0,
        borderColor: colors.glassLine,
        shadowColor: '#020A28',
        shadowOpacity: tone === 'clear' ? 0 : 0.28,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: -10 },
        elevation: tone === 'clear' ? 0 : 12,
        gap: v(16),
        transform: entrance
          ? [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }]
          : [],
      }}
    >
      {children}
    </Animated.View>
  );
}
