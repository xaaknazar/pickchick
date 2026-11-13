import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Icon } from '../../components/UI';
import { cameraFloor, worldScale } from './ascent';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  BOX_HEIGHT,
  BOX_WIDTH,
  PLATFORM_WIDTH,
  WORLD_WIDTH,
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
  impactId: number;
};
const FRONT = require('../../../assets/games/pick-box/front.png');
const LID = require('../../../assets/games/pick-box/lid.png');
// The edge HUD leaves a clear central corridor above the playfield for the longer rope.
const ROPE_ANCHOR_Y = -72;
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
  impactId: -1,
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
  const lidStyle = useAnimatedStyle(() => {
    const pulse = !held && frame.value.impactId === id && frame.value.impact < 220;
    const lift = pulse ? Math.sin((frame.value.impact / 220) * Math.PI) * 0.8 : 0;
    return { transform: [{ perspective: 400 }, { rotateX: `${77 - lift}deg` }] };
  });
  return (
    <Animated.View
      testID={held ? 'pick-box-held' : `pick-box-body-${id}`}
      pointerEvents="none"
      style={[s.box, style]}
    >
      <Animated.Image
        source={LID}
        resizeMode="stretch"
        style={[s.boxLid, lidStyle]}
        accessible={false}
      />
      <View style={s.face}>
        <Image source={FRONT} resizeMode="stretch" style={s.print} accessible={false} />
        <View style={s.lidSeam} />
        <View style={s.fold} />
        <View style={s.boxBottom} />
      </View>
    </Animated.View>
  );
}

function Rope({ frame }: { frame: SharedValue<Frame> }) {
  const style = useAnimatedStyle(() => ({
    opacity: frame.value.rope.visible ? 1 : 0,
    height: frame.value.rope.length,
    transform: [
      { translateX: frame.value.rope.x - 2 },
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
  phase,
}: {
  game: PickBoxEngine;
  reduced: boolean;
  onChange(snapshot: Snapshot): void;
  onCue(cue: Cue): void;
  phase: Snapshot['phase'];
}) {
  const [size, setSize] = useState({ width: 360, height: 440 });
  const [ids, setIds] = useState<number[]>([]);
  const frame = useSharedValue<Frame>(BASE_FRAME);
  const callbacks = useRef({ onChange, onCue });
  callbacks.current = { onChange, onCue };
  const scale = worldScale(size.width, size.height);
  const height = size.height / scale;
  const offsetX = (size.width - 360 * scale) / 2;
  const view = useRef({ game, height, camera: cameraFloor(height, game.top), lastCue: -1 });
  if (view.current.game !== game || view.current.height !== height)
    view.current = { game, height, camera: cameraFloor(height, game.top), lastCue: -1 };
  useEffect(() => {
    let request = 0,
      previous = 0;
    let lastIds = '';
    const tick = (now: number) => {
      const elapsed = previous ? Math.min(now - previous, 50) : 0;
      previous = now;
      game.advance(elapsed);
      const snapshot = game.changed();
      if (snapshot) callbacks.current.onChange(snapshot);
      for (const cue of game.cues) {
        if (game.phase !== 'paused' && cue.time > view.current.lastCue)
          callbacks.current.onCue(cue);
      }
      if (game.cues.length) view.current.lastCue = game.cues[game.cues.length - 1]!.time;
      if (game.phase !== 'paused') {
        const target = cameraFloor(height, game.top);
        view.current.camera = reduced
          ? target
          : view.current.camera + (target - view.current.camera) * (1 - Math.exp(-elapsed / 210));
      }
      const camera = view.current.camera;
      const held = game.held;
      const bodyPoses: Frame['bodies'] = {};
      for (const box of game.boxes) {
        const y = box.body.position.y + camera;
        if (y < -100 || y > height + 100) continue;
        bodyPoses[box.id] = {
          x: box.body.position.x,
          y,
          angle: box.body.angle,
          visible: y > -100 && y < height + 100,
        };
      }
      const currentIds = Object.keys(bodyPoses).map(Number);
      const signature = currentIds.join(',');
      if (signature !== lastIds) {
        setIds(currentIds);
        lastIds = signature;
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
      // Only the rope reaches above the playfield; bodies keep their separate clipping area.
      const anchorY = ROPE_ANCHOR_Y;
      const anchorX = WORLD_WIDTH / 2;
      const dx = endX - anchorX;
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
        impactId:
          !reduced && recentImpact
            ? (game.boxes.find(
                (box) =>
                  Math.abs(box.body.position.x - recentImpact.x) < 15 &&
                  Math.abs(box.body.position.y - recentImpact.y) < BOX_HEIGHT,
              )?.id ?? -1)
            : -1,
        rope: {
          x: anchorX,
          y: anchorY,
          length: Math.sqrt(dx * dx + dy * dy),
          angle: -Math.atan2(dx, dy),
          visible: game.isHolding,
        },
      };
      if (game.needsFrames) request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [game, frame, height, reduced, phase, scale]);

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
      <Animated.View
        pointerEvents="none"
        style={[s.world, { height, left: offsetX, transformOrigin: 'top left' }, worldStyle]}
      >
        <Rope frame={frame} />
        <View testID="pick-box-rope-mount" style={s.ropeMount} />
      </Animated.View>
      <View pointerEvents="none" style={s.bodyClip}>
        <Animated.View
          testID="pick-box-coordinate-space"
          style={[s.world, { height, left: offsetX, transformOrigin: 'top left' }, worldStyle]}
        >
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
          <BoxSprite frame={frame} id={0} held />
          {[0, 1, 2, 3].map((index) => (
            <Spark key={index} frame={frame} index={index} />
          ))}
        </Animated.View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  spark: { position: 'absolute', left: 0, top: 0 },
  viewport: { flex: 1, overflow: 'visible' },
  bodyClip: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  world: { position: 'absolute', width: 360, left: 0, top: 0 },
  box: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: BOX_WIDTH,
    height: BOX_HEIGHT,
  },
  face: {
    width: '100%',
    height: '100%',
    backgroundColor: '#0047BB',
    borderRadius: 1,
    overflow: 'hidden',
    boxShadow: '0px 3px 5px rgba(0, 17, 57, 0.3), inset -2px -1px 3px rgba(0, 17, 57, 0.16)',
  },
  print: { width: '100%', height: '100%' },
  // Original lid print, projected above the collision face. It is occluded naturally
  // by the next box, while the collision width and 23:10 face remain unchanged.
  boxLid: {
    position: 'absolute',
    top: -BOX_WIDTH,
    left: 0,
    width: BOX_WIDTH,
    height: BOX_WIDTH,
    transformOrigin: 'bottom center',
    transform: [{ perspective: 400 }, { rotateX: '77deg' }],
    backgroundColor: '#0047BB',
  },
  lidSeam: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 3,
    backgroundColor: '#0051C4',
    borderTopWidth: 0.7,
    borderTopColor: '#76A8FF',
    borderBottomWidth: 0.8,
    borderBottomColor: '#002E82',
  },
  fold: {
    position: 'absolute',
    top: 3,
    bottom: 1,
    right: 1,
    width: 1,
    backgroundColor: '#002D8044',
  },
  boxBottom: {
    position: 'absolute',
    height: 1,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#8C350E66',
  },
  rope: {
    position: 'absolute',
    width: 4,
    borderRadius: 3,
    backgroundColor: '#C27B28',
    borderWidth: 1,
    borderColor: '#6B431D',
    transformOrigin: 'top center',
  },
  ropeMount: {
    position: 'absolute',
    left: WORLD_WIDTH / 2 - 8,
    top: ROPE_ANCHOR_Y - 8,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 4,
    borderColor: '#18315A',
    backgroundColor: '#FFE1A4',
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
