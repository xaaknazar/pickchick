import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { colors, useMetrics } from '../theme';
import { ease, easeOut, type FlyRect } from './motion';
import type { EasingFunction } from 'react-native';
import {
  awaitReveal,
  clearReveal,
  peekReveal,
  REVEAL_COVERED,
  REVEAL_FADE_FROM,
  REVEAL_GROW_MS,
  REVEAL_MS,
  type RevealMode,
} from './reveal';
import { useMotionPreference } from './useMotionPreference';

/** `curve` over [from, to] of a linear 0..1 progress, sampled for a native interpolation. */
function segment(curve: EasingFunction, from: number, to: number, invert = false) {
  const steps = 16;
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let i = 0; i <= steps; i++) {
    inputRange.push(from + ((to - from) * i) / steps);
    const y = curve(i / steps);
    outputRange.push(invert ? 1 - y : y);
  }
  return { inputRange, outputRange, extrapolate: 'clamp' as const };
}
/**
 * Owner 22-23.11.2026: the dining tile grows into the menu and the menu opens right away. One
 * native progress (0..1, linear, 800 ms) drives the whole reveal: the fill grows, the menu
 * appears under it (`menuVeil` in reveal.ts, on the same value) and the fill fades, so no step waits for
 * JavaScript, which is busy building the menu at that moment. `onCovered` and `onDone` only
 * tidy up afterwards.
 */
export function ModeReveal({
  mode,
  progress,
  onCovered,
  onDone,
}: {
  mode: RevealMode | null;
  /** The reveal's progress; the screen under it reads it through `menuVeil`. */
  progress?: Animated.Value;
  onCovered?: () => void;
  onDone?: () => void;
}) {
  const { v, width, height } = useMetrics();
  const reduced = useMotionPreference();
  const [tile, setTile] = useState(() => peekReveal(mode));
  const [measured, setMeasured] = useState(!!tile);
  const [frame, setFrame] = useState<FlyRect | null>(null);
  const host = useRef<View>(null);
  const own = useRef(new Animated.Value(0)).current;
  const reveal = progress ?? own;
  const grow = useRef(reveal.interpolate(segment(ease, 0, REVEAL_COVERED))).current;
  const fade = useRef(reveal.interpolate(segment(easeOut, REVEAL_FADE_FROM, 1, true))).current;
  useEffect(() => {
    if (tile) {
      clearReveal();
      return;
    }
    const cancel = awaitReveal(mode, (rect) => {
      setTile(rect);
      setMeasured(true);
    });
    // A missing/late measurement must never expose the menu first or strand the guest.
    const timer = setTimeout(() => setMeasured(true), 250);
    return () => {
      clearTimeout(timer);
      cancel();
      clearReveal();
    };
  }, []);
  useEffect(() => {
    if (!reduced) return;
    onCovered?.();
    onDone?.();
  }, [onCovered, onDone, reduced]);
  useEffect(() => {
    if (!frame || !measured || reduced) return;
    const animation = Animated.timing(reveal, {
      toValue: 1,
      duration: REVEAL_MS,
      easing: Easing.linear,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start(({ finished }) => {
      if (finished) onDone?.();
    });
    // Housekeeping only: the menu is already visible natively when this runs.
    const covered = setTimeout(() => onCovered?.(), REVEAL_GROW_MS);
    return () => {
      clearTimeout(covered);
      animation.stop();
    };
  }, [frame, measured, onCovered, onDone, reduced, reveal]);
  if (reduced) return null;
  const bounds = frame ?? { x: 0, y: 0, width, height };
  const origin = tile ?? {
    x: bounds.x + bounds.width / 4,
    y: bounds.y + bounds.height / 2,
    width: bounds.width / 2,
    height: bounds.height / 4,
  };
  const tint = mode === 'takeaway' ? colors.orangeCta : colors.blue;
  const left = origin.x - bounds.x;
  const top = origin.y - bounds.y;
  const to = (end: number) => grow.interpolate({ inputRange: [0, 1], outputRange: [0, end] });
  const stretch = (end: number, start: number) =>
    grow.interpolate({ inputRange: [0, 1], outputRange: [1, end / start] });
  return (
    <View
      ref={host}
      testID="kiosk-mode-reveal"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
      onLayout={(event) => {
        const layout = event.nativeEvent.layout;
        host.current?.measureInWindow((x, y, w, h) => {
          setFrame(
            (current) =>
              current ?? {
                x,
                y,
                width: w || layout.width || width,
                height: h || layout.height || height,
              },
          );
        });
      }}
    >
      {frame && measured ? (
        <Animated.View
          testID="kiosk-mode-reveal-fill"
          style={{
            position: 'absolute',
            left,
            top,
            width: origin.width,
            height: origin.height,
            opacity: fade,
            transform: [
              { translateX: to(bounds.width / 2 - (left + origin.width / 2)) },
              { translateY: to(bounds.height / 2 - (top + origin.height / 2)) },
              { scaleX: stretch(bounds.width + 2, origin.width) },
              { scaleY: stretch(bounds.height + 2, origin.height) },
            ],
          }}
        >
          <View style={[StyleSheet.absoluteFill, { borderRadius: v(44), backgroundColor: tint }]} />
          <Animated.View
            style={[StyleSheet.absoluteFill, { backgroundColor: tint, opacity: grow }]}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
