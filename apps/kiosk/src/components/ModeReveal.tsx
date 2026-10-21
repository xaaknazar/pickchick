import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors, useMetrics } from '../theme';
import { ease, easeOut, type FlyRect } from './motion';
import { awaitReveal, clearReveal, peekReveal, type RevealMode } from './reveal';
import { useMotionPreference } from './useMotionPreference';

/** Cover the dining screen first; reveal the menu only after its parent commits it. */
export function ModeReveal({
  mode,
  uncover = false,
  onCovered,
  onDone,
}: {
  mode: RevealMode | null;
  uncover?: boolean;
  onCovered?: () => void;
  onDone?: () => void;
}) {
  const { v, width, height } = useMetrics();
  const reduced = useMotionPreference();
  const [tile, setTile] = useState(() => peekReveal(mode));
  const [measured, setMeasured] = useState(!!tile);
  const [frame, setFrame] = useState<FlyRect | null>(null);
  const host = useRef<View>(null);
  const grow = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
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
    if (!frame || !measured || reduced || uncover) return;
    const animation = Animated.timing(grow, {
      toValue: 1,
      duration: 520,
      easing: ease,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start(({ finished }) => {
      if (finished) onCovered?.();
    });
    return () => animation.stop();
  }, [frame, grow, measured, onCovered, reduced, uncover]);
  useEffect(() => {
    if (!uncover || reduced) return;
    // Runs after the menu's visible state has committed. No timer races.
    grow.setValue(1);
    const animation = Animated.timing(fade, {
      toValue: 0,
      duration: 280,
      easing: easeOut,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start(({ finished }) => {
      if (finished) onDone?.();
    });
    return () => animation.stop();
  }, [fade, grow, onDone, reduced, uncover]);
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
