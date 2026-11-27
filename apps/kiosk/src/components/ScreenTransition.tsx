import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Platform, StyleSheet } from 'react-native';
import { motion, easeIn, MotionReadyContext } from './motion';
import { circleClose, circleOpen, LeavingContext, menuVeil, type RevealMode } from './reveal';
import { ModeReveal } from './ModeReveal';
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
type Exit = 'fade' | 'hold' | 'circle' | 'dining';
/**
 * Keeps the screen that is being left on a frozen, untouchable layer under the
 * new one while it plays the prototype `scrOut` (opacity 1 -> 0, scale 1 -> .97,
 * 260 ms ease-in), then drops it. The leaving screen keeps its own instance (no
 * remount) and is hidden from assistive technology. Native only: on the web
 * the copy would duplicate test ids, so ordinary exits drop the old screen there.
 * Dining-to-menu retains it on both platforms until the colour fully covers it;
 * reduced motion always switches directly. A `reveal` screen (the product page) opens as a
 * circle over the still previous screen and later closes as a circle over the
 * next one instead.
 */
export function ScreenTransition({
  screenKey,
  reveal = false,
  diningMode = null,
  children,
}: {
  /** Identity of the screen; a change plays the exit of the previous one. */
  screenKey: string;
  /** This screen opens and closes as a circle (RevealCircle) over its neighbours. */
  reveal?: boolean;
  diningMode?: RevealMode | null;
  children: ReactNode;
}) {
  const reduced = useMotionPreference();
  const animate = Platform.OS !== 'web' && !reduced;
  const last = useRef<Layer>({ key: screenKey, node: children, reveal });
  const [leaving, setLeaving] = useState<Layer | null>(null);
  const [handoff, setHandoff] = useState<{
    key: string;
    mode: RevealMode;
    covered: boolean;
    /** Native progress of the reveal; the menu's opacity follows it (`menuVeil`). */
    progress: Animated.Value;
  } | null>(null);
  if (last.current.key !== screenKey) {
    const previous = last.current;
    const dining = previous.key === 'mode' && screenKey === 'menu' && !reduced ? diningMode : null;
    last.current = { key: screenKey, node: children, reveal };
    setLeaving(animate || dining ? previous : null);
    setHandoff(
      dining
        ? { key: screenKey, mode: dining, covered: false, progress: new Animated.Value(0) }
        : null,
    );
  } else last.current = { key: screenKey, node: children, reveal };
  useEffect(() => {
    if (!reduced) return;
    setLeaving(null);
    setHandoff(null);
  }, [reduced]);
  const covered = useCallback(() => {
    setHandoff((now) => (now?.key === screenKey ? { ...now, covered: true } : now));
    setLeaving(null);
  }, [screenKey]);
  const revealed = useCallback(() => setHandoff(null), []);
  const done = useCallback(
    (key: string) => setLeaving((layer) => (layer?.key === key ? null : layer)),
    [],
  );
  const current: Layer = { key: screenKey, node: children, reveal };
  const dining = !reduced && handoff?.key === screenKey ? handoff : null;
  const old = (animate || dining) && leaving && leaving.key !== screenKey ? leaving : null;
  const exit: Exit = dining
    ? 'dining'
    : !old
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
          concealed={layer.key === screenKey && !!dining && !dining.covered}
          veil={layer.key === screenKey && dining ? dining.progress : undefined}
          exit={exit}
          onDone={done}
        >
          {layer.node}
        </Stage>
      ))}
      {dining ? (
        <ModeReveal
          key={dining.key}
          mode={dining.mode}
          progress={dining.progress}
          onCovered={covered}
          onDone={revealed}
        />
      ) : null}
    </>
  );
}

function Stage({
  id,
  leaving,
  concealed,
  veil,
  exit,
  onDone,
  children,
}: {
  id: string;
  leaving: boolean;
  concealed: boolean;
  /** Dining reveal: the opacity follows the reveal natively instead of `concealed`. */
  veil?: Animated.Value;
  exit: Exit;
  onDone: (key: string) => void;
  children: ReactNode;
}) {
  const presence = useRef(new Animated.Value(1)).current;
  const veiled = useMemo(() => (veil ? menuVeil(veil) : null), [veil]);
  const fade = leaving && exit === 'fade';
  useEffect(() => {
    presence.stopAnimation();
    presence.setValue(1);
    if (!leaving) return;
    // Dining stays visible until the colour has covered it, without a competing fade.
    if (exit === 'dining') return;
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
    // The faded screen is dropped only after the next one has finished sliding in: taking a
    // whole screen (the menu keeps five sections) out of the view tree mid-entrance cost frames.
    let drop: ReturnType<typeof setTimeout> | undefined;
    animation.start(({ finished }) => {
      if (finished) drop = setTimeout(() => onDone(id), motion.enter);
    });
    return () => {
      if (drop) clearTimeout(drop);
      animation.stop();
      presence.setValue(1);
    };
  }, [exit, id, leaving, onDone, presence]);
  return (
    <Animated.View
      testID={'kiosk-stage-' + id}
      pointerEvents={leaving || concealed ? 'none' : 'auto'}
      accessibilityElementsHidden={leaving || concealed}
      importantForAccessibility={leaving || concealed ? 'no-hide-descendants' : 'auto'}
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
          : { flex: 1, minHeight: 0, opacity: veiled ?? (concealed ? 0 : 1) }
      }
    >
      <LeavingContext.Provider value={leaving}>
        {/* A veiled menu plays its entrance under the colour, so it is in place when shown. */}
        <MotionReadyContext.Provider value={!leaving && (!concealed || !!veil)}>
          {children}
        </MotionReadyContext.Provider>
      </LeavingContext.Provider>
    </Animated.View>
  );
}
