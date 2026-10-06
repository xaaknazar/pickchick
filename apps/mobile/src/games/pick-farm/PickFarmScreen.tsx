import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  PanResponder,
  Platform,
  Image as NativeImage,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CROPS,
  DECORATIONS,
  ORDERS,
  canWater,
  cropPhase,
  dailyStatus,
  getProgression,
  landBounds,
  goalProgress,
  growthProgress,
  isPlantingCell,
  isUnlockedCell,
  isWatered,
  levelForXp,
  levelUnlocks,
  nextLandCost,
  questProgress,
  tutorialProgress,
  type CropId,
  type FarmCommand,
  type FarmState,
} from '@pickchick/farm-game';
import { GardenArt } from './GardenArt';
import {
  GardenPanels,
  chapterAdvice,
  type GardenPanel,
  type GardenPlacement,
} from './GardenPanels';
import { useFarm, farmMessage } from './useFarm';
import { useFarmSounds } from './useFarmSound';
import { CropArt, GrassGround, Landscape, CellOutline, isoPoint, cellAtPoint } from './visuals';
import { farmPalette as p, farmStyles as s } from './styles';
import { GroundCrop, cropStage } from './PlantingVisual';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  WORLD_CENTER,
  WORLD_OFFSET_Y,
  TREE_ART,
  TREE_IN_BOX,
  fitFarm,
  frameWorldRect,
  screenAtWorld,
  worldAtPagePoint,
  cameraAroundPoint,
  worldPointVisible,
} from './geometry';
import { plotAtPoint } from './hit-zones';
import { useFarmMotion } from './motion';
import { useFarmCamera } from './camera';
import { BADGE_WORLD, Badge, PlotView, type PlotBadge } from './FieldObjects';
import {
  FxLayer,
  HoldRing,
  LevelUp,
  type FarmFx,
  type FarmFxInput,
  type LevelUpInfo,
} from './effects';
import { HudButton, Wallet } from './Hud';
import { Button, FarmPanel, SeedBar, type BasicPanel } from './FarmPanels';
import {
  LandOverlay,
  Pens,
  Scenery,
  landSignAt,
  penAt,
  penCenter,
  sceneryBack,
  sceneryFront,
} from './Ranch';
import { DailyCard, LandPanel, PenPanel } from './RanchPanels';

type Panel = GardenPanel | BasicPanel | 'coop' | 'barn' | 'land' | 'place' | null;
type Placement = { kind: 'bed' } | { kind: 'tree' } | GardenPlacement;
type Plot = FarmState['plots'][number];
type Point = { x: number; y: number };
/** Hold this long without moving to lift an object. */
const HOLD_MS = 320;
/** Finger travel that turns a tap into a pan or a sweep. */
const TAP_SLOP = 10;
/** Distance from the screen edge that scrolls the field while moving an object. */
const EDGE = 56;
const cropFor = (id: CropId) => CROPS.find((c) => c.id === id)!;
/** The 32x32 field with the house above it, in world pixels. */
const PROPERTY_RECT = { minX: -1110, maxX: 2010, minY: -800, maxY: 1070 };
const STATION_CELLS = [
  { x: 13, y: 18 },
  { x: 13, y: 21 },
];

function badgeFor(plot: Plot, now: number, watering: boolean): PlotBadge {
  const phase = cropPhase(plot, now);
  if (phase === 'ready') return 'ready';
  if (phase === 'withered') return 'withered';
  if (phase === 'growing' && watering && canWater(plot, now)) return 'water';
  return null;
}
/** World rectangle that contains the player's garden, or the field center for a new farm. */
function gardenRect(state: FarmState) {
  const points = [
    ...state.plots.map((plot) => isoPoint(plot.x, plot.y)),
    ...getProgression(state)
      .decorations.filter((d) => d.x !== null && d.y !== null)
      .map((d) => isoPoint(d.x!, d.y!)),
  ];
  if (!points.length) {
    const a = isoPoint(28, 27),
      b = isoPoint(35, 34);
    points.push(a, b, isoPoint(28, 34), isoPoint(35, 27));
  }
  return {
    minX: Math.min(...points.map((q) => q.x)) - 70,
    maxX: Math.max(...points.map((q) => q.x)) + 70,
    minY: Math.min(...points.map((q) => q.y)) - 110,
    maxY: Math.max(...points.map((q) => q.y)) + 40,
  };
}
/** Next free cell near the last placement, scanning outward ring by ring. */
function nextFreeCell(state: FarmState, from: Point) {
  const taken = new Set([
    ...state.plots.map((v) => `${v.x},${v.y}`),
    ...getProgression(state)
      .decorations.filter((d) => d.x !== null)
      .map((d) => `${d.x},${d.y}`),
  ]);
  for (let r = 1; r < 32; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = from.x + dx,
          y = from.y + dy;
        if (isUnlockedCell(state, x, y) && !taken.has(`${x},${y}`)) return { x, y };
      }
  return from;
}

export function PickFarmScreen() {
  const router = useRouter();
  const window = useWindowDimensions();
  const [viewport, setViewport] = useState({ width: window.width, height: window.height });
  const { width, height } = viewport;
  const fieldRef = useRef<View>(null);
  const fieldFrame = useRef({ x: 0, y: 0, width, height });
  const measureField = useCallback(() => {
    fieldRef.current?.measure((_x, _y, w, h, pageX, pageY) => {
      if (w > 0 && h > 0) {
        fieldFrame.current = { x: pageX, y: pageY, width: w, height: h };
        setViewport((old) => (old.width === w && old.height === h ? old : { width: w, height: h }));
      }
    });
  }, []);
  useEffect(measureField, [measureField, window.width, window.height]);
  const inset = useSafeAreaInsets();
  const farm = useFarm();
  const { state, confirmed, serverNow, watering, receipt, customerId, v3 } = farm;
  const motion = useFarmMotion();
  const fit = fitFarm(width, height);
  const [cam, view] = useFarmCamera({ fit, width, height });

  const [panel, setPanel] = useState<Panel>(null);
  const [tool, setTool] = useState<'inspect' | 'plant'>('inspect');
  const [destination, setDestination] = useState<'sell' | 'storage'>('sell');
  const [seed, setSeed] = useState<CropId>('carrot');
  const [hint, setHintState] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHint = useCallback((text: string | null, ms = 2600) => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    setHintState(text);
    if (text) hintTimer.current = setTimeout(() => setHintState(null), ms);
  }, []);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedDecoration, setSelectedDecoration] = useState<number | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [cell, setCell] = useState({ x: 32, y: 30 });
  const [drag, setDrag] = useState<{ kind: 'plot' | 'decoration'; id: number } | null>(null);
  const dragPos = useRef(new Animated.ValueXY()).current;
  const [holdAt, setHoldAt] = useState<Point | null>(null);
  const sfx = useFarmSounds(motion.active);
  const sound = sfx.enabled;
  const setSound = sfx.setEnabled;
  const play = sfx.play;
  const [daily, setDaily] = useState(false);
  const [fx, setFx] = useState<FarmFx[]>([]);
  const fxId = useRef(0);
  const addFx = useCallback((items: FarmFxInput[]) => {
    setFx((old) => [
      ...old.slice(-36),
      ...items.map((item) => ({ ...item, id: ++fxId.current }) as FarmFx),
    ]);
  }, []);
  const removeFx = useCallback((id: number) => setFx((old) => old.filter((f) => f.id !== id)), []);
  const [levelUp, setLevelUp] = useState<LevelUpInfo | null>(null);

  // HUD anchors for flying rewards, in screen coordinates.
  const top = Math.max(10, inset.top);
  const bottom = Math.max(10, inset.bottom);
  const left = Math.max(14, inset.left);
  const right = Math.max(14, inset.right);
  const anchors = useRef({
    coins: { x: 120, y: 34 },
    level: { x: 230, y: 34 },
    storage: { x: width - 140, y: 34 },
  });
  const rightHud = useRef(0);
  const below = useRef({ coins: 70, level: 70 });
  const onCoinsLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const l = e.nativeEvent.layout;
      anchors.current.coins = { x: left + l.x + 24, y: top + l.y + l.height / 2 };
      below.current.coins = top + l.y + l.height + 6;
    },
    [left, top],
  );
  const onLevelLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const l = e.nativeEvent.layout;
      anchors.current.level = { x: left + l.x + l.width / 2, y: top + l.y + l.height / 2 };
      below.current.level = top + l.y + l.height + 6;
    },
    [left, top],
  );
  const onStorageLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const l = e.nativeEvent.layout;
      anchors.current.storage = {
        x: rightHud.current + l.x + l.width / 2,
        y: top + l.y + l.height / 2,
      };
    },
    [top],
  );

  /** Screen point of an object's visual center. */
  const screenOf = useCallback(
    (x: number, y: number, lift = 36) => {
      const w = isoPoint(x, y);
      return screenAtWorld({ x: w.x, y: w.y - lift }, cam.camera.current, fit, width, height);
    },
    [cam.camera, fit, width, height],
  );
  const worldAt = useCallback(
    (page: Point) => worldAtPagePoint(page, fieldFrame.current, cam.camera.current, fit),
    [cam.camera, fit],
  );

  // --- Actions ------------------------------------------------------------------------------
  const run = useCallback(
    (command: FarmCommand, options: { silent?: boolean } = {}) => {
      const ticket = farm.submit(command);
      if (!ticket.accepted && !options.silent) showHint(farmMessage(ticket.code));
      return ticket.accepted;
    },
    [farm, showHint],
  );
  const harvestPlot = useCallback(
    (plot: Plot, silent = false) => {
      if (!run({ type: 'harvest', plotId: plot.id, destination }, { silent })) return false;
      play('harvest');
      const from = screenOf(plot.x, plot.y, plot.kind === 'tree' ? 85 : 40);
      const toCoins = destination === 'sell';
      const scale = fit * cam.camera.current.zoom;
      if (plot.kind === 'bed' && plot.cropId)
        addFx([
          {
            kind: 'pluck',
            base: screenOf(plot.x, plot.y, -17),
            size: 96 * 0.93 * scale,
            cropId: plot.cropId,
          },
        ]);
      addFx(
        [0, 1, 2].map((i) => ({
          kind: 'fly' as const,
          from: { x: from.x + (i - 1) * 12, y: from.y },
          to: toCoins ? anchors.current.coins : anchors.current.storage,
          cropId: toCoins ? undefined : (plot.cropId ?? undefined),
          coin: toCoins,
          delay: i * 70,
        })),
      );
      return true;
    },
    [run, destination, screenOf, addFx, fit, cam.camera, play],
  );
  const waterPlot = useCallback(
    (plot: Plot, silent = false) => {
      if (!run({ type: 'water', plotId: plot.id }, { silent })) return false;
      play('water');
      const at = screenOf(plot.x, plot.y, 0);
      addFx([{ kind: 'water', at, size: 80 * fit * cam.camera.current.zoom }]);
      return true;
    },
    [run, screenOf, addFx, fit, cam.camera, play],
  );
  const plantPlot = useCallback(
    (plot: Plot, cropId: CropId, silent = false) => {
      const ok = run({ type: 'plant', plotId: plot.id, cropId }, { silent });
      if (ok) play('plant');
      return ok;
    },
    [run, play],
  );
  const clearPlot = useCallback(
    (plot: Plot) => {
      if (!run({ type: 'clear', plotId: plot.id })) return false;
      addFx([
        {
          kind: 'puff',
          at: screenOf(plot.x, plot.y, 10),
          size: 96 * fit * cam.camera.current.zoom,
        },
      ]);
      return true;
    },
    [run, screenOf, addFx, fit, cam.camera],
  );
  /** Panel buttons: run and optionally close the panel at once (the field shows the result). */
  const panelAct = useCallback(
    (command: FarmCommand, options: { close?: boolean } = {}) => {
      const plot =
        'plotId' in command ? state?.plots.find((v) => v.id === command.plotId) : undefined;
      const ok =
        command.type === 'water' && plot
          ? waterPlot(plot)
          : command.type === 'harvest' && plot
            ? harvestPlot(plot)
            : command.type === 'clear' && plot
              ? clearPlot(plot)
              : run(command);
      if (ok && command.type === 'collectAnimals') {
        const good = command.kind === 'chicken' ? 'egg' : 'milk';
        const center = penCenter(command.kind === 'chicken' ? 'coop' : 'barn');
        const from = screenAtWorld(
          { x: center.x, y: center.y - 30 },
          cam.camera.current,
          fit,
          width,
          height,
        );
        play(command.kind === 'chicken' ? 'cluck' : 'moo');
        addFx(
          [0, 1, 2].map((i) => ({
            kind: 'fly' as const,
            from: { x: from.x + (i - 1) * 16, y: from.y },
            to: anchors.current.storage,
            good,
            delay: i * 80,
          })),
        );
      } else if (ok && command.type === 'expandLand' && state) {
        // The new ring of land opens with a puff along its edge.
        const b = landBounds(state);
        const n = { minX: b.minX - 2, maxX: b.maxX + 2, minY: b.minY - 2, maxY: b.maxY + 2 };
        const mx = (n.minX + n.maxX) / 2,
          my = (n.minY + n.maxY) / 2;
        play('level');
        addFx(
          [
            [n.minX, n.minY],
            [n.maxX, n.minY],
            [n.maxX, n.maxY],
            [n.minX, n.maxY],
            [mx, n.minY],
            [n.maxX, my],
            [mx, n.maxY],
            [n.minX, my],
          ].map(([x, y]) => ({
            kind: 'puff' as const,
            at: screenAtWorld(isoPoint(x!, y!), cam.camera.current, fit, width, height),
            size: 140 * fit * cam.camera.current.zoom,
          })),
        );
      } else if (ok && ['buyPen', 'buyAnimal', 'feedAnimals', 'buyStation'].includes(command.type))
        play('tap');
      if (ok && options.close) {
        setPanel(null);
        if (['removePlot', 'storePlot', 'removeCrop'].includes(command.type)) setSelected(null);
      }
      return ok;
    },
    [state, waterPlot, harvestPlot, clearPlot, run, play, addFx, cam.camera, fit, width, height],
  );

  // --- Receipts, level ups -------------------------------------------------------------------
  useEffect(() => {
    if (!receipt) return;
    const items: FarmFxInput[] = [];
    if (receipt.coins > 0)
      items.push({
        kind: 'pop',
        at: { x: anchors.current.coins.x + 20, y: below.current.coins },
        text: `+${receipt.coins}`,
        tone: 'coin',
      });
    if (receipt.xp > 0)
      items.push({
        kind: 'pop',
        at: { x: anchors.current.level.x, y: below.current.level },
        text: `+${receipt.xp} XP`,
        tone: 'xp',
      });
    if (receipt.text)
      items.push({
        kind: 'pop',
        at: { x: anchors.current.storage.x - 20, y: anchors.current.storage.y + 30 },
        text: receipt.text,
        tone: 'info',
      });
    if (items.length) addFx(items);
    if (receipt.coins > 0) play('coin');
  }, [receipt, addFx, play]);
  // An older Farm API rejects watering once; explain it instead of failing silently.
  const wateringBefore = useRef(watering);
  useEffect(() => {
    if (wateringBefore.current && !watering) showHint(farmMessage('WATER_UNAVAILABLE'), 4200);
    wateringBefore.current = watering;
  }, [watering, showHint]);
  const lastLevel = useRef<number | null>(null);
  useEffect(() => {
    if (!confirmed) return;
    const level = levelForXp(confirmed.xp);
    const before = lastLevel.current;
    lastLevel.current = level;
    if (before === null || level <= before) return;
    const was = levelUnlocks(before),
      now = levelUnlocks(level);
    const unlocks = [
      ...now.decorations
        .filter((d) => !was.decorations.includes(d))
        .map((d) => `Украшение «${d.name}»`),
      ...now.recipes.filter((r) => !was.recipes.includes(r)).map((r) => `Рецепт «${r.name}»`),
      ...now.stations
        .filter((v) => !was.stations.includes(v))
        .map((v) => (v === 'kitchen' ? 'Садовая кухня' : 'Цветочная мастерская')),
      ...(now.houseStyles.length > was.houseStyles.length ? ['Новое оформление дома'] : []),
    ];
    setLevelUp({ level, unlocks });
    play('level');
  }, [confirmed, play]);

  // --- Camera: restore, frame the garden, save --------------------------------------------
  const cameraKey = customerId ? `pickchick.farm.camera.v2.${customerId}` : null;
  const framed = useRef(false);
  const hasState = !!state;
  useEffect(() => {
    if (!hasState || framed.current || !cameraKey || !state) return;
    framed.current = true;
    const frame = () => {
      const target = frameWorldRect(gardenRect(state), fit, width, height);
      cam.set(target.x, target.y, target.zoom, true);
    };
    void AsyncStorage.getItem(cameraKey)
      .then((raw) => {
        const v = raw ? JSON.parse(raw) : null;
        if (v && [v.x, v.y, v.zoom].every(Number.isFinite)) cam.set(v.x, v.y, v.zoom, true);
        else frame();
      })
      .catch(frame);
    // Framing uses the first loaded farm only; later updates never move the camera.
  }, [hasState, cameraKey]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveCamera = useCallback(() => {
    if (!cameraKey) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void AsyncStorage.setItem(cameraKey, JSON.stringify(cam.camera.current)).catch(
        () => undefined,
      );
    }, 700);
  }, [cameraKey, cam.camera]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );
  // Keep the camera valid when the screen size changes (rotation, split view).
  useEffect(() => {
    const c = cam.camera.current;
    cam.set(c.x, c.y, c.zoom, true);
    // Only a new layout re-validates the camera; the controls object itself is stable.
  }, [fit, width, height, cam]);
  /** Side sheet for buildings and land: the object stays visible in the free left part. */
  const sideWidth = Math.min(380, Math.round(width * 0.5));
  const focusPoint = useCallback(
    (point: Point, minZoom = 2) => {
      const zoom = Math.max(cam.camera.current.zoom, minZoom);
      const s = fit * zoom;
      const target = { x: (width - sideWidth) / 2, y: height * 0.58 };
      cam.animateTo({
        x: target.x - width / 2 - (point.x - WORLD_CENTER.x) * s,
        y: target.y - height / 2 - WORLD_OFFSET_Y - (point.y - WORLD_CENTER.y) * s,
        zoom,
      });
    },
    [cam, fit, width, height, sideWidth],
  );
  const focusCell = useCallback(
    (x: number, y: number, minZoom = 3) => {
      const point = isoPoint(x, y);
      const zoom = Math.max(cam.camera.current.zoom, minZoom);
      const s = fit * zoom;
      cam.animateTo({
        x: -(point.x - WORLD_CENTER.x) * s,
        y: 16 - WORLD_OFFSET_Y - (point.y - WORLD_CENTER.y) * s,
        zoom,
      });
    },
    [cam, fit],
  );
  const zoomAt = useCallback(
    (page: Point, factor: number, animate = true) => {
      const pivot = {
        x: page.x - fieldFrame.current.x - width / 2,
        y: page.y - fieldFrame.current.y - height / 2 - WORLD_OFFSET_Y,
      };
      const next = cameraAroundPoint(cam.camera.current, pivot, cam.camera.current.zoom * factor);
      if (animate) cam.animateTo(next, 260);
      else cam.set(next.x, next.y, next.zoom);
      saveCamera();
    },
    [cam, width, height, saveCamera],
  );

  // Web: mouse wheel zoom, so desktop previews behave like a pinch.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = fieldRef.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt({ x: event.pageX, y: event.pageY }, Math.exp(-event.deltaY * 0.0022), false);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [zoomAt, hasState]);

  // --- Gestures ------------------------------------------------------------------------------
  // One responder for the whole screen; it reads the latest values through this ref, so a
  // state update in the middle of a sweep never replaces the gesture handler.
  const live = useRef({
    state,
    serverNow,
    panel,
    tool,
    seed,
    watering,
    destination,
    placement,
    cell,
    v3,
  });
  live.current = {
    state,
    serverNow,
    panel,
    tool,
    seed,
    watering,
    destination,
    placement,
    cell,
    v3,
  };
  const actions = useRef({
    harvestPlot,
    waterPlot,
    plantPlot,
    clearPlot,
    run,
    showHint,
    zoomAt,
    saveCamera,
    focusPoint,
  });
  actions.current = {
    harvestPlot,
    waterPlot,
    plantPlot,
    clearPlot,
    run,
    showHint,
    zoomAt,
    saveCamera,
    focusPoint,
  };
  const gesture = useRef({
    mode: 'idle' as 'idle' | 'pending' | 'pan' | 'pinch' | 'sweep' | 'drag' | 'place',
    start: { x: 0, y: 0 },
    startCam: { x: 0, y: 0, zoom: 1 },
    sweep: null as 'harvest' | 'water' | 'plant' | null,
    swept: new Set<number>(),
    lastWorld: { x: 0, y: 0 },
    samples: [] as { t: number; x: number; y: number }[],
    pinch: { distance: 0, zoom: 1, mid: { x: 0, y: 0 }, cam: { x: 0, y: 0, zoom: 1 } },
    target: null as { kind: 'plot' | 'decoration'; id: number; x: number; y: number } | null,
    lifted: false,
    moved: false,
    offset: { x: 0, y: 0 },
    page: { x: 0, y: 0 },
    lastTap: { t: 0, x: 0, y: 0 },
  }).current;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (ringTimer.current) clearTimeout(ringTimer.current);
    holdTimer.current = ringTimer.current = null;
    setHoldAt(null);
  }, []);
  const edge = useRef<{ frame: number | null; vx: number; vy: number }>({
    frame: null,
    vx: 0,
    vy: 0,
  });
  const stopEdge = useCallback(() => {
    if (edge.current.frame !== null) cancelAnimationFrame(edge.current.frame);
    edge.current = { frame: null, vx: 0, vy: 0 };
  }, []);
  const hitOptions = useCallback(() => {
    const scale = fit * cam.camera.current.zoom;
    const L = live.current;
    return {
      badgeRadius: 18 / scale,
      slop: 12 / scale,
      badged: (plot: Plot) => {
        const badge = badgeFor(plot, L.serverNow, L.watering);
        return badge === 'ready' || badge === 'withered';
      },
    };
  }, [fit, cam.camera]);
  const plotUnder = useCallback(
    (world: Point, withSlop = true) => {
      const L = live.current;
      if (!L.state) return undefined;
      const options = hitOptions();
      return plotAtPoint(
        L.state.plots,
        world,
        L.serverNow,
        withSlop ? options : { ...options, slop: 0 },
      );
    },
    [hitOptions],
  );
  const decorationUnder = useCallback((world: Point) => {
    const L = live.current;
    if (!L.state) return undefined;
    const ground = cellAtPoint(world.x, world.y);
    // The art stands above its cell: also test the cell just in front of the touch.
    const lifted = cellAtPoint(world.x, world.y + 30);
    const placed = getProgression(L.state).decorations;
    return (
      placed.find((d) => d.x === ground.x && d.y === ground.y) ??
      placed.find((d) => d.x === lifted.x && d.y === lifted.y)
    );
  }, []);
  /** Apply the sweep's action to every object the finger passes over. */
  const sweepAlong = useCallback(
    (from: Point, to: Point) => {
      const L = live.current;
      if (!L.state || !gesture.sweep) return;
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 14));
      for (let i = 0; i <= steps; i++) {
        const point = {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        };
        const plot = plotUnder(point, false);
        if (!plot || gesture.swept.has(plot.id)) continue;
        gesture.swept.add(plot.id);
        const phase = cropPhase(plot, L.serverNow);
        const a = actions.current;
        if (gesture.sweep === 'harvest' && phase === 'ready') a.harvestPlot(plot, true);
        else if (gesture.sweep === 'water' && canWater(plot, L.serverNow)) a.waterPlot(plot, true);
        else if (gesture.sweep === 'plant' && plot.kind === 'bed' && plot.cropId === null) {
          if (!a.plantPlot(plot, L.seed, true) && L.state.coins < cropFor(L.seed).seedCost)
            a.showHint('Не хватает монет на семена.');
        }
      }
    },
    [gesture, plotUnder],
  );
  const dragCell = useCallback(
    (page: Point) => {
      const w = worldAt(page);
      return cellAtPoint(w.x + gesture.offset.x, w.y + gesture.offset.y);
    },
    [worldAt, gesture],
  );
  const updateDrag = useCallback(
    (page: Point) => {
      gesture.page = page;
      const w = worldAt(page);
      const centre = { x: w.x + gesture.offset.x, y: w.y + gesture.offset.y };
      dragPos.setValue(centre);
      const next = cellAtPoint(centre.x, centre.y);
      setCell((old) => (old.x === next.x && old.y === next.y ? old : next));
      // Near the screen edge the field scrolls under the lifted object.
      const f = fieldFrame.current;
      const lx = page.x - f.x,
        ly = page.y - f.y;
      const push = (d: number) => (d < EDGE ? ((EDGE - d) / EDGE) * 9 : 0);
      const vx = push(lx) - push(f.width - lx);
      const vy = push(ly - top) - push(f.height - ly);
      edge.current.vx = vx;
      edge.current.vy = vy;
      if ((vx || vy) && edge.current.frame === null) {
        const step = () => {
          const { vx: x, vy: y } = edge.current;
          if (!x && !y) {
            edge.current.frame = null;
            return;
          }
          const c = cam.camera.current;
          cam.set(c.x + x, c.y + y, c.zoom);
          const w2 = worldAt(gesture.page);
          const centre2 = { x: w2.x + gesture.offset.x, y: w2.y + gesture.offset.y };
          dragPos.setValue(centre2);
          const n = cellAtPoint(centre2.x, centre2.y);
          setCell((old) => (old.x === n.x && old.y === n.y ? old : n));
          edge.current.frame = requestAnimationFrame(step);
        };
        edge.current.frame = requestAnimationFrame(step);
      }
    },
    [worldAt, gesture, dragPos, cam, top],
  );
  const lift = useCallback(() => {
    const target = gesture.target;
    if (!target || gesture.mode !== 'pending') return;
    gesture.mode = 'drag';
    gesture.lifted = true;
    gesture.moved = false;
    const centre = isoPoint(target.x, target.y);
    const w = worldAt(gesture.start);
    gesture.offset = { x: centre.x - w.x, y: centre.y - w.y };
    dragPos.setValue(centre);
    setCell({ x: target.x, y: target.y });
    setDrag({ kind: target.kind, id: target.id });
    if (target.kind === 'plot') setSelected(target.id);
    else setSelectedDecoration(target.id);
    setPanel(null);
    setHoldAt(null);
  }, [gesture, worldAt, dragPos]);
  const finishDrag = useCallback(
    (page: Point) => {
      stopEdge();
      const target = gesture.target!;
      const L = live.current;
      setDrag(null);
      if (!gesture.moved) {
        // Hold and release in place opens the object's actions.
        if (target.kind === 'plot') {
          setSelected(target.id);
          setPanel('plot');
        } else {
          setSelectedDecoration(target.id);
          setPanel('decoration');
        }
        return;
      }
      const to = dragCell(page);
      if (to.x === target.x && to.y === target.y) return;
      const progression = L.state ? getProgression(L.state) : null;
      const taken =
        L.state?.plots.some(
          (v) => !(target.kind === 'plot' && v.id === target.id) && v.x === to.x && v.y === to.y,
        ) ||
        progression?.decorations.some(
          (d) =>
            !(target.kind === 'decoration' && d.id === target.id) && d.x === to.x && d.y === to.y,
        );
      if (!L.state || !isUnlockedCell(L.state, to.x, to.y) || taken) {
        actions.current.showHint('Перенос отменён: нужна свободная клетка внутри участка.');
        return;
      }
      actions.current.run(
        target.kind === 'plot'
          ? { type: 'movePlot', plotId: target.id, ...to }
          : { type: 'moveDecoration', instanceId: target.id, ...to },
      );
    },
    [gesture, dragCell, stopEdge],
  );
  const tapAt = useCallback(
    (page: Point) => {
      const L = live.current;
      if (!L.state) return;
      const world = worldAt(page);
      if (L.panel === 'place') {
        setCell(cellAtPoint(world.x, world.y));
        return;
      }
      if (L.panel && L.panel !== 'plot' && L.panel !== 'decoration' && L.panel !== 'seeds') {
        // A tap on the field closes a large panel first; no action happens underneath it.
        setPanel(null);
        return;
      }
      const a = actions.current;
      const plot = plotUnder(world);
      if (plot) {
        setSelected(plot.id);
        setSelectedDecoration(null);
        const phase = cropPhase(plot, L.serverNow);
        if (phase === 'ready') {
          setPanel(null);
          a.harvestPlot(plot);
        } else if (phase === 'withered') {
          setPanel(null);
          a.clearPlot(plot);
        } else if (phase === 'growing') {
          if (L.watering && canWater(plot, L.serverNow)) {
            setPanel(null);
            a.waterPlot(plot);
          } else setPanel('plot');
        } else if (plot.kind === 'bed') {
          if (L.tool === 'plant') {
            setPanel(null);
            if (a.plantPlot(plot, L.seed, true)) return;
            a.showHint(
              L.state.coins < cropFor(L.seed).seedCost
                ? 'Не хватает монет на семена.'
                : farmMessage('PLOT_OCCUPIED'),
            );
          } else {
            setPanel('seeds');
            // Keep the bed visible above the seed bar.
            const at = screenAtWorld(
              isoPoint(plot.x, plot.y),
              cam.camera.current,
              fit,
              width,
              height,
            );
            if (at.y > height - 150) {
              const c = cam.camera.current;
              cam.animateTo({ x: c.x, y: c.y - (at.y - (height - 170)), zoom: c.zoom }, 260);
            }
          }
        } else setPanel('plot');
        return;
      }
      const decoration = decorationUnder(world);
      if (decoration) {
        setSelectedDecoration(decoration.id);
        setSelected(null);
        setPanel('decoration');
        return;
      }
      const station = getProgression(L.state).stations.findIndex((_, i) => {
        const pt = isoPoint(STATION_CELLS[i]!.x, STATION_CELLS[i]!.y);
        return Math.abs(world.x - pt.x) < 64 && world.y > pt.y - 125 && world.y < pt.y + 12;
      });
      if (station >= 0) {
        setPanel('workshop');
        return;
      }
      const ground = cellAtPoint(world.x, world.y);
      if (L.v3) {
        const pen = penAt(world);
        if (pen) {
          setSelected(null);
          setSelectedDecoration(null);
          setPanel(pen);
          a.focusPoint(penCenter(pen), 2.2);
          return;
        }
        if (
          landSignAt(L.state, world) ||
          (isPlantingCell(ground.x, ground.y) && !isUnlockedCell(L.state, ground.x, ground.y))
        ) {
          setSelected(null);
          setSelectedDecoration(null);
          setPanel('land');
          // Show the open square's front corner beside the sheet.
          const b = landBounds(L.state);
          a.focusPoint(isoPoint(b.maxX + 1, b.maxY + 1), 1);
          return;
        }
      }
      if (ground.x < 16 && ground.y < 16) {
        setPanel('house');
        return;
      }
      setPanel(null);
      setSelected(null);
      setSelectedDecoration(null);
      // Double tap on open ground zooms in around the finger.
      const now = Date.now();
      const last = gesture.lastTap;
      if (now - last.t < 320 && Math.hypot(page.x - last.x, page.y - last.y) < 36) {
        gesture.lastTap = { t: 0, x: 0, y: 0 };
        a.zoomAt(page, cam.camera.current.zoom >= MAX_ZOOM - 0.01 ? 0.4 : 2);
      } else gesture.lastTap = { t: now, x: page.x, y: page.y };
    },
    [worldAt, plotUnder, decorationUnder, gesture, cam, fit, width, height],
  );
  const beginPinch = useCallback(
    (e: GestureResponderEvent) => {
      const [a, b] = e.nativeEvent.touches;
      if (!a || !b) return;
      cancelHold();
      stopEdge();
      if (gesture.mode === 'drag') setDrag(null);
      gesture.mode = 'pinch';
      gesture.pinch = {
        distance: Math.max(1, Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY)),
        zoom: cam.camera.current.zoom,
        mid: { x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 },
        cam: { ...cam.camera.current },
      };
    },
    [gesture, cam, cancelHold, stopEdge],
  );
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          cam.stop();
          stopEdge();
          cancelHold();
          const page = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
          Object.assign(gesture, {
            mode: 'pending',
            start: page,
            page,
            startCam: { ...cam.camera.current },
            sweep: null,
            target: null,
            lifted: false,
            moved: false,
            samples: [{ t: Date.now(), ...page }],
          });
          gesture.swept.clear();
          if (e.nativeEvent.touches.length > 1) return beginPinch(e);
          const L = live.current;
          const world = worldAt(page);
          gesture.lastWorld = world;
          if (L.panel === 'place') {
            gesture.mode = 'place';
            return;
          }
          if (!L.state || (L.panel && !['plot', 'decoration', 'seeds'].includes(L.panel))) return;
          const plot = plotUnder(world);
          const decoration = plot ? undefined : decorationUnder(world);
          if (plot) {
            gesture.target = { kind: 'plot', id: plot.id, x: plot.x, y: plot.y };
            const phase = cropPhase(plot, L.serverNow);
            gesture.sweep =
              phase === 'ready'
                ? 'harvest'
                : L.watering && canWater(plot, L.serverNow)
                  ? 'water'
                  : L.tool === 'plant' && plot.kind === 'bed' && plot.cropId === null
                    ? 'plant'
                    : null;
          } else if (decoration && decoration.x !== null && decoration.y !== null)
            gesture.target = {
              kind: 'decoration',
              id: decoration.id,
              x: decoration.x,
              y: decoration.y,
            };
          if (gesture.target) {
            ringTimer.current = setTimeout(
              () =>
                setHoldAt({ x: page.x - fieldFrame.current.x, y: page.y - fieldFrame.current.y }),
              90,
            );
            holdTimer.current = setTimeout(lift, HOLD_MS);
          }
        },
        onPanResponderMove: (e, g) => {
          const touches = e.nativeEvent.touches;
          if (touches.length > 1) {
            if (gesture.mode !== 'pinch') return beginPinch(e);
            const [a, b] = touches;
            const start = gesture.pinch;
            const mid = { x: (a!.pageX + b!.pageX) / 2, y: (a!.pageY + b!.pageY) / 2 };
            const d = Math.max(1, Math.hypot(a!.pageX - b!.pageX, a!.pageY - b!.pageY));
            // Zoom about the first midpoint, then follow the fingers: pinch and two-finger pan.
            const pivot = {
              x: start.mid.x - fieldFrame.current.x - width / 2,
              y: start.mid.y - fieldFrame.current.y - height / 2 - WORLD_OFFSET_Y,
            };
            const zoomed = cameraAroundPoint(start.cam, pivot, (start.zoom * d) / start.distance);
            cam.set(zoomed.x + mid.x - start.mid.x, zoomed.y + mid.y - start.mid.y, zoomed.zoom);
            return;
          }
          if (gesture.mode === 'pinch') return;
          const page = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
          const travelled = Math.hypot(g.dx, g.dy);
          if (gesture.mode === 'drag') {
            if (travelled > 3) gesture.moved = true;
            updateDrag(page);
            return;
          }
          if (gesture.mode === 'place') {
            if (travelled > TAP_SLOP || gesture.moved) {
              gesture.moved = true;
              const w = worldAt(page);
              const next = cellAtPoint(w.x, w.y);
              setCell((old) => (old.x === next.x && old.y === next.y ? old : next));
            }
            return;
          }
          if (gesture.mode === 'pending' && travelled > TAP_SLOP) {
            cancelHold();
            gesture.moved = true;
            gesture.mode = gesture.sweep ? 'sweep' : 'pan';
            if (gesture.mode === 'sweep') sweepAlong(gesture.lastWorld, gesture.lastWorld);
          }
          if (gesture.mode === 'sweep') {
            const world = worldAt(page);
            sweepAlong(gesture.lastWorld, world);
            gesture.lastWorld = world;
          } else if (gesture.mode === 'pan') {
            cam.set(gesture.startCam.x + g.dx, gesture.startCam.y + g.dy, gesture.startCam.zoom);
            gesture.samples.push({ t: Date.now(), ...page });
            if (gesture.samples.length > 6) gesture.samples.shift();
          }
        },
        onPanResponderRelease: (e) => {
          cancelHold();
          const page = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
          const mode = gesture.mode;
          gesture.mode = 'idle';
          if (mode === 'drag') finishDrag(page);
          else if (mode === 'sweep') sweepAlong(gesture.lastWorld, worldAt(page));
          else if (mode === 'pan') {
            const first = gesture.samples[0]!,
              last = gesture.samples.at(-1)!;
            const ms = Math.max(1, Date.now() - first.t);
            const vx = (last.x - first.x) / ms,
              vy = (last.y - first.y) / ms;
            if (Date.now() - last.t < 80 && Math.hypot(vx, vy) > 0.25) cam.fling(vx, vy);
          } else if (mode === 'pending') tapAt(page);
          else if (mode === 'place' && !gesture.moved) tapAt(page);
          actions.current.saveCamera();
        },
        onPanResponderTerminate: () => {
          cancelHold();
          stopEdge();
          if (gesture.mode === 'drag') setDrag(null);
          gesture.mode = 'idle';
        },
      }),
    // The handler is created once per layout; live values are read through refs.
    [
      cam,
      gesture,
      width,
      height,
      worldAt,
      plotUnder,
      decorationUnder,
      sweepAlong,
      updateDrag,
      finishDrag,
      tapAt,
      lift,
      beginPinch,
      cancelHold,
      stopEdge,
    ],
  );
  useEffect(() => () => cancelHold(), [cancelHold]);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (panel || tool !== 'inspect') {
        setPanel(null);
        setTool('inspect');
        showHint(null);
        return true;
      }
      return false;
    });
    return () => back.remove();
  }, [panel, tool, showHint]);

  // --- Derived view data ---------------------------------------------------------------------
  const badgeScale = useMemo(() => {
    // Screen sizes of a badge at zoom 1, 2, 3 and 6: readable overview, calm close-up.
    const stops: [number, number][] = [
      [1, 13],
      [2, 17],
      [3, 20],
      [6, 26],
    ];
    return cam.zoom.interpolate({
      inputRange: stops.map(([z]) => z),
      outputRange: stops.map(([z, px]) => px / (BADGE_WORLD * fit * z)),
      extrapolate: 'clamp',
    });
  }, [cam.zoom, fit]);
  const waterOpacity = useMemo(
    () =>
      cam.zoom.interpolate({
        inputRange: [1, 1.5, 1.9],
        outputRange: [0, 0, 1],
        extrapolate: 'clamp',
      }),
    [cam.zoom],
  );
  const worldScale = useMemo(() => Animated.multiply(cam.zoom, fit), [cam.zoom, fit]);
  const visible = useCallback(
    (point: Point) => worldPointVisible(point, view, fit, width, height),
    [view, fit, width, height],
  );
  // The daily gift greets a returning player once per visit (not on the very first screen).
  const dailyShown = useRef(false);
  const plotCount = state?.plots.length ?? 0;
  const dailyReady = !!state && v3 && dailyStatus(state, serverNow).available;
  useEffect(() => {
    if (dailyShown.current || !dailyReady || plotCount === 0 || serverNow === 0) return;
    dailyShown.current = true;
    setDaily(true);
  }, [dailyReady, plotCount, serverNow]);
  const plotsView = useMemo(() => {
    if (!state) return [];
    return state.plots
      .filter((plot) => worldPointVisible(isoPoint(plot.x, plot.y), view, fit, width, height))
      .sort((a, b) => a.x + a.y - b.x - b.y)
      .map((plot) => {
        const phase = cropPhase(plot, serverNow);
        const point = isoPoint(plot.x, plot.y);
        return {
          id: plot.id,
          left: point.x,
          top: point.y,
          kind: plot.kind,
          cropId: plot.cropId,
          stage: cropStage(plot.cropId, phase, growthProgress(plot, serverNow), plot.kind),
          watered: isWatered(plot) && phase === 'growing',
          badge: badgeFor(plot, serverNow, watering),
        };
      });
  }, [state, serverNow, view, fit, width, height, watering]);

  if (!state)
    return (
      <View ref={fieldRef} collapsable={false} onLayout={measureField} style={s.screen}>
        <View style={s.center}>
          <CropArt cropId="apple" size={84} />
          <Text style={s.title}>PICK FARM</Text>
          {farm.loading ? (
            <>
              <ActivityIndicator color={p.blue} />
              <Text style={s.text}>Открываем вашу ферму...</Text>
            </>
          ) : (
            <>
              <Text style={[s.text, { textAlign: 'center', maxWidth: 420 }]}>
                {farm.error || 'Не удалось открыть ферму.'}
              </Text>
              <Button label="Попробовать снова" icon="refresh" primary onPress={farm.retry} />
            </>
          )}
          <Button label="Выйти" icon="arrow-back" onPress={() => router.back()} />
        </View>
      </View>
    );

  const progression = getProgression(state);
  const tutorial = tutorialProgress(state);
  const quests = questProgress(state);
  const nextQuest = quests.find((q) => !q.claimed && q.available);
  const journalDot =
    quests.some((q) => q.available && !q.claimed && q.progress >= q.target) ||
    goalProgress(state, serverNow).some((g) => !g.claimed && g.progress >= g.target);
  const ordersDot = ORDERS.some((o) =>
    Object.entries(o.requires).every(([id, n]) => state.inventory[id as CropId] >= n),
  );
  const stationReady = progression.stations.some((v) =>
    v.queue.some((j) => j.readyAt <= serverNow),
  );
  const goods = progression.goods ?? { egg: 0, milk: 0 };
  const storageCount =
    Object.values(state.inventory).reduce((a, b) => a + b, 0) + (v3 ? goods.egg + goods.milk : 0);
  const dailyAvailable = v3 && dailyStatus(state, serverNow).available;
  const current = state.plots.find((plot) => plot.id === selected);
  const decoration = progression.decorations.find((d) => d.id === selectedDecoration);
  const decorationInfo = DECORATIONS.find((d) => d.id === decoration?.decorationId);
  const placeCost =
    placement?.kind === 'decoration'
      ? DECORATIONS.find((d) => d.id === placement.decorationId)!.cost
      : placement?.kind === 'bed' || placement?.kind === 'tree'
        ? nextLandCost(state, placement.kind)
        : 0;
  const movingId = drag?.kind === 'plot' ? drag.id : null;
  const cellTaken =
    state.plots.some((v) => v.x === cell.x && v.y === cell.y && v.id !== movingId) ||
    progression.decorations.some(
      (d) => d.x === cell.x && d.y === cell.y && !(drag?.kind === 'decoration' && d.id === drag.id),
    );
  const validCell = isUnlockedCell(state, cell.x, cell.y) && !cellTaken;
  const narrow = width < 720;
  const ctx = current
    ? screenAtWorld(isoPoint(current.x, current.y), view, fit, width, height)
    : { x: width / 2, y: height / 2 };
  const panelTitle =
    panel === 'plot' || panel === 'seeds'
      ? current?.cropId
        ? cropFor(current.cropId).name
        : panel === 'seeds'
          ? 'Что посадим?'
          : `Грядка ${Number(selected) + 1}`
      : {
          shop: 'Магазин фермы',
          journal: 'История вашего сада',
          garden: 'Украшения',
          workshop: 'Мастерские',
          belongings: 'Ваши вещи',
          house: 'Дом Алекса',
          decoration: decorationInfo?.name ?? 'Украшение',
          remove: current?.kind === 'tree' ? 'Удалить яблоню?' : 'Удалить грядку?',
          removeCrop: 'Убрать посадку?',
          storage: 'Склад урожая',
          orders: v3 ? 'Заказы и доска' : 'Заказы фермы',
          coop: 'Курятник',
          barn: 'Коровник',
          land: 'Новая земля',
          place: '',
          help: 'Ваша маленькая ферма',
        }[panel || 'help'];
  const contextual =
    panel === 'plot' || panel === 'remove' || panel === 'removeCrop' || panel === 'decoration';
  const beginPlacement = (value: Placement) => {
    setPlacement(value);
    setTool('inspect');
    const start =
      value.kind === 'storedPlot' || value.kind === 'storedDecoration' || !current
        ? nextFreeCell(state, cell)
        : nextFreeCell(state, current);
    setCell(start);
    setPanel('place');
    focusCell(start.x, start.y, 2.4);
  };
  const confirmPlacement = () => {
    if (!placement || !validCell) return;
    const command: FarmCommand =
      placement.kind === 'decoration'
        ? { type: 'buyDecoration', decorationId: placement.decorationId, ...cell }
        : placement.kind === 'storedDecoration'
          ? { type: 'placeDecoration', instanceId: placement.instanceId, ...cell }
          : placement.kind === 'storedPlot'
            ? { type: 'placePlot', plotId: placement.plotId, ...cell }
            : placement.kind === 'tree'
              ? { type: 'buyTree', cropId: 'apple', ...cell }
              : { type: 'buyPlot', ...cell };
    if (!run(command)) return;
    addFx([
      {
        kind: 'puff',
        at: screenAtWorld(isoPoint(cell.x, cell.y), cam.camera.current, fit, width, height),
        size: 96 * fit * cam.camera.current.zoom,
      },
    ]);
    if (placement.kind === 'storedPlot' || placement.kind === 'storedDecoration') {
      setPanel(null);
      setPlacement(null);
      return;
    }
    // Building mode continues: the next free neighbour is ready for another purchase.
    setCell(
      nextFreeCell(
        {
          ...state,
          plots: [
            ...state.plots,
            {
              id: -1,
              x: cell.x,
              y: cell.y,
              kind: 'bed',
              cropId: null,
              plantedAt: null,
              harvests: 0,
            },
          ],
        },
        cell,
      ),
    );
  };
  const chooseSeed = (cropId: CropId) => {
    setSeed(cropId);
    setTool('plant');
    if (panel === 'seeds' && current && current.kind === 'bed' && current.cropId === null)
      plantPlot(current, cropId);
    setPanel(null);
  };
  const ghostKind =
    panel === 'place' && placement
      ? placement.kind === 'decoration'
        ? { art: placement.decorationId }
        : placement.kind === 'storedDecoration'
          ? {
              art: progression.decorations.find((d) => d.id === placement.instanceId)?.decorationId,
            }
          : placement.kind === 'tree' ||
              (placement.kind === 'storedPlot' &&
                progression.storedPlots.find((v) => v.id === placement.plotId)?.kind === 'tree')
            ? { tree: true }
            : { bed: true }
      : null;
  const dragged = drag?.kind === 'plot' ? state.plots.find((v) => v.id === drag.id) : undefined;
  const draggedDecoration =
    drag?.kind === 'decoration' ? progression.decorations.find((d) => d.id === drag.id) : undefined;
  const dragPhase = dragged ? cropPhase(dragged, serverNow) : 'empty';

  return (
    <View
      ref={fieldRef}
      collapsable={false}
      onLayout={measureField}
      style={s.screen}
      testID="pick-farm-screen"
    >
      <View
        style={{ flex: 1 }}
        {...responder.panHandlers}
        testID="pick-farm-world"
        accessibilityLabel="Поле фермы"
      >
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: 900,
            height: 600,
            left: (width - 900) / 2,
            top: (height - 600) / 2 + WORLD_OFFSET_Y,
            transform: [
              { translateX: cam.pan.x },
              { translateY: cam.pan.y },
              { scale: worldScale },
            ],
          }}
        >
          <GrassGround />
          <LandOverlay state={state} showSigns={v3} />
          <Landscape
            houseStyle={progression.houseStyle}
            grid={panel === 'place' || drag !== null}
          />
          <Scenery items={sceneryBack} visible={visible} />
          {v3 && (
            <Pens
              state={state}
              now={serverNow}
              badgeScale={badgeScale}
              moving={motion.active && !motion.reduced}
            />
          )}
          {progression.stations.map((station, i) => {
            const pt = isoPoint(STATION_CELLS[i]!.x, STATION_CELLS[i]!.y);
            const ready = station.queue.some((j) => j.readyAt <= serverNow);
            return (
              <View
                key={station.id}
                style={{ position: 'absolute', left: pt.x - 75, top: pt.y - 130 }}
              >
                <GardenArt id={station.id} size={150} />
                {ready && (
                  <View style={{ position: 'absolute', left: 75, top: -6 }}>
                    <Badge kind="ready" scale={badgeScale} bob={motion.active && !motion.reduced} />
                  </View>
                )}
              </View>
            );
          })}
          {progression.decorations
            .filter((d) => d.x !== null && d.y !== null)
            .map((d) => {
              const pt = isoPoint(d.x!, d.y!);
              if (!worldPointVisible(pt, view, fit, width, height)) return null;
              return (
                <View
                  key={`decor-${d.id}`}
                  testID={`pick-farm-decoration-${d.id}`}
                  style={{
                    position: 'absolute',
                    left: pt.x - 48,
                    top: pt.y - 76,
                    opacity: drag?.kind === 'decoration' && drag.id === d.id ? 0.28 : 1,
                  }}
                >
                  <GardenArt id={d.decorationId} size={96} />
                </View>
              );
            })}
          {plotsView.map((v) => (
            <PlotView
              key={v.id}
              {...v}
              selected={
                selected === v.id &&
                (panel === 'plot' ||
                  panel === 'seeds' ||
                  panel === 'remove' ||
                  panel === 'removeCrop')
              }
              lifted={movingId === v.id}
              reduced={motion.reduced}
              active={motion.active}
              badgeScale={badgeScale}
              waterOpacity={waterOpacity}
            />
          ))}
          <Scenery items={sceneryFront} visible={visible} />
          {(panel === 'place' || drag) && (
            <CellOutline
              x={isoPoint(cell.x, cell.y).x}
              y={isoPoint(cell.x, cell.y).y}
              color={validCell ? '#FFF9EA' : '#D0402E'}
            />
          )}
          {ghostKind && (
            <View
              pointerEvents="none"
              testID="pick-farm-ghost"
              style={{
                position: 'absolute',
                left: isoPoint(cell.x, cell.y).x - 48,
                top: isoPoint(cell.x, cell.y).y - ('art' in ghostKind ? 76 : 69),
                opacity: validCell ? 0.75 : 0.35,
              }}
            >
              {'art' in ghostKind && ghostKind.art ? (
                <GardenArt id={ghostKind.art} size={96} />
              ) : 'tree' in ghostKind ? (
                <View
                  style={{ position: 'absolute', left: TREE_IN_BOX.left, top: TREE_IN_BOX.top }}
                >
                  <CropArt cropId="apple" size={TREE_ART} phase="growing" />
                </View>
              ) : (
                <View style={{ width: 96, height: 96 }}>
                  <PlotGhost />
                </View>
              )}
            </View>
          )}
          {drag && (
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                opacity: validCell ? 0.95 : 0.55,
                transform: [{ translateX: dragPos.x }, { translateY: dragPos.y }, { scale: 1.08 }],
              }}
            >
              <View
                style={{
                  position: 'absolute',
                  left: -48,
                  top: drag.kind === 'decoration' ? -86 : -79,
                }}
              >
                {dragged ? (
                  dragged.kind === 'bed' ? (
                    <DraggedBed plot={dragged} now={serverNow} />
                  ) : (
                    <View
                      style={{ position: 'absolute', left: TREE_IN_BOX.left, top: TREE_IN_BOX.top }}
                    >
                      <CropArt
                        cropId="apple"
                        size={TREE_ART}
                        phase={dragPhase === 'empty' ? 'growing' : dragPhase}
                      />
                    </View>
                  )
                ) : draggedDecoration ? (
                  <GardenArt id={draggedDecoration.decorationId} size={96} />
                ) : null}
              </View>
            </Animated.View>
          )}
        </Animated.View>
      </View>
      <HoldRing at={holdAt} duration={HOLD_MS - 90} />
      <FxLayer items={fx} reduced={motion.reduced || !motion.active} onDone={removeFx} />

      <View style={[s.hud, { top, left }]}>
        <HudButton
          label="Выйти из фермы"
          icon="arrow-back"
          onPress={() => {
            if (tool !== 'inspect' || panel) {
              setPanel(null);
              setTool('inspect');
              showHint(null);
            } else router.back();
          }}
        />
        <Wallet
          coins={confirmed?.coins ?? state.coins}
          xp={confirmed?.xp ?? state.xp}
          saving={farm.pending > 0}
          reduced={motion.reduced}
          onCoinsLayout={onCoinsLayout}
          onLevelLayout={onLevelLayout}
          onLevelPress={() => setPanel('journal')}
        />
      </View>
      <View
        style={[s.hud, { top, right }]}
        onLayout={(e) => {
          rightHud.current = e.nativeEvent.layout.x;
        }}
      >
        {v3 && (
          <HudButton
            label="Подарок дня"
            icon="gift-outline"
            dot={dailyAvailable}
            testID="pick-farm-daily-button"
            onPress={() => setDaily(true)}
          />
        )}
        <HudButton
          label="Задания Алекса"
          icon="clipboard-outline"
          dot={journalDot}
          onPress={() => setPanel('journal')}
        />
        <HudButton
          label="Заказы фермы"
          icon="basket-outline"
          dot={ordersDot}
          onPress={() => setPanel('orders')}
        />
        <HudButton
          label="Склад урожая"
          icon="archive-outline"
          count={storageCount}
          onPress={() => setPanel('storage')}
          onLayout={onStorageLayout}
          testID="pick-farm-storage"
        />
        <HudButton
          label="Магазин"
          icon="storefront-outline"
          text={narrow ? undefined : 'Магазин'}
          dot={stationReady}
          testID="pick-farm-shop"
          onPress={() => setPanel('shop')}
        />
        <HudButton label="Как играть" icon="help-circle-outline" onPress={() => setPanel('help')} />
      </View>

      {!panel && !hint && tool === 'inspect' && nextQuest && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Задание: ${nextQuest.name}`}
          onPress={() => {
            if (!state.plots.length) setPanel('shop');
            else setPanel('journal');
          }}
          style={[
            s.pill,
            {
              position: 'absolute',
              top: top + 62,
              left,
              maxWidth: Math.min(300, width / 2.4),
              paddingVertical: 8,
            },
          ]}
        >
          <View style={[s.row, { gap: 8 }]}>
            <NativeImage
              source={require('../../../assets/profile/alex-avatar.png')}
              accessible={false}
              style={{ width: 30, height: 30, borderRadius: 10 }}
            />
            <View style={{ flex: 1 }}>
              <Text style={s.choiceName} numberOfLines={1}>
                {nextQuest.name} · {nextQuest.progress}/{nextQuest.target}
              </Text>
              <Text style={s.muted} numberOfLines={2}>
                {!state.plots.length
                  ? 'Алекс: начнём с первой грядки'
                  : nextQuest.progress >= nextQuest.target
                    ? 'Награда готова. Нажмите, чтобы забрать'
                    : !tutorial.complete && tutorial.plantings < 2
                      ? 'Первые две моркови вырастут за 45 секунд'
                      : chapterAdvice[nextQuest.id]}
              </Text>
            </View>
          </View>
        </Pressable>
      )}
      {tool === 'plant' && panel !== 'place' && (
        <View
          style={{ position: 'absolute', top: top + 60, right, alignItems: 'flex-end' }}
          testID="pick-farm-seed-mode"
        >
          <View
            style={[s.pill, s.row, { paddingVertical: 4, paddingLeft: 8, paddingRight: 4, gap: 8 }]}
          >
            <CropArt cropId={seed} size={34} />
            <View>
              <Text style={s.choiceName}>{cropFor(seed).name}</Text>
              <Text style={s.muted}>{cropFor(seed).seedCost} монет · касайтесь грядок</Text>
            </View>
            <HudButton
              label="Другие семена"
              icon="swap-horizontal"
              onPress={() => setPanel('seeds')}
            />
            <HudButton
              label="Закончить посадку"
              icon="close"
              onPress={() => {
                setTool('inspect');
                showHint(null);
              }}
            />
          </View>
        </View>
      )}
      {hint && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: top + (tool === 'plant' ? 124 : 60),
            alignSelf: 'center',
            maxWidth: Math.min(420, width - left - right),
          }}
          accessibilityLiveRegion="polite"
        >
          <View style={[s.pill, { paddingVertical: 10 }]}>
            <Text style={[s.text, { textAlign: 'center' }]}>{hint}</Text>
          </View>
        </View>
      )}
      {panel === 'place' && placement && (
        <View style={{ position: 'absolute', top: top + 60, right }} testID="pick-farm-panel-place">
          <View style={[s.pill, s.row, { paddingHorizontal: 4, gap: 6 }]}>
            <HudButton
              label="Отменить размещение"
              icon="close"
              onPress={() => {
                setPanel(null);
                setPlacement(null);
              }}
            />
            <Button
              primary
              label={placeCost ? `Разместить - ${placeCost} монет` : 'Разместить бесплатно'}
              disabled={!validCell || state.coins < placeCost}
              onPress={confirmPlacement}
            />
          </View>
          <Text
            style={[
              s.muted,
              {
                textAlign: 'right',
                marginTop: 6,
                color: '#FFFFFF',
                textShadowColor: '#000000AA',
                textShadowRadius: 3,
              },
            ]}
          >
            Коснитесь клетки или ведите пальцем
          </Text>
        </View>
      )}
      {panel === 'seeds' && (
        <View
          testID="pick-farm-panel-seeds"
          style={[s.panel, { bottom, left, right, padding: 10, paddingTop: 8 }]}
        >
          <SeedBar
            state={state}
            plotId={selected}
            current={tool === 'plant' ? seed : null}
            chooseSeed={chooseSeed}
            close={() => setPanel(null)}
            openPlot={() => setPanel('plot')}
          />
        </View>
      )}
      {panel && panel !== 'place' && panel !== 'seeds' && (
        <View
          style={[
            s.panel,
            {
              bottom,
              left,
              right: right + (width > 700 ? 68 : 0),
              maxHeight: height - top - 64,
              ...(panel === 'shop' && width > 700 ? { left: Math.max(left, width - 740) } : {}),
              ...(panel === 'coop' || panel === 'barn' || panel === 'land'
                ? { top: top + 60, left: undefined, right, width: sideWidth, maxHeight: undefined }
                : {}),
              ...(contextual
                ? {
                    bottom: undefined,
                    top: Math.max(top + 60, Math.min(ctx.y - 60, height - bottom - 280)),
                    left: Math.max(
                      left,
                      Math.min(ctx.x + 40, width - right - Math.min(340, width - left - right)),
                    ),
                    right: undefined,
                    width: Math.min(340, width - left - right),
                  }
                : {}),
            },
          ]}
          testID={`pick-farm-panel-${panel}`}
        >
          <View style={s.panelHeader}>
            <Text style={[s.panelTitle, { flex: 1 }]}>{panelTitle}</Text>
            <HudButton label="Закрыть панель" icon="close" onPress={() => setPanel(null)} />
          </View>
          <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 3 }}>
            {panel === 'coop' || panel === 'barn' ? (
              <PenPanel pen={panel} state={state} now={serverNow} act={panelAct} />
            ) : panel === 'land' ? (
              <LandPanel state={state} act={panelAct} />
            ) : (['journal', 'garden', 'workshop', 'belongings', 'house'] as string[]).includes(
                panel,
              ) ? (
              <GardenPanels
                panel={panel as GardenPanel}
                state={state}
                now={serverNow}
                busy={false}
                act={(command) => panelAct(command)}
                place={beginPlacement}
                v3={v3}
              />
            ) : (
              <FarmPanel
                panel={panel as BasicPanel}
                state={state}
                now={serverNow}
                plotId={selected}
                decorationId={selectedDecoration}
                watering={watering}
                sound={sound}
                v3={v3}
                destination={destination}
                act={panelAct}
                setPanel={(next) => {
                  setPanel(next);
                  if (next === 'coop' || next === 'barn') focusPoint(penCenter(next), 2.2);
                  if (next === 'land') {
                    const b = landBounds(state);
                    focusPoint(isoPoint(b.maxX, b.maxY), 1);
                  }
                }}
                choosePlacement={(kind) => beginPlacement({ kind })}
                chooseSeed={chooseSeed}
                setSound={setSound}
                setDestination={setDestination}
                zoomIn={() =>
                  zoomAt(
                    {
                      x: fieldFrame.current.x + width / 2,
                      y: fieldFrame.current.y + height / 2 + WORLD_OFFSET_Y,
                    },
                    1.6,
                  )
                }
                overview={() =>
                  cam.animateTo(frameWorldRect(PROPERTY_RECT, fit, width, height, 1, MIN_ZOOM))
                }
                selectPlot={(id) => {
                  setSelected(id);
                  setPanel('plot');
                }}
              />
            )}
          </ScrollView>
        </View>
      )}
      {farm.error && (
        <View style={[s.error, { left, right, top: top + 58 }]} accessibilityLiveRegion="polite">
          <Text style={s.errorText}>{farm.error}</Text>
          <Button label="Обновить" icon="refresh" onPress={farm.retry} />
        </View>
      )}
      {levelUp && (
        <LevelUp info={levelUp} reduced={motion.reduced} onClose={() => setLevelUp(null)} />
      )}
      {daily && !levelUp && v3 && (
        <DailyCard
          state={state}
          now={serverNow}
          reduced={motion.reduced}
          onClose={() => setDaily(false)}
          onClaim={() => {
            if (run({ type: 'claimDaily' })) {
              play('coin');
              setDaily(false);
            }
          }}
        />
      )}
    </View>
  );
}

/** Empty soil preview for a new bed. */
function PlotGhost() {
  return (
    <GroundCrop cropId={null} stage="empty" size={96} motion={{ reduced: true, active: false }} />
  );
}
function DraggedBed({ plot, now }: { plot: Plot; now: number }) {
  const phase = cropPhase(plot, now);
  return (
    <GroundCrop
      selected
      cropId={plot.cropId}
      stage={cropStage(plot.cropId, phase, growthProgress(plot, now), plot.kind)}
      watered={isWatered(plot) && phase === 'growing'}
      size={96}
      motion={{ reduced: true, active: false }}
    />
  );
}
