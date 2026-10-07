import type { ReactNode } from 'react';
import { View } from 'react-native';
import { colors } from '../theme';
export function ScreenSurface({
  children,
  testID,
  tone = 'default',
  onTouchStart,
}: {
  children?: ReactNode;
  testID?: string;
  tone?: 'default' | 'brand' | 'dark';
  onTouchStart?: () => void;
}) {
  return (
    <View
      testID={testID}
      onTouchStart={onTouchStart}
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor:
          tone === 'brand' ? colors.blue : tone === 'dark' ? colors.dark : colors.background,
      }}
    >
      {children}
    </View>
  );
}
