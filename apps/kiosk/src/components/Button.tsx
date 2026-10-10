import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { Icon, type IconName } from './Icon';
import { useFlash, useLoop, usePress, useTimingTo } from './motion';
import { ownerOrange } from './ownerOrange';
import { fixedText } from './Body';
export interface ButtonProps {
  label: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
  busy?: boolean;
  tone?:
    | 'accent'
    | 'primary'
    | 'secondary'
    | 'inverse'
    | 'quiet'
    | 'danger'
    | 'outline'
    /** White pill with navy text on the blue surface (design "Новый заказ"). */
    | 'light'
    /** Blue-outlined pill on a white sheet (design cart "+ Добавить ещё"). */
    | 'brandOutline';
  size?: 'compact' | 'regular' | 'hero';
  icon?: IconName;
  /** Draw the icon before the label (design "+ Добавить ещё"). */
  iconLeading?: boolean;
  fullWidth?: boolean;
  /** 0..1 countdown fill: a peach band grows from the left, gliding 1 s per step. */
  progress?: number;
}
/**
 * v3 pill button. Accent orange is the one primary action per screen; its fill is
 * the design orange #FF6900 with white text at every size (owner decision
 * 2026-10-10, an approved exception to the contrast check).
 * Enabling or disabling crossfades the fill over 260 ms (prototype `.octa.dim`)
 * while the button itself switches state at once.
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
  iconLeading = false,
  fullWidth = false,
  progress,
}: ButtonProps) {
  const { v } = useMetrics();
  const { scale, onPressIn, onPressOut } = usePress(0.97);
  const fade = useFlash(disabled, 260);
  const blocked = disabled || busy;
  const filled = tone === 'accent' || tone === 'primary' || tone === 'danger';
  const fillFor = (off: boolean) =>
    off
      ? filled
        ? 'rgba(201,210,227,.9)'
        : colors.soft
      : tone === 'accent'
        ? colors.orangeCta
        : tone === 'primary'
          ? colors.blue
          : tone === 'inverse'
            ? colors.glass
            : tone === 'danger'
              ? colors.error
              : tone === 'secondary'
                ? colors.soft
                : tone === 'light'
                  ? colors.white
                  : 'transparent';
  const color = disabled
    ? filled
      ? 'rgba(255,255,255,.85)'
      : colors.muted
    : filled || tone === 'inverse' || tone === 'outline'
      ? colors.white
      : tone === 'secondary' || tone === 'quiet' || tone === 'brandOutline'
        ? colors.blue
        : colors.navy;
  const height = Math.max(52, v(size === 'hero' ? 112 : size === 'compact' ? 64 : 96));
  return (
    <Animated.View style={{ width: fullWidth ? '100%' : undefined, transform: [{ scale }] }}>
      <Pressable
        testID={testID}
        {...(tone === 'accent' ? ownerOrange : {})}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: blocked, busy }}
        disabled={blocked}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={{
          minHeight: height,
          paddingVertical: v(size === 'compact' ? 12 : 18),
          paddingHorizontal: v(size === 'compact' ? 22 : 32),
          borderRadius: 999,
          backgroundColor: fillFor(disabled),
          borderWidth: tone === 'outline' ? 2.5 : tone === 'brandOutline' ? 3 : 0,
          borderColor: tone === 'brandOutline' ? colors.blue : 'rgba(255,255,255,.4)',
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
        {fade.active ? (
          // The outgoing fill fades out over the new one (prototype opacity transition).
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: 999,
              backgroundColor: fillFor(!disabled),
              opacity: fade.value,
            }}
          />
        ) : null}
        {progress !== undefined ? <Countdown progress={progress} /> : null}
        {busy ? <ActivityIndicator accessibilityLabel={label} color={color} /> : null}
        {icon && iconLeading ? (
          <Icon
            name={icon}
            tone={filled || tone === 'inverse' || tone === 'outline' ? 'inverse' : 'brand'}
          />
        ) : null}
        <Text
          {...fixedText}
          style={{
            fontFamily: fonts.black,
            // Regular and hero labels stay >= 24 px (design type scale).
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
        {iconLeading ? null : icon === 'arrow-forward' && !blocked ? (
          <Nudge>
            <Icon
              name={icon}
              tone={filled || tone === 'inverse' || tone === 'outline' ? 'inverse' : 'brand'}
            />
          </Nudge>
        ) : icon ? (
          <Icon
            name={icon}
            tone={filled || tone === 'inverse' || tone === 'outline' ? 'inverse' : 'brand'}
          />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
/**
 * Prototype `kNudge` on a live "next" arrow: 0 -> 7 pt -> 0, 1.4 s ease-in-out,
 * forever. Still under reduced motion.
 */
function Nudge({ children }: { children: ReactNode }) {
  const { v } = useMetrics();
  const loop = useLoop(1400, 0, true);
  return (
    <Animated.View
      style={{
        transform: [
          { translateX: loop.interpolate({ inputRange: [0, 1], outputRange: [0, v(7)] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
/**
 * Prototype `.newo .cd`: a peach band under the label whose width follows the
 * countdown with a 1 s linear transition. Drawn with scaleX from the left edge
 * on the native driver; jumps under reduced motion.
 */
function Countdown({ progress }: { progress: number }) {
  const [width, setWidth] = useState(0);
  const value = useTimingTo(Math.min(1, Math.max(0, progress)), 1000, 'linear');
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius: 999,
        overflow: 'hidden',
      }}
    >
      {width > 0 ? (
        <Animated.View
          style={{
            width,
            height: '100%',
            backgroundColor: colors.peach,
            transform: [
              {
                translateX: value.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-width / 2, 0],
                }),
              },
              { scaleX: value.interpolate({ inputRange: [0, 1], outputRange: [0.0001, 1] }) },
            ],
          }}
        />
      ) : null}
    </View>
  );
}
