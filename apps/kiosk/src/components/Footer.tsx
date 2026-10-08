import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, useMetrics } from '../theme';
/**
 * v3 footers: `default` is the white rounded sheet, `brand` the blue action bar
 * with a hairline, `clear` sits directly on a blue screen.
 */
export function Footer({
  children,
  tone = 'default',
  testID,
}: {
  children?: ReactNode;
  tone?: 'default' | 'brand' | 'clear';
  testID?: string;
}) {
  const { v } = useMetrics();
  const safe = useSafeAreaInsets();
  const sheet = tone === 'default';
  return (
    <View
      testID={testID}
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
      }}
    >
      {children}
    </View>
  );
}
