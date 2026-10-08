import type { ReactNode } from 'react';
import { Animated, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme';
import { motion, useEnter } from './motion';
/**
 * Full-screen surface. v3 tones: `brand` is the blue working surface, `night`
 * the deep gradient behind the dining choice, `dark` the film backdrop.
 * `entrance` slides a newly mounted screen in (static under reduced motion).
 */
export function ScreenSurface({
  children,
  testID,
  tone = 'default',
  onTouchStart,
  keyboardAware = false,
  entrance = false,
}: {
  children?: ReactNode;
  testID?: string;
  tone?: 'default' | 'brand' | 'dark' | 'night';
  onTouchStart?: () => void;
  keyboardAware?: boolean;
  entrance?: boolean;
}) {
  const enter = useEnter(0, entrance ? motion.enter : 0);
  const surface = (
    <View
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
      {entrance ? (
        <Animated.View
          style={{
            flex: 1,
            minHeight: 0,
            opacity: enter,
            transform: [
              { translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [48, 0] }) },
            ],
          }}
        >
          {children}
        </Animated.View>
      ) : (
        children
      )}
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
