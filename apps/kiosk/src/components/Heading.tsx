import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { fonts, tones, useMetrics, type Tone } from '../theme';
import { fixedText } from './Body';
/** v3 scale in 820-pt design units (see useMetrics().v). */
const sizes = { card: 21, section: 28, title: 40, display: 56, hero: 70 } as const;
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
  const { v } = useMetrics();
  const fontSize = v(sizes[size]);
  return (
    <Text
      {...fixedText}
      accessibilityRole="header"
      testID={testID}
      style={{
        fontFamily: size === 'card' ? fonts.heavy : fonts.black,
        fontSize,
        lineHeight: fontSize * 1.12,
        letterSpacing: -fontSize * 0.018,
        color: tones[tone],
        textAlign: align,
      }}
    >
      {children}
    </Text>
  );
}
