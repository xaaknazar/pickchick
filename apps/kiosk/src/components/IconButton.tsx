import { glassSurface } from './glassSurface';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { useMetrics } from '../theme';
import { Icon, type IconName } from './Icon';
import { usePress } from './motion';
/**
 * Round v3 control: `inverse` glass on blue, `light` white disc, `accent` orange.
 * Presses ease down to .92 over 140 ms (static under reduced motion). With
 * `onRefused`, a tap on the disabled button reaches `onRefused` through a silent
 * layer above it (the button itself stays disabled) so its parent can answer
 * with feedback such as a shake.
 */
export function IconButton({
  name,
  label,
  onPress,
  testID,
  tone = 'neutral',
  size = 'regular',
  disabled = false,
  dim: dimDisabled = true,
  onRefused,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
  tone?: 'neutral' | 'inverse' | 'accent' | 'light';
  size?: 'regular' | 'large';
  disabled?: boolean;
  /** Fade a disabled button to .35 (default). `false` keeps the design's solid disc. */
  dim?: boolean;
  /** Tapped while disabled (feedback only; never the action itself). */
  onRefused?: () => void;
}) {
  const { v } = useMetrics();
  const dim = Math.max(48, v(size === 'large' ? 72 : 60));
  const press = usePress(0.92);
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={{
          width: dim,
          height: dim,
          borderRadius: dim / 2,
          alignItems: 'center',
          justifyContent: 'center',
          ...glassSurface(tone === 'accent' ? 'accent' : tone === 'inverse' ? 'dark' : 'light'),
          opacity: disabled && dimDisabled ? 0.58 : 1,
        }}
      >
        <Icon name={name} tone={tone === 'inverse' || tone === 'accent' ? 'inverse' : 'navy'} />
      </Pressable>
      {disabled && onRefused ? (
        // Silent layer over the disabled button: a tap only reports the refusal.
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          tabIndex={-1}
          onPress={onRefused}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </Animated.View>
  );
}
