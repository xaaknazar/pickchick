import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Icon } from '../../components/UI';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  BOX_HEIGHT,
  BOX_WIDTH,
  PLATFORM_WIDTH,
  PickBoxEngine,
  type Cue,
  type Snapshot,
} from './engine';

type DisplayPose = { x: number; y: number; angle: number; visible: boolean };
type Frame = {
  bodies: Record<number, DisplayPose>;
  held: DisplayPose;
  floor: number;
  rope: { x: number; y: number; length: number; angle: number; visible: boolean };
  shake: number;
  impact: number;
  impactX: number;
  impactY: number;
  particles: boolean;
};
const FRONT = require('../../../assets/games/pick-box/front.png');
const BASE_FRAME: Frame = {
  bodies: {},
  held: { x: 180, y: 120, angle: 0, visible: true },
  floor: 420,
  rope: { x: 180, y: 0, length: 140, angle: 0, visible: true },
  shake: 0,
  impact: 1000,
  impactX: 180,
  impactY: 420,
  particles: false,
};

function BoxSprite({
  frame,
  id,
  held = false,
}: {
  frame: SharedValue<Frame>;
  id: number;
  held?: boolean;
}) {
  const style = useAnimatedStyle(() => {
    const box = held ? frame.value.held : frame.value.bodies[id];
    return {
      opacity: box?.visible ? 1 : 0,
      transform: [
        { translateX: (box?.x ?? 0) - BOX_WIDTH / 2 },
        { translateY: (box?.y ?? 0) - BOX_HEIGHT / 2 },
        { rotate: `${box?.angle ?? 0}rad` },
      ],
    };
  });
  return (
    <Animated.View
      testID={held ? 'pick-box-held' : `pick-box-body-${id}`}
      pointerEvents="none"
      style={[s.box, style]}
    >
      <Image source={FRONT} resizeMode="stretch" style={s.print} accessible={false} />
      <View style={s.lid}>
        <View style={s.lidShine} />
      </View>
      <View style={s.boxBottom} />
    </Animated.View>
  );
}

function Rope({ frame }: { frame: SharedValue<Frame> }) {
  const style = useAnimatedStyle(() => ({
    opacity: frame.value.rope.visible ? 1 : 0,
    height: frame.value.rope.length,
    transform: [
      { translateX: frame.value.rope.x - 3 },
      { translateY: frame.value.rope.y },
      { rotate: `${frame.value.rope.angle}rad` },
    ],
  }));
  return (
    <Animated.View pointerEvents="none" style={[s.rope, style]}>
      <View style={s.ropeLight} />
      <View style={s.knot} />
    </Animated.View>
  );
}

function Spark({ frame, index }: { frame: SharedValue<Frame>; index: number }) {
  const style = useAnimatedStyle(() => {
    const progress = Math.min(1, frame.value.impact / 520);
    const direction = index % 2 ? 1 : -1;
    return {
      opacity: frame.value.particles ? 1 - progress : 0,
      transform: [
        { translateX: frame.value.impactX + direction * (38 + progress * (24 + index * 7)) },
        { translateY: frame.value.impactY - 20 - Math.sin(progress * Math.PI) * (20 + index * 5) },
        { rotate: `${direction * progress * 80}deg` },
        { scale: 1 - progress * 0.6 },
      ],
    };
  });
  return (
    <Animated.View style={[s.spark, style]}>
      <Icon name="sparkles" size={index < 2 ? 22 : 14} color="#FFE28A" />
    </Animated.View>
  );
}

/** The HUD renders on events. Box transforms and the camera are shared with the UI thread. */
export function World({
  game,
  reduced,
  onChange,
  onCue,
}: {
  game: PickBoxEngine;
  reduced: boolean;
  onChange(snapshot: Snapshot): void;
  onCue(cue: Cue): void;
}) {
  const [size, setSize] = useState({ width: 360, height: 440 });
  const [ids, setIds] = useState<number[]>([]);
  const frame = useSharedValue<Frame>(BASE_FRAME);
  const callbacks = useRef({ onChange, onCue });
  callbacks.current = { onChange, onCue };
  const scale = size.width / 360;
  const height = size.height / scale;
  useEffect(() => {
    let request = 0,
      previous = 0,
      lastCue = -1,
      camera = height - 52;
    let lastIds = '';
    const tick = (now: number) => {
      const elapsed = previous ? Math.min(now - previous, 50) : 0;
      previous = now;
      game.advance(elapsed);
      const snapshot = game.changed();
      if (snapshot) callbacks.current.onChange(snapshot);
      const currentIds = game.boxes.map((box) => box.id);
      const signature = currentIds.join(',');
      if (signature !== lastIds) {
        setIds(currentIds);
        lastIds = signature;
      }
      for (const cue of game.cues) {
        if (cue.time > lastCue) callbacks.current.onCue(cue);
      }
      if (game.cues.length) lastCue = game.cues[game.cues.length - 1]!.time;
      if (game.phase !== 'paused') {
        const target = Math.max(height - 52, height * 0.66 - game.top);
        camera = reduced ? target : camera + (target - camera) * (1 - Math.exp(-elapsed / 210));
      }
      const held = game.held;
      const bodyPoses: Frame['bodies'] = {};
      for (const box of game.boxes) {
        const y = box.body.position.y + camera;
        bodyPoses[box.id] = {
          x: box.body.position.x,
          y,
          angle: box.body.angle,
          visible: y > -100 && y < height + 100,
        };
      }
      const recentImpact = [...game.cues]
        .reverse()
        .find((c) => c.kind === 'impact' || c.kind === 'collapse');
      const age = recentImpact ? game.time - recentImpact.time : 1000;
      const strength = recentImpact?.kind === 'collapse' ? 4 : 1.8;
      const shake = reduced || age > 200 ? 0 : Math.sin(age * 0.12) * strength * (1 - age / 200);
      // Rope stays attached to the box's top; it is a visual pendulum, never a physics constraint after release.
      const endX = held.x,
        endY = held.y + camera - BOX_HEIGHT / 2;
      const anchorY = -40;
      const dx = endX - 180;
      const dy = endY - anchorY;
      frame.value = {
        bodies: bodyPoses,
        held: { x: held.x, y: held.y + camera, angle: held.angle, visible: game.isHolding },
        floor: camera,
        shake,
        impact: age,
        impactX: recentImpact?.x ?? 180,
        impactY: (recentImpact?.y ?? 0) + camera,
        particles: !reduced && age < 520,
        rope: {
          x: 180,
          y: anchorY,
          length: Math.sqrt(dx * dx + dy * dy),
          angle: -Math.atan2(dx, dy),
          visible: game.isHolding,
        },
      };
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [game, frame, height, reduced]);

  const floorStyle = useAnimatedStyle(() => ({ transform: [{ translateY: frame.value.floor }] }));
  const worldStyle = useAnimatedStyle(() => ({
    transform: [{ scale }, { translateX: frame.value.shake }],
  }));
  return (
    <View
      testID="pick-box-world"
      pointerEvents="none"
      style={s.viewport}
      onLayout={({ nativeEvent }) => setSize(nativeEvent.layout)}
    >
      <Animated.View style={[s.world, { height, transformOrigin: 'top left' }, worldStyle]}>
        <Animated.View style={[s.platform, floorStyle]}>
          <View style={s.platformTop} />
          <View style={s.platformFace}>
            <View style={s.platformLine} />
          </View>
          <View style={s.platformFoot} />
        </Animated.View>
        {ids.map((id) => (
          <BoxSprite key={id} frame={frame} id={id} />
        ))}
        <Rope frame={frame} />
        <BoxSprite frame={frame} id={0} held />
        {[0, 1, 2, 3].map((index) => (
          <Spark key={index} frame={frame} index={index} />
        ))}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  spark: { position: 'absolute', left: 0, top: 0 },
  viewport: { flex: 1, overflow: 'hidden' },
  world: { position: 'absolute', width: 360, left: 0, top: 0 },
  box: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: BOX_WIDTH,
    height: BOX_HEIGHT,
    borderWidth: 2,
    borderColor: '#061B53',
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: '#0047BB',
  },
  print: { width: '100%', height: '100%' },
  lid: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 8,
    backgroundColor: '#0047BB',
    borderBottomWidth: 2,
    borderBottomColor: '#05276D',
  },
  lidShine: { height: 2, backgroundColor: '#719DFD', marginTop: 1, marginHorizontal: 2 },
  boxBottom: {
    position: 'absolute',
    height: 2,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#C34F06',
  },
  rope: {
    position: 'absolute',
    width: 6,
    borderRadius: 3,
    backgroundColor: '#C27B28',
    borderWidth: 1,
    borderColor: '#6B431D',
    transformOrigin: 'top center',
  },
  ropeLight: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 1,
    width: 2,
    backgroundColor: '#FFE1A4',
  },
  knot: {
    position: 'absolute',
    bottom: -4,
    left: -4,
    width: 12,
    height: 10,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#563915',
    backgroundColor: '#FFC66E',
  },
  platform: {
    position: 'absolute',
    left: (360 - PLATFORM_WIDTH) / 2,
    width: PLATFORM_WIDTH,
    height: 45,
  },
  platformTop: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFE99D',
    borderWidth: 2,
    borderColor: '#123454',
  },
  platformFace: {
    height: 24,
    marginHorizontal: 4,
    backgroundColor: '#E4A45E',
    borderWidth: 2,
    borderTopWidth: 0,
    borderColor: '#123454',
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
  },
  platformLine: { height: 2, backgroundColor: '#BD743D', marginTop: 13, marginHorizontal: 8 },
  platformFoot: {
    height: 7,
    marginHorizontal: 24,
    backgroundColor: '#103D53',
    opacity: 0.3,
    borderRadius: 8,
    marginTop: 4,
  },
});
