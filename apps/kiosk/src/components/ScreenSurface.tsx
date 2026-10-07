import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { colors } from '../theme';
export function ScreenSurface({
  children,
  testID,
  tone = 'default',
  onTouchStart,
  keyboardAware = false,
}: {
  children?: ReactNode;
  testID?: string;
  tone?: 'default' | 'brand' | 'dark';
  onTouchStart?: () => void;
  keyboardAware?: boolean;
}) {
  const surface = (
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
  return keyboardAware ? (
    <KeyboardAvoidingView
      style={{ flex: 1, minHeight: 0 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {surface}
    </KeyboardAvoidingView>
  ) : (
    surface
  );
}
