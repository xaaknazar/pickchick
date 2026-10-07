import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, useMetrics } from '../theme';
export function Footer({
  children,
  tone = 'default',
  testID,
}: {
  children?: ReactNode;
  tone?: 'default' | 'brand';
  testID?: string;
}) {
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  return (
    <View
      testID={testID}
      style={{
        paddingTop: px(20),
        paddingBottom: Math.max(safe.bottom, px(24)),
        paddingLeft: Math.max(safe.left, px(28)),
        paddingRight: Math.max(safe.right, px(28)),
        backgroundColor: tone === 'brand' ? colors.blue : colors.white,
        borderTopWidth: tone === 'brand' ? 0 : 1,
        borderColor: colors.border,
        gap: px(18),
      }}
    >
      {children}
    </View>
  );
}
