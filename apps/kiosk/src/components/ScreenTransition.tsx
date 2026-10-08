import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Platform, StyleSheet } from 'react-native';
import { motion, easeIn } from './motion';
import { circleClose, circleOpen, LeavingContext } from './reveal';
import { useMotionPreference } from './useMotionPreference';
interface Layer {
  key: string;
  node: ReactNode;
  reveal: boolean;
}
/**
 * How a leaving screen goes: `fade` plays `scrOut`; `hold` stays still under a
 * screen that opens as a circle over it; `circle` stays on top and closes its
 * own circle (RevealCircle) over the next screen.
 */
type Exit = 'fade' | 'hold' | 'circle';
/**
 * Keeps the screen that is being left on a frozen, untouchable layer under the
 * new one while it plays the prototype `scrOut` (opacity 1 -> 0, scale 1 -> .97,
 * 260 ms ease-in), then drops it. The leaving screen keeps its own instance (no
 * remount) and is hidden from assistive technology. Native only: on the web
 * the copy would duplicate test ids, so the old screen goes at once there, as it
 * does under reduced motion. A `reveal` screen (the product page) opens as a
 * circle over the still previous screen and later closes as a circle over the
 * next one instead.
 */
export function ScreenTransition({
  screenKey,
  reveal = false,
  children,
}: {
  /** Identity of the screen; a change plays the exit of the previous one. */
  screenKey: string;
  /** This screen opens and closes as a circle (RevealCircle) over its neighbours. */
  reveal?: boolean;
  children: ReactNode;
}) {
  const reduced = useMotionPreference();
  const animate = Platform.OS !== 'web' && !reduced;
  const last = useRef<Layer>({ key: screenKey, node: children, reveal });
  const [leaving, setLeaving] = useState<Layer | null>(null);
  if (last.current.key !== screenKey) {
    const previous = last.current;
    last.current = { key: screenKey, node: children, reveal };
    setLeaving(animate ? previous : null);
  } else last.current = { key: screenKey, node: children, reveal };
  const done = useCallback(
    (key: string) => setLeaving((layer) => (layer?.key === key ? null : layer)),
    [],
  );
  const current: Layer = { key: screenKey, node: children, reveal };
  const old = animate && leaving && leaving.key !== screenKey ? leaving : null;
  const exit: Exit = !old
    ? 'fade'
    : old.reveal && !reveal
      ? 'circle'
      : reveal && !old.reveal
        ? 'hold'
        : 'fade';
  // A closing circle stays above the next screen; every other exit goes below.
  const layers = !old ? [current] : exit === 'circle' ? [current, old] : [old, current];
  return (
    <>
      {layers.map((layer) => (
        <Stage
          key={layer.key}
          id={layer.key}
          leaving={layer.key !== screenKey}
          exit={exit}
          onDone={done}
        >
          {layer.node}
        </Stage>
      ))}
    </>
  );
}

function Stage({
  id,
  leaving,
  exit,
  onDone,
  children,
}: {
  id: string;
  leaving: boolean;
  exit: Exit;
  onDone: (key: string) => void;
  children: ReactNode;
}) {
  const presence = useRef(new Animated.Value(1)).current;
  const fade = leaving && exit === 'fade';
  useEffect(() => {
    presence.stopAnimation();
    presence.setValue(1);
    if (!leaving) return;
    if (exit !== 'fade') {
      // The circle itself is the transition; drop the layer once it is over.
      const timer = setTimeout(() => onDone(id), exit === 'hold' ? circleOpen : circleClose);
      return () => clearTimeout(timer);
    }
    const animation = Animated.timing(presence, {
      toValue: 0,
      duration: motion.exit,
      easing: easeIn,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) onDone(id);
    });
    return () => {
      animation.stop();
      presence.setValue(1);
    };
  }, [exit, id, leaving, onDone, presence]);
  return (
    <Animated.View
      pointerEvents={leaving ? 'none' : 'auto'}
      accessibilityElementsHidden={leaving}
      importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
      style={
        leaving
          ? [
              StyleSheet.absoluteFill,
              fade
                ? {
                    opacity: presence,
                    transform: [
                      {
                        scale: presence.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.97, 1],
                        }),
                      },
                    ],
                  }
                : null,
            ]
          : { flex: 1, minHeight: 0 }
      }
    >
      <LeavingContext.Provider value={leaving}>{children}</LeavingContext.Provider>
    </Animated.View>
  );
}
