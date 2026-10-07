import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { fonts, tones, useMetrics, type Tone } from '../theme';
const sizes = { card: 27, section: 34, title: 44, display: 58, hero: 88 } as const;
export function Heading({
  children,
  size = 'title',
  tone = 'default',
  align = 'left',
  testID,
}: {
  children?: ReactNode;
  size?: keyof typeof sizes;
  tone?: Tone;
  align?: 'left' | 'center' | 'right';
  testID?: string;
}) {
  const { px } = useMetrics();
  const fontSize = px(sizes[size]);
  return (
    <Text
      accessibilityRole="header"
      testID={testID}
      style={{
        fontFamily: size === 'card' ? fonts.heading : fonts.heavy,
        fontSize,
        lineHeight: fontSize * 1.18,
        letterSpacing: -fontSize * 0.025,
        color: tones[tone],
        textAlign: align,
      }}
    >
      {children}
    </Text>
  );
}
