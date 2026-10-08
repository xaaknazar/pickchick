import type { ReactNode } from 'react';
import { Animated, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, useMetrics } from '../theme';
import { motion, useEnter } from './motion';
/** Which way a newly shown screen arrives: from the right, or back from the left. */
export type ScreenEntrance = 'forward' | 'back' | 'none';
/**
 * Full-screen surface. v3 tones: `brand` is the blue working surface, `night`
 * the deep gradient behind the dining choice, `dark` the film backdrop.
 * `entrance` plays the prototype screen change on mount: the whole surface fades
 * in while sliding 60 pt from the right (`forward`) or from the left (`back`),
 * 380 ms on the v3 ease. It is static under reduced motion, and content is
 * pressable from the first frame.
 */
export function ScreenSurface({
  children,
  testID,
  tone = 'default',
  onTouchStart,
  keyboardAware = false,
  entrance = 'none',
}: {
  children?: ReactNode;
  testID?: string;
  tone?: 'default' | 'brand' | 'dark' | 'night';
  onTouchStart?: () => void;
  keyboardAware?: boolean;
  entrance?: ScreenEntrance;
}) {
  const { v } = useMetrics();
  const moving = entrance !== 'none';
  const enter = useEnter(0, moving ? motion.enter : 0);
  const distance = entrance === 'back' ? -v(60) : v(60);
  const surface = (
    <Animated.View
      testID={testID}
      onTouchStart={onTouchStart}
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor:
          tone === 'brand'
            ? colors.blue
            : tone === 'dark'
              ? colors.navy
              : tone === 'night'
                ? colors.navy
                : colors.background,
        overflow: 'hidden',
        opacity: moving ? enter : 1,
        transform: moving
          ? [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }]
          : [],
      }}
    >
      {tone === 'night' ? (
        <LinearGradient
          colors={['#1A3F8F', '#0A2466', colors.night, colors.navy]}
          locations={[0, 0.28, 0.55, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.35, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : null}
      {children}
    </Animated.View>
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
