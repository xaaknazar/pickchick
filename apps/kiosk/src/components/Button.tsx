import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, Text } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { Icon, type IconName } from './Icon';
import { useMotionPreference } from './useMotionPreference';
import { motion } from './motion';
export interface ButtonProps {
  label: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
  busy?: boolean;
  tone?: 'accent' | 'primary' | 'secondary' | 'inverse' | 'quiet' | 'danger' | 'outline';
  size?: 'compact' | 'regular' | 'hero';
  icon?: IconName;
  fullWidth?: boolean;
}
/**
 * v3 pill button. Accent orange is the one primary action per screen; its fill
 * is the accessible orangeCta (orangeInk under the small compact label).
 */
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
  const { v } = useMetrics();
  const reduced = useMotionPreference();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    scale.stopAnimation();
    scale.setValue(1);
    return () => scale.stopAnimation();
  }, [reduced, scale]);
  const blocked = disabled || busy;
  const filled = tone === 'accent' || tone === 'primary' || tone === 'danger';
  const color = disabled
    ? filled
      ? 'rgba(255,255,255,.85)'
      : colors.muted
    : filled || tone === 'inverse' || tone === 'outline'
      ? colors.white
      : tone === 'secondary' || tone === 'quiet'
        ? colors.blue
        : colors.navy;
  const press = (pressed: boolean) => {
    scale.stopAnimation();
    Animated.timing(scale, {
      toValue: pressed && !reduced ? 0.97 : 1,
      duration: reduced ? 0 : motion.press,
      useNativeDriver: true,
    }).start();
  };
  const height = Math.max(52, v(size === 'hero' ? 112 : size === 'compact' ? 64 : 96));
  return (
    <Animated.View style={{ width: fullWidth ? '100%' : undefined, transform: [{ scale }] }}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: blocked, busy }}
        disabled={blocked}
        onPress={onPress}
        onPressIn={() => press(true)}
        onPressOut={() => press(false)}
        style={{
          minHeight: height,
          paddingVertical: v(size === 'compact' ? 12 : 18),
          paddingHorizontal: v(size === 'compact' ? 22 : 32),
          borderRadius: 999,
          backgroundColor: disabled
            ? filled
              ? 'rgba(201,210,227,.9)'
              : colors.soft
            : tone === 'accent'
              ? size === 'compact'
                ? colors.orangeInk
                : colors.orangeCta
              : tone === 'primary'
                ? colors.blue
                : tone === 'inverse'
                  ? colors.glass
                  : tone === 'danger'
                    ? colors.error
                    : tone === 'secondary'
                      ? colors.soft
                      : 'transparent',
          borderWidth: tone === 'outline' ? 2.5 : 0,
          borderColor: 'rgba(255,255,255,.4)',
          shadowColor: tone === 'accent' ? colors.orange : '#020A28',
          shadowOpacity: !disabled && tone === 'accent' ? 0.42 : 0,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 12 },
          opacity: busy ? 0.7 : 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: v(12),
        }}
      >
        {busy ? <ActivityIndicator accessibilityLabel={label} color={color} /> : null}
        <Text
          style={{
            fontFamily: fonts.black,
            // Regular and hero labels stay >= 24 px: WCAG "large" text on orangeCta.
            fontSize:
              size === 'compact' ? Math.max(18, v(17)) : Math.max(24, v(size === 'hero' ? 34 : 23)),
            letterSpacing: size === 'hero' ? 1.2 : 0,
            color,
            flexShrink: 1,
            textAlign: 'center',
          }}
        >
          {label}
        </Text>
        {icon ? (
          <Icon
            name={icon}
            tone={filled || tone === 'inverse' || tone === 'outline' ? 'inverse' : 'brand'}
          />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
