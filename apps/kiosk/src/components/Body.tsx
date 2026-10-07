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
  const { px, body } = useMetrics();
  const size = variant === 'caption' ? Math.max(16, px(18)) : variant === 'price' ? px(28) : body;
  return (
    <Text
      accessibilityLiveRegion={announce ? 'polite' : undefined}
      testID={testID}
      accessibilityRole={accessibilityRole}
      numberOfLines={lines}
      style={{
        fontFamily: variant === 'label' || variant === 'price' ? fonts.medium : fonts.body,
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
