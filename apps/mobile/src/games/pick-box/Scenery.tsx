import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  interpolate,
  Extrapolation,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

const CITY = require('../../../assets/games/pick-box/almaty.webp');
const SUMMIT = require('../../../assets/games/pick-box/summit.webp');
const ORBIT = require('../../../assets/games/pick-box/orbit.webp');
const ALEX = require('../../../assets/games/pick-box/alex-rocket.webp');
const clamp = Extrapolation.CLAMP;

function Star({
  index,
  time,
  rise,
  width,
  height,
}: {
  index: number;
  time: SharedValue<number>;
  rise: SharedValue<number>;
  width: number;
  height: number;
}) {
  // Seeded positions: no random reshuffle on render or pause/resume.
  const size = index % 4 === 0 ? 2.5 : 1.3;
  const style = useAnimatedStyle(() => ({
    opacity:
      interpolate(rise.value, [27, 36], [0, 0.85], clamp) *
      (0.65 + Math.sin(time.value / 2400 + index * 2.1) * 0.25),
    transform: [
      { translateX: (index * 83.73 + time.value * (0.0005 + (index % 3) * 0.0002)) % width },
      { translateY: (index * 133.17 + time.value * (0.002 + (index % 4) * 0.001)) % height },
    ],
  }));
  return <Animated.View style={[s.star, { width: size, height: size }, style]} />;
}

function Meteor({
  index,
  time,
  rise,
  width,
  height,
}: {
  index: number;
  time: SharedValue<number>;
  rise: SharedValue<number>;
  width: number;
  height: number;
}) {
  const style = useAnimatedStyle(() => {
    const flight = ((time.value + index * 8300) % 19000) / 1100;
    return {
      opacity:
        flight < 1
          ? Math.sin(flight * Math.PI) * interpolate(rise.value, [30, 36], [0, 0.65], clamp)
          : 0,
      transform: [
        { translateX: width * 0.85 - flight * width * 0.8 },
        { translateY: height * 0.22 + flight * height * 0.2 },
        { rotate: '-30deg' },
      ],
    };
  });
  return (
    <Animated.View style={[s.meteor, style]}>
      <View style={s.meteorHead} />
    </Animated.View>
  );
}

/** One UI-thread clock. Pausing freezes the whole world; Reduce Motion keeps static vistas. */
export function Scenery({
  score,
  active,
  reduced,
  width,
  height,
}: {
  score: number;
  active: boolean;
  reduced: boolean;
  width: number;
  height: number;
}) {
  const rise = useSharedValue(score);
  const time = useSharedValue(0);
  const spaceTime = useSharedValue(0);
  useEffect(() => {
    if (score === 0) {
      rise.value = 0;
      time.value = 0;
      spaceTime.value = 0;
    }
    if (reduced) rise.value = score;
  }, [score, reduced, rise, time, spaceTime]);
  useFrameCallback((frame) => {
    if (!active || reduced) return;
    const dt = Math.min(frame.timeSincePreviousFrame ?? 0, 50);
    time.value += dt;
    rise.value += (score - rise.value) * (1 - Math.exp(-dt / 950));
    if (rise.value >= 35) spaceTime.value += dt;
  });
  const city = useAnimatedStyle(() => ({
    opacity: interpolate(rise.value, [8, 19], [1, 0], clamp),
    transform: [{ translateY: interpolate(rise.value, [0, 20], [0, height * 0.24], clamp) }],
  }));
  const mountain = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(rise.value, [10, 30], [0, height * 0.2], clamp) }],
  }));
  const orbit = useAnimatedStyle(() => ({
    opacity: interpolate(rise.value, [24, 34], [0, 1], clamp),
    transform: [{ translateY: interpolate(rise.value, [28, 48], [0, height * 0.16], clamp) }],
  }));
  const atmosphere = useAnimatedStyle(() => ({
    opacity: interpolate(rise.value, [22, 28, 36], [0, 0.45, 0], clamp),
  }));
  const rocket = useAnimatedStyle(() => {
    const flight = (spaceTime.value % 25000) / 9000;
    return {
      opacity: rise.value >= 35 && (reduced || flight < 1) ? 1 : 0,
      transform: [
        { translateX: reduced ? Math.max(8, width - 172) : -170 + flight * (width + 190) },
        {
          translateY: reduced
            ? height * 0.36
            : height * 0.48 - flight * height * 0.23 + Math.sin(flight * 9) * 5,
        },
        { rotate: reduced ? '0deg' : `${Math.sin(flight * 8) * 3}deg` },
      ],
    };
  });
  const imageStyle = { width, height: height * 1.4, top: -height * 0.24 };
  return (
    <View
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={s.scene}
      testID="pick-box-scenery"
    >
      <Animated.Image source={SUMMIT} resizeMode="cover" style={[s.image, imageStyle, mountain]} />
      <Animated.Image source={CITY} resizeMode="cover" style={[s.image, imageStyle, city]} />
      <Animated.Image source={ORBIT} resizeMode="cover" style={[s.image, imageStyle, orbit]} />
      <Animated.View style={[s.atmosphere, atmosphere]} />
      {Array.from({ length: 28 }, (_, i) => (
        <Star key={i} index={i} time={time} rise={rise} width={width} height={height} />
      ))}
      {!reduced &&
        [0, 1].map((i) => (
          <Meteor key={i} index={i} time={time} rise={rise} width={width} height={height} />
        ))}
      <Animated.Image
        testID="pick-box-alex-rocket"
        source={ALEX}
        resizeMode="contain"
        style={[s.rocket, rocket]}
      />
    </View>
  );
}

const s = StyleSheet.create({
  scene: { ...StyleSheet.absoluteFill, overflow: 'hidden', backgroundColor: '#438AD7' },
  image: { position: 'absolute', left: 0, top: 0 },
  atmosphere: { ...StyleSheet.absoluteFill, backgroundColor: '#4C96DA' },
  star: { position: 'absolute', left: 0, top: 0, borderRadius: 2, backgroundColor: '#E5F5FF' },
  meteor: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 42,
    height: 1,
    backgroundColor: '#A6DFFF88',
  },
  meteorHead: { width: 3, height: 2, borderRadius: 2, backgroundColor: '#FFFFFF' },
  rocket: { position: 'absolute', width: 154, height: 103, top: 0, left: 0 },
});
