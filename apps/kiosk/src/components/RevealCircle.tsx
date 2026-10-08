import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, View, useWindowDimensions } from 'react-native';
import { useMetrics } from '../theme';
import { circleClose, circleOpen, LeavingContext, takeProductOrigin } from './reveal';
import { useMotionPreference } from './useMotionPreference';
/** Prototype `clip-path: circle()` curves for opening and closing the page. */
const openCurve = Easing.bezier(0.6, 0, 0.2, 1);
const closeCurve = Easing.bezier(0.6, 0, 0.4, 1);
/** Smallest circle scale; its inverse keeps the page itself at full size. */
const least = 0.002;
type Phase = 'opening' | 'open' | 'closing';
/**
 * v3 product page reveal (prototype `#s-prod` clip-path): the page opens as a
 * circle from the centre of the tapped card, `circle(0)` to `circle(1500px)`
 * over 620 ms, and when it leaves it closes back into that point in 460 ms over
 * the next screen. React Native has no clip-path, so a round, clipping view
 * grows while the page inside it is counter-scaled to stay still. The page is
 * live and pressable from the first frame; under reduced motion it simply
 * appears.
 */
export function RevealCircle({ children }: { children?: ReactNode }) {
  const { v } = useMetrics();
  const screen = useWindowDimensions();
  const reduced = useMotionPreference();
  const leaving = useContext(LeavingContext);
  const [origin] = useState(() => takeProductOrigin());
  const [frame, setFrame] = useState({ x: 0, y: 0, width: screen.width, height: screen.height });
  const [phase, setPhase] = useState<Phase>(() => (reduced ? 'open' : 'opening'));
  const host = useRef<View>(null);
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  // Reduced motion at any point shows the page whole and ends the reveal.
  useEffect(() => {
    if (!reduced) return;
    progress.stopAnimation();
    progress.setValue(1);
    setPhase('open');
  }, [progress, reduced]);
  useEffect(() => {
    if (reduced || phase !== 'opening') return;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: circleOpen,
      easing: openCurve,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setPhase((now) => (now === 'opening' ? 'open' : now));
    });
    return () => animation.stop();
  }, [phase, progress, reduced]);
  // Leaving: close back into the tapped point over the next screen.
  useEffect(() => {
    if (!leaving || reduced) return;
    setPhase('closing');
    const animation = Animated.timing(progress, {
      toValue: 0,
      duration: circleClose,
      easing: closeCurve,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [leaving, progress, reduced]);
  const outer = useMemo(
    () => progress.interpolate({ inputRange: [0, 1], outputRange: [least, 1] }),
    [progress],
  );
  const inner = useMemo(() => Animated.divide(1, outer), [outer]);
  const clipping = phase !== 'open';
  const { width, height } = frame;
  const x = origin ? origin.x - frame.x : width / 2;
  const y = origin ? origin.y - frame.y : height / 2;
  // Prototype radius is 1500 pt on the 820-pt kiosk; never short of a corner.
  const radius = Math.max(v(1500), Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) + 2);
  return (
    <View
      ref={host}
      style={{ flex: 1, minHeight: 0 }}
      onLayout={(event) => {
        const size = event.nativeEvent.layout;
        host.current?.measureInWindow((left, top, w, h) => {
          if (w && h) setFrame({ x: left, y: top, width: w, height: h });
          else setFrame((now) => ({ ...now, width: size.width, height: size.height }));
        });
      }}
    >
      <Animated.View
        style={
          clipping
            ? {
                position: 'absolute',
                left: x - radius,
                top: y - radius,
                width: radius * 2,
                height: radius * 2,
                borderRadius: radius,
                overflow: 'hidden',
                transform: [{ scale: outer }],
              }
            : { flex: 1, minHeight: 0 }
        }
      >
        <Animated.View
          style={
            clipping
              ? { width: radius * 2, height: radius * 2, transform: [{ scale: inner }] }
              : { flex: 1, minHeight: 0 }
          }
        >
          <View
            style={
              clipping
                ? { position: 'absolute', left: radius - x, top: radius - y, width, height }
                : { flex: 1, minHeight: 0 }
            }
          >
            {children}
          </View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}
