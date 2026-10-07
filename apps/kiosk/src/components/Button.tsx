import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, Text } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { Icon, type IconName } from './Icon';
import { useMotionPreference } from './useMotionPreference';
export interface ButtonProps {
  label: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
  busy?: boolean;
  tone?: 'accent' | 'primary' | 'secondary' | 'inverse' | 'quiet' | 'danger';
  size?: 'compact' | 'regular' | 'hero';
  icon?: IconName;
  fullWidth?: boolean;
}
export function Button({
  label,
  onPress,
  testID,
  disabled = false,
  busy = false,
  tone = 'accent',
  size = 'regular',
  icon,
  fullWidth = false,
}: ButtonProps) {
  const { px } = useMetrics();
  const reduced = useMotionPreference();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    scale.stopAnimation();
    scale.setValue(1);
    return () => scale.stopAnimation();
  }, [reduced, scale]);
  const blocked = disabled || busy;
  const inverse = tone === 'primary' || tone === 'inverse' || tone === 'danger';
  const color = disabled
    ? colors.muted
    : inverse
      ? colors.white
      : tone === 'secondary' || tone === 'quiet'
        ? colors.blue
        : colors.ink;
  const motion = (pressed: boolean) => {
    scale.stopAnimation();
    Animated.timing(scale, {
      toValue: pressed && !reduced ? 0.98 : 1,
      duration: reduced ? 0 : 140,
      useNativeDriver: true,
    }).start();
  };
  return (
    <Animated.View style={{ width: fullWidth ? '100%' : undefined, transform: [{ scale }] }}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: blocked, busy }}
        disabled={blocked}
        onPress={onPress}
        onPressIn={() => motion(true)}
        onPressOut={() => motion(false)}
        style={({ pressed }) => ({
          minHeight: Math.max(52, px(size === 'hero' ? 104 : size === 'compact' ? 62 : 84)),
          paddingVertical: px(size === 'compact' ? 14 : 20),
          paddingHorizontal: px(24),
          borderRadius: 16,
          backgroundColor: disabled
            ? colors.light
            : tone === 'accent'
              ? colors.orange
              : tone === 'primary'
                ? colors.blue
                : tone === 'inverse'
                  ? 'rgba(255,255,255,.14)'
                  : tone === 'danger'
                    ? colors.error
                    : tone === 'secondary'
                      ? colors.light
                      : 'transparent',
          opacity: busy ? 0.65 : pressed ? 0.82 : 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: px(12),
        })}
      >
        {busy ? <ActivityIndicator accessibilityLabel={label} color={color} /> : null}
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: Math.max(18, px(size === 'hero' ? 34 : size === 'compact' ? 21 : 26)),
            color,
            flexShrink: 1,
            textAlign: 'center',
          }}
        >
          {label}
        </Text>
        {icon ? (
          <Icon name={icon} tone={inverse ? 'inverse' : tone === 'accent' ? 'default' : 'brand'} />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
