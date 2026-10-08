import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { colors, useMetrics } from '../theme';
import { easeOut, type FlyRect } from './motion';
import { awaitReveal, clearReveal, peekReveal, type RevealMode } from './reveal';
import { useMotionPreference } from './useMotionPreference';
/** Prototype zoom: 540 ms cubic-bezier(.7,0,.2,1), then a 360 ms ease-out fade. */
const growTime = 540;
const fadeTime = 360;
const zoom = Easing.bezier(0.7, 0, 0.2, 1);
/**
 * v3 dining-choice reveal (prototype `.zoomfill`): the chosen tile's colour grows
 * from the tile's rectangle to the whole screen while its 44 pt corners square
 * off, then fades away over the menu. It plays once, only right after a dining
 * tile was tapped, never takes touches and never holds the menu back. Under
 * reduced motion the menu simply appears.
 */
export function ModeReveal({ mode }: { mode: RevealMode | null }) {
  const { v } = useMetrics();
  const reduced = useMotionPreference();
  const [tile, setTile] = useState(() => peekReveal(mode));
  const [frame, setFrame] = useState<FlyRect | null>(null);
  const [done, setDone] = useState(false);
  const host = useRef<View>(null);
  const grow = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  // Consume the tap so a later return to the menu never replays it. A quick
  // tap can choose before its tile was measured: wait briefly for it.
  useEffect(() => {
    if (tile) {
      clearReveal();
      return;
    }
    const cancel = awaitReveal(mode, setTile);
    return () => {
      cancel();
      clearReveal();
    };
    // Only the tap that mounted this menu counts.
  }, []);
  // Reduced motion at any point ends the reveal for good (no late replay).
  useEffect(() => {
    if (reduced) setDone(true);
  }, [reduced]);
  // Measured before paint: the fill lives in this screen's coordinates.
  useLayoutEffect(() => {
    if (!tile || reduced || frame) return;
    host.current?.measureInWindow((x, y, width, height) => {
      if (width && height) setFrame({ x, y, width, height });
      else setDone(true);
    });
  }, [frame, reduced, tile]);
  useEffect(() => {
    if (!frame || done) return;
    grow.stopAnimation();
    fade.stopAnimation();
    if (reduced) return;
    grow.setValue(0);
    fade.setValue(1);
    const animation = Animated.sequence([
      Animated.timing(grow, {
        toValue: 1,
        duration: growTime,
        easing: zoom,
        useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: 0,
        duration: fadeTime,
        easing: easeOut,
        useNativeDriver: true,
      }),
    ]);
    animation.start(({ finished }) => {
      if (finished) setDone(true);
    });
    return () => animation.stop();
  }, [done, fade, frame, grow, reduced]);
  if (!tile || done || reduced) return null;
  const tint = mode === 'takeaway' ? colors.orangeCta : colors.blue;
  const left = tile.x - (frame?.x ?? 0);
  const top = tile.y - (frame?.y ?? 0);
  const to = (end: number) => grow.interpolate({ inputRange: [0, 1], outputRange: [0, end] });
  const stretch = (end: number, start: number) =>
    grow.interpolate({ inputRange: [0, 1], outputRange: [1, end / start] });
  return (
    <View
      ref={host}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      {frame ? (
        <Animated.View
          style={{
            position: 'absolute',
            left,
            top,
            width: tile.width,
            height: tile.height,
            opacity: fade,
            transform: [
              { translateX: to(frame.width / 2 - (left + tile.width / 2)) },
              { translateY: to(frame.height / 2 - (top + tile.height / 2)) },
              { scaleX: stretch(frame.width, tile.width) },
              { scaleY: stretch(frame.height, tile.height) },
            ],
          }}
        >
          <View style={[StyleSheet.absoluteFill, { borderRadius: v(44), backgroundColor: tint }]} />
          {/* Corners square off as the fill grows: a sharp copy fades in over the rounded one. */}
          <Animated.View
            style={[StyleSheet.absoluteFill, { backgroundColor: tint, opacity: grow }]}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
