import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { fonts, tones, useMetrics, type Tone } from '../theme';
export interface BodyProps {
  children?: ReactNode;
  announce?: boolean;
  variant?: 'body' | 'caption' | 'label' | 'price';
  tone?: Tone;
  align?: 'left' | 'center' | 'right';
  lines?: number;
  testID?: string;
  accessibilityRole?: 'alert';
}
export function Body({
  children,
  announce = false,
  variant = 'body',
  tone = 'default',
  align = 'left',
  lines,
  testID,
  accessibilityRole,
}: BodyProps) {
  const { v } = useMetrics();
  const size =
    variant === 'caption' ? Math.max(15, v(15)) : variant === 'price' ? v(24) : Math.max(17, v(18));
  return (
    <Text
      accessibilityLiveRegion={announce ? 'polite' : undefined}
      testID={testID}
      accessibilityRole={accessibilityRole}
      numberOfLines={lines}
      style={{
        fontFamily:
          variant === 'price' ? fonts.black : variant === 'label' ? fonts.medium : fonts.body,
        fontSize: size,
        lineHeight: size * 1.4,
        color: tones[tone],
        textAlign: align,
        fontVariant: variant === 'price' ? ['tabular-nums'] : undefined,
      }}
    >
      {children}
    </Text>
  );
}
