import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  PanResponder,
  Image as NativeImage,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CROPS,
  ORDERS,
  cropEconomics,
  cropTiming,
  DECORATIONS,
  getProgression,
  questProgress,
  tutorialProgress,
  nextLandCost,
  isPlantingCell,
  cropPhase,
  canRecoverFarm,
  levelForXp,
  type CropId,
  type FarmCommand,
} from '@pickchick/farm-game';
import { GardenArt } from './GardenArt';
import {
  GardenPanels,
  chapterAdvice,
  type GardenPanel,
  type GardenPlacement,
} from './GardenPanels';
import { Icon, type IconName } from '../../components/UI';
import { useFarm } from './useFarm';
import { useFarmSound } from './useFarmSound';
import { CropArt, Landscape, CellOutline, isoPoint, cellAtPoint } from './visuals';
import { farmPalette as p, farmStyles as s } from './styles';
import { GroundCrop } from './PlantingVisual';
import {
  clampCamera,
  fitFarm,
  worldAtPagePoint,
  cameraAroundPoint,
  worldPointVisible,
} from './geometry';
import { plotAtPoint } from './hit-zones';
import { CropMotion, HarvestFeedback, useFarmMotion, type FarmFeedback } from './motion';

type Panel =
  | GardenPanel
  | 'decoration'
  | 'plot'
  | 'shop'
  | 'storage'
  | 'orders'
  | 'place'
  | 'help'
  | 'remove'
  | 'seeds'
  | 'removeCrop'
  | null;
const cropFor = (id: CropId) => CROPS.find((c) => c.id === id)!;
function duration(seconds: number) {
  const n = Math.max(0, Math.ceil(seconds));
  return n >= 3600
    ? `${Math.floor(n / 3600)} ч${n % 3600 ? ` ${Math.ceil((n % 3600) / 60)} мин` : ''}`
    : n >= 60
      ? `${Math.ceil(n / 60)} мин`
      : `${n} с`;
}
function Button({
  label,
  icon,
  onPress,
  disabled = false,
  primary = false,
  testID,
  active = false,
}: {
  label: string;
  icon?: IconName;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  testID?: string;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary && s.primary,
        active && s.activeTool,
        disabled && s.disabled,
        pressed && s.pressed,
      ]}
    >
      {icon && <Icon name={icon} size={20} color={primary ? '#FFFFFF' : p.ink} />}
      <Text style={[s.buttonText, primary && s.primaryText]}>{label}</Text>
    </Pressable>
  );
}
function IconButton({ label, icon, onPress }: { label: string; icon: IconName; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.button, { paddingHorizontal: 0, width: 48 }, pressed && s.pressed]}
    >
      <Icon name={icon} size={24} color={p.ink} />
    </Pressable>
  );
}

function HarvestMode({
  destination,
  onChange,
}: {
  destination: 'sell' | 'storage';
  onChange(value: 'sell' | 'storage'): void;
}) {
  return (
    <View style={s.harvestMode} accessibilityLabel="Куда отправить урожай">
      {(
        [
          { id: 'sell', label: 'Собрать и продать', icon: 'cash-outline' },
          { id: 'storage', label: 'На склад для заказов', icon: 'archive-outline' },
        ] as const
      ).map((option) => (
        <Pressable
          key={option.id}
          testID={`pick-farm-destination-${option.id}`}
          accessibilityRole="button"
          accessibilityLabel={option.label}
          accessibilityState={{ selected: destination === option.id }}
          onPress={() => onChange(option.id)}
          style={({ pressed }) => [
            s.harvestOption,
            destination === option.id && s.harvestSelected,
            pressed && s.pressed,
          ]}
        >
          <Icon name={option.icon} size={18} color={destination === option.id ? p.paper : p.ink} />
          <Text style={[s.harvestLabel, destination === option.id && { color: p.paper }]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
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
  const { state, serverNow, loading, busy, error, retry, send, harvest, receipt, customerId } =
    useFarm();
  const [panel, setPanel] = useState<Panel>(null);
  const [tool, setTool] = useState<'inspect' | 'plant'>('inspect');
  const [harvestDestination, setHarvestDestination] = useState<'sell' | 'storage'>('sell');
  const [seed, setSeed] = useState<CropId>('carrot');
  const [hint, setHint] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [gardenPlacement, setGardenPlacement] = useState<GardenPlacement | null>(null);
  const [selectedDecoration, setSelectedDecoration] = useState<number | null>(null);
  const [placement, setPlacement] = useState<'bed' | 'tree' | 'move'>('bed');
  const [cell, setCell] = useState({ x: 32, y: 30 });
  const motion = useFarmMotion();
  const [sound, setSound] = useState(false);
  useFarmSound(receipt?.id, sound, motion.active);
  const [feedback, setFeedback] = useState<FarmFeedback | null>(null);
  useEffect(() => {
    if (receipt) setFeedback(receipt);
  }, [receipt]);
  const pendingHarvests = useRef(new Set<number>());
  const clearFeedback = useCallback(() => setFeedback(null), []);
  const camera = useRef({ x: 0, y: 0, zoom: 1 });
  const [cameraView, setCameraView] = useState(camera.current);
  const gestureStart = useRef({ x: 0, y: 0, zoom: 1, distance: 0, moved: false, multi: false });
  const pan = useRef(new Animated.ValueXY()).current;
  const zoom = useRef(new Animated.Value(1)).current;
  const fit = fitFarm(width - inset.left - inset.right, height - inset.top - inset.bottom);
  const updateCamera = useCallback(
    (x: number, y: number, scale: number) => {
      const next = clampCamera(
        x,
        y,
        scale,
        fit,
        width - inset.left - inset.right,
        height - inset.top - inset.bottom,
      );
      camera.current = next;
      setCameraView(next);
      pan.setValue({ x: next.x, y: next.y });
      zoom.setValue(next.zoom);
    },
    [pan, zoom, fit, width, height, inset.left, inset.right, inset.top, inset.bottom],
  );
  useEffect(() => {
    updateCamera(0, 0, camera.current.zoom);
  }, [updateCamera]);
  useEffect(() => {
    if (!customerId) return;
    let active = true;
    const key = `pickchick.farm.camera.v1.${customerId}`;
    void AsyncStorage.getItem(key)
      .then((raw) => {
        if (!active || !raw) return;
        try {
          const v = JSON.parse(raw);
          if ([v.x, v.y, v.zoom].every(Number.isFinite)) updateCamera(v.x, v.y, v.zoom);
        } catch {
          /* Ignore invalid view preferences, never the farm save. */
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      void AsyncStorage.setItem(key, JSON.stringify(camera.current)).catch(() => undefined);
    };
  }, [customerId, updateCamera]);
  const focusCell = useCallback(
    (x: number, y: number) => {
      const point = isoPoint(x, y);
      const scale = Math.min(8, Math.max(4, 0.8 / fit));
      updateCamera(-(point.x - 450) * fit * scale, -(point.y - 300) * fit * scale - 36, scale);
    },
    [fit, updateCamera],
  );
  const beginGardenPlacement = (value: GardenPlacement) => {
    setGardenPlacement(value);
    setPlacement('bed');
    setTool('inspect');
    setPanel('place');
    focusCell(cell.x, cell.y);
  };
  const distance = (e: GestureResponderEvent) => {
    const [a, b] = e.nativeEvent.touches;
    return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
  };
  const act = useCallback(
    (command: FarmCommand) => {
      if (command.type === 'harvest') {
        if (pendingHarvests.current.has(command.plotId)) return;
        pendingHarvests.current.add(command.plotId);
      }
      void (command.type === 'harvest' ? harvest(command) : send(command))
        .then((saved) => {
          if (saved === true) setHint(null);
        })
        .catch(() => undefined)
        .finally(() => {
          if (command.type === 'harvest') pendingHarvests.current.delete(command.plotId);
        });
    },
    [send, harvest],
  );
  const worldAt = useCallback(
    (event: GestureResponderEvent) =>
      worldAtPagePoint(
        { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
        fieldFrame.current,
        camera.current,
        fit,
      ),
    [fit],
  );
  const pointAt = useCallback(
    (event: GestureResponderEvent) => {
      const point = worldAt(event);
      return cellAtPoint(point.x, point.y);
    },
    [worldAt],
  );
  const selectAt = useCallback(
    (event: GestureResponderEvent) => {
      if (panel && panel !== 'place' && panel !== 'plot') return;
      const ground = pointAt(event);
      const decoration = state
        ? getProgression(state).decorations.find((d) => d.x === ground.x && d.y === ground.y)
        : undefined;
      if (decoration && panel !== 'place') {
        setSelectedDecoration(decoration.id);
        setSelected(null);
        setPanel('decoration');
        return;
      }
      if (panel !== 'place' && ground.x < 16 && ground.y < 16) {
        setPanel('house');
        return;
      }
      // Placement always targets the ground diamond, never a neighbouring plant's foliage.
      const plot =
        panel === 'place'
          ? undefined
          : (plotAtPoint(state?.plots ?? [], worldAt(event), serverNow) ??
            state?.plots.find((item) => item.x === ground.x && item.y === ground.y));
      const { x, y } = plot ?? ground;
      if (!isPlantingCell(x, y) && !plot) {
        if (panel === 'place') setCell({ x, y });
        setHint('Грядки можно размещать только внутри границы участка.');
        return;
      }
      if (busy && !(plot && cropPhase(plot, serverNow) === 'ready')) return;
      setCell({ x, y });
      if (panel === 'place') return;
      if (plot) {
        setSelected(plot.id);
        if (tool === 'plant' && plot.kind === 'bed' && !plot.cropId) {
          if ((state?.coins ?? 0) < cropFor(seed).seedCost) {
            setHint('Не хватает монет на семена.');
            return;
          }
          act({ type: 'plant', plotId: plot.id, cropId: seed });
          return;
        }
        if (cropPhase(plot, serverNow) === 'ready') {
          setPanel(null);
          act({ type: 'harvest', plotId: plot.id, destination: harvestDestination });
          return;
        }
        setPanel('plot');
      } else {
        setPanel(null);
        setSelected(null);
        setHint(null);
      }
    },
    [pointAt, worldAt, panel, busy, state, tool, seed, serverNow, act, harvestDestination],
  );
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragPlot = useRef<number | null>(null);
  const dragDecoration = useRef<number | null>(null);
  const sweepStart = useRef<number | null>(null);
  const swept = useRef(new Set<number>());
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragTarget = useCallback(
    (event: GestureResponderEvent) => {
      const point = worldAt(event);
      return cellAtPoint(point.x + dragOffset.current.x, point.y + dragOffset.current.y);
    },
    [worldAt],
  );
  const cancelHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }, []);
  useEffect(() => () => cancelHold(), [cancelHold]);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (e, g) =>
          e.nativeEvent.touches.length > 1 || Math.abs(g.dx) + Math.abs(g.dy) > 7,
        onPanResponderGrant: (e) => {
          cancelHold();
          dragPlot.current = null;
          dragDecoration.current = null;
          const target = pointAt(e);
          const pointer = worldAt(e);
          const plot =
            plotAtPoint(state?.plots ?? [], pointer, serverNow) ??
            state?.plots.find((p) => p.x === target.x && p.y === target.y);
          sweepStart.current = plot && cropPhase(plot, serverNow) === 'ready' ? plot.id : null;
          swept.current.clear();
          const decoration = state
            ? getProgression(state).decorations.find((d) => d.x === target.x && d.y === target.y)
            : undefined;
          if (
            (!panel || panel === 'decoration') &&
            !busy &&
            decoration &&
            e.nativeEvent.touches.length === 1
          ) {
            holdTimer.current = setTimeout(() => {
              setPanel(null);
              dragDecoration.current = decoration.id;
              setSelectedDecoration(decoration.id);
              setSelected(null);
              const center = isoPoint(decoration.x!, decoration.y!);
              dragOffset.current = { x: center.x - pointer.x, y: center.y - pointer.y };
              setCell({ x: decoration.x!, y: decoration.y! });
              setHint(null);
            }, 420);
          }
          if ((!panel || panel === 'plot') && !busy && plot && e.nativeEvent.touches.length === 1) {
            holdTimer.current = setTimeout(() => {
              setPanel(null);
              dragPlot.current = plot.id;
              const center = isoPoint(plot.x, plot.y);
              dragOffset.current = { x: center.x - pointer.x, y: center.y - pointer.y };
              setSelected(plot.id);
              setCell({ x: plot.x, y: plot.y });
              setPlacement('move');
              setHint(null);
            }, 420);
          }
          gestureStart.current = {
            ...camera.current,
            distance: distance(e),
            moved: false,
            multi: e.nativeEvent.touches.length > 1,
          };
        },
        onPanResponderMove: (e, g) => {
          const start = gestureStart.current;
          if (Math.abs(g.dx) + Math.abs(g.dy) > 7) {
            start.moved = true;
            cancelHold();
          }
          if (
            (dragPlot.current !== null || dragDecoration.current !== null) &&
            e.nativeEvent.touches.length === 1
          ) {
            setCell(dragTarget(e));
            return;
          }
          if (e.nativeEvent.touches.length > 1) {
            start.multi = true;
            sweepStart.current = null;
            cancelHold();
            dragPlot.current = null;
            dragDecoration.current = null;
          }
          if (!start.multi && start.moved && sweepStart.current !== null) {
            const pointer = worldAt(e);
            const next = plotAtPoint(state?.plots ?? [], pointer, serverNow);
            for (const id of [sweepStart.current, next?.id]) {
              if (id === undefined || swept.current.has(id)) continue;
              const plot = state?.plots.find((p) => p.id === id);
              if (plot && cropPhase(plot, serverNow) === 'ready') {
                swept.current.add(id);
                act({ type: 'harvest', plotId: id, destination: harvestDestination });
              }
            }
            return;
          }
          const d = distance(e);
          if (d > 0) {
            if (start.distance === 0) {
              start.distance = d;
              start.zoom = camera.current.zoom;
            }
            const [a, b] = e.nativeEvent.touches;
            if (a && b) {
              const pivot = {
                x: (a.pageX + b.pageX) / 2 - fieldFrame.current.x - width / 2,
                y: (a.pageY + b.pageY) / 2 - fieldFrame.current.y - height / 2 - 48,
              };
              const next = cameraAroundPoint(
                camera.current,
                pivot,
                (start.zoom * d) / start.distance,
              );
              updateCamera(next.x, next.y, next.zoom);
            }
          } else if (start.moved && !start.multi)
            updateCamera(start.x + g.dx, start.y + g.dy, camera.current.zoom);
        },
        onPanResponderRelease: (e) => {
          cancelHold();
          if (dragDecoration.current !== null) {
            const instanceId = dragDecoration.current;
            dragDecoration.current = null;
            if (!gestureStart.current.moved) {
              setPanel('decoration');
              return;
            }
            const target = dragTarget(e);
            const taken =
              state?.plots.some((p) => p.x === target.x && p.y === target.y) ||
              (state &&
                getProgression(state).decorations.some(
                  (d) => d.id !== instanceId && d.x === target.x && d.y === target.y,
                ));
            if (isPlantingCell(target.x, target.y) && !taken)
              act({ type: 'moveDecoration', instanceId, ...target });
            else setHint('Нужна свободная клетка внутри участка.');
            return;
          }
          if (dragPlot.current !== null) {
            const plotId = dragPlot.current;
            dragPlot.current = null;
            setPlacement('bed');
            if (!gestureStart.current.moved) {
              setPanel('plot');
              return;
            }
            const target = dragTarget(e);
            const occupied = state?.plots.some(
              (plot) => plot.id !== plotId && plot.x === target.x && plot.y === target.y,
            );
            const decorOccupied =
              state &&
              getProgression(state).decorations.some((d) => d.x === target.x && d.y === target.y);
            if (isPlantingCell(target.x, target.y) && !occupied && !decorOccupied)
              act({ type: 'movePlot', plotId, ...target });
            else setHint('Перенос отменён: нужна свободная клетка внутри участка.');
            return;
          }
          if (!gestureStart.current.moved && !gestureStart.current.multi) selectAt(e);
        },
        onPanResponderTerminate: () => {
          cancelHold();
          dragPlot.current = null;
          dragDecoration.current = null;
          setHint(null);
        },
      }),
    [
      updateCamera,
      selectAt,
      pointAt,
      worldAt,
      dragTarget,
      serverNow,
      state,
      busy,
      panel,
      cancelHold,
      width,
      height,
      harvestDestination,
      act,
    ],
  );
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (panel || tool !== 'inspect') {
        setPanel(null);
        setTool('inspect');
        setHint(null);
        return true;
      }
      return false;
    });
    return () => back.remove();
  }, [panel, tool]);
  const top = Math.max(10, inset.top);
  const bottom = Math.max(10, inset.bottom);
  const left = Math.max(14, inset.left);
  const right = Math.max(14, inset.right);
  const current = state?.plots.find((plot) => plot.id === selected);
  const crop = current?.cropId ? cropFor(current.cropId) : null;
  const remaining =
    current && crop && current.plantedAt !== null
      ? Math.max(0, (current.plantedAt + cropTiming(current).growSeconds * 1000 - serverNow) / 1000)
      : 0;
  if (!state)
    return (
      <View ref={fieldRef} collapsable={false} onLayout={measureField} style={s.screen}>
        <View style={s.center}>
          <CropArt cropId="apple" size={84} />
          <Text style={s.title}>PICK FARM</Text>
          {loading ? (
            <>
              <ActivityIndicator color={p.blue} />
              <Text style={s.text}>Открываем вашу ферму...</Text>
            </>
          ) : (
            <>
              <Text style={[s.text, { textAlign: 'center', maxWidth: 420 }]}>
                {error || 'Не удалось открыть ферму.'}
              </Text>
              <Button label="Попробовать снова" icon="refresh" primary onPress={retry} />
            </>
          )}
          <Button label="Выйти" icon="arrow-back" onPress={() => router.back()} />
        </View>
      </View>
    );
  const progression = getProgression(state);
  const tutorial = tutorialProgress(state);
  const nextQuest = questProgress(state).find((q) => !q.claimed && q.available);
  const decoration = progression.decorations.find((d) => d.id === selectedDecoration);
  const decorationInfo = DECORATIONS.find((d) => d.id === decoration?.decorationId);
  const placeCost =
    gardenPlacement?.kind === 'decoration'
      ? DECORATIONS.find((d) => d.id === gardenPlacement.decorationId)!.cost
      : gardenPlacement
        ? 0
        : nextLandCost(state, placement === 'tree' ? 'tree' : 'bed');
  const bedCost = nextLandCost(state, 'bed');
  const treeCost = nextLandCost(state, 'tree');
  const phase = current ? cropPhase(current, serverNow) : 'empty';
  const occupied = state.plots.some(
    (plot) =>
      plot.x === cell.x && plot.y === cell.y && !(placement === 'move' && plot.id === selected),
  );
  const validCell =
    isPlantingCell(cell.x, cell.y) &&
    !occupied &&
    !progression.decorations.some(
      (d) => d.x === cell.x && d.y === cell.y && d.id !== dragDecoration.current,
    );
  const storageCount = Object.values(state.inventory).reduce((a, b) => a + b, 0);
  const contextPoint = current ? isoPoint(current.x, current.y) : { x: 450, y: 300 };
  const contextX =
    width / 2 + camera.current.x + (contextPoint.x - 450) * camera.current.zoom * fit;
  const contextY =
    height / 2 + 48 + camera.current.y + (contextPoint.y - 300) * camera.current.zoom * fit;
  const panelTitle =
    panel === 'plot'
      ? crop?.name || `Грядка ${Number(selected) + 1}`
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
          seeds: 'Выберите семена',
          storage: 'Склад урожая',
          orders: 'Заказы фермы',
          place:
            placement === 'move'
              ? 'Переместить'
              : placement === 'tree'
                ? 'Посадить яблоню'
                : 'Новая грядка',
          help: 'Ваша маленькая ферма',
        }[panel || 'help'];
  return (
    <View
      ref={fieldRef}
      collapsable={false}
      onLayout={measureField}
      style={s.screen}
      testID="pick-farm-screen"
    >
      {feedback && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', zIndex: 20, left: (width - 200) / 2, top: top + 60 }}
        >
          <HarvestFeedback
            key={feedback.id}
            feedback={feedback}
            reduced={motion.reduced}
            active={motion.active}
            onDone={clearFeedback}
          />
        </View>
      )}
      <View
        style={{ flex: 1 }}
        {...responder.panHandlers}
        testID="pick-farm-world"
        accessibilityLabel="Поле фермы. Выберите место для грядки"
      >
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: 900,
            height: 600,
            left: (width - 900) / 2,
            top: (height - 600) / 2 + 48,
            transform: [
              { translateX: pan.x },
              { translateY: pan.y },
              { scale: Animated.multiply(zoom, fit) },
            ],
          }}
        >
          <NativeImage
            source={require('../../../assets/games/pick-farm/meadow-painted-v2.png')}
            resizeMode="stretch"
            accessible={false}
            style={{ position: 'absolute', left: -1750, top: -1100, width: 4400, height: 2800 }}
          />
          <Landscape
            houseStyle={progression.houseStyle}
            grid={panel === 'place' || dragPlot.current !== null || dragDecoration.current !== null}
          />
          {progression.decorations
            .filter((d) => d.x !== null && d.y !== null)
            .map((d) => {
              const pt = isoPoint(d.x!, d.y!);
              if (!worldPointVisible(pt, cameraView, fit, width, height)) return null;
              return (
                <View
                  key={`decor-${d.id}`}
                  style={{
                    position: 'absolute',
                    left: pt.x - 48,
                    top: pt.y - 76,
                    opacity: dragDecoration.current === d.id ? 0.3 : 1,
                  }}
                >
                  <GardenArt id={d.decorationId} size={96} />
                </View>
              );
            })}
          {progression.stations.map((station, i) => {
            const pt = isoPoint(13, 18 + i * 3);
            return (
              <View
                key={station.id}
                style={{ position: 'absolute', left: pt.x - 75, top: pt.y - 130 }}
              >
                <GardenArt id={station.id} size={150} />
              </View>
            );
          })}
          {state.plots
            .slice()
            .filter((plot) =>
              worldPointVisible(isoPoint(plot.x, plot.y), cameraView, fit, width, height),
            )
            .sort((a, b) => a.x + a.y - b.x - b.y)
            .map((plot) => {
              const point = isoPoint(plot.x, plot.y),
                planted = plot.cropId ? cropFor(plot.cropId) : null,
                plotPhase = cropPhase(plot, serverNow);
              return (
                <View
                  key={plot.id}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: point.x,
                    top: point.y,
                    opacity: dragPlot.current === plot.id ? 0.25 : 1,
                  }}
                >
                  {plot.kind === 'tree' && selected === plot.id && <CellOutline x={0} y={0} />}
                  <View
                    testID={`pick-farm-plot-${plot.id}`}
                    style={[s.plot, { left: -48, top: -69, width: 96, height: 96 }]}
                  >
                    {plot.kind === 'bed' ? (
                      <GroundCrop
                        selected={selected === plot.id}
                        cropId={plot.cropId}
                        plantedAt={plot.plantedAt}
                        growSeconds={cropTiming(plot).growSeconds}
                        phase={plotPhase}
                        now={serverNow}
                        size={96}
                        motion={motion}
                        testID={`pick-farm-growth-${plot.id}`}
                      />
                    ) : (
                      planted && (
                        <CropMotion cropId={plot.cropId} ready={plotPhase === 'ready'} {...motion}>
                          <CropArt
                            cropId={planted.id}
                            size={plot.kind === 'tree' ? 112 : plotPhase === 'growing' ? 58 : 76}
                            phase={plotPhase === 'empty' ? undefined : plotPhase}
                          />
                        </CropMotion>
                      )
                    )}
                    {plotPhase === 'ready' && (
                      <View style={s.ready}>
                        <Icon name="checkmark" color="#FFFFFF" size={17} />
                      </View>
                    )}
                    {plotPhase === 'withered' && <Text style={s.time}>Увяло</Text>}
                  </View>
                </View>
              );
            })}
          {dragPlot.current !== null && current && (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: isoPoint(cell.x, cell.y).x - 48,
                top: isoPoint(cell.x, cell.y).y - 69,
                opacity: validCell ? 0.85 : 0.4,
              }}
            >
              {current.kind === 'bed' ? (
                <GroundCrop
                  selected
                  cropId={current.cropId}
                  plantedAt={current.plantedAt}
                  growSeconds={cropTiming(current).growSeconds}
                  phase={phase}
                  now={serverNow}
                  size={96}
                  motion={{ reduced: true, active: false }}
                />
              ) : (
                <CropArt cropId="apple" size={112} phase={phase === 'empty' ? undefined : phase} />
              )}
            </View>
          )}
          {panel === 'place' && gardenPlacement?.kind === 'decoration' && (
            <View
              style={{
                position: 'absolute',
                left: isoPoint(cell.x, cell.y).x - 48,
                top: isoPoint(cell.x, cell.y).y - 76,
                opacity: 0.6,
              }}
            >
              <GardenArt id={gardenPlacement.decorationId} size={96} />
            </View>
          )}
          {dragDecoration.current !== null && decoration && (
            <View
              style={{
                position: 'absolute',
                left: isoPoint(cell.x, cell.y).x - 48,
                top: isoPoint(cell.x, cell.y).y - 76,
                opacity: validCell ? 0.85 : 0.4,
              }}
            >
              <GardenArt id={decoration.decorationId} size={96} />
            </View>
          )}
          {(panel === 'place' || dragPlot.current !== null || dragDecoration.current !== null) && (
            <CellOutline
              x={isoPoint(cell.x, cell.y).x}
              y={isoPoint(cell.x, cell.y).y}
              color={validCell ? '#FFF9EA' : '#AA372A'}
            />
          )}
        </Animated.View>
      </View>
      <View style={[s.hud, { top, left }]}>
        <IconButton
          label="Выйти из фермы"
          icon="arrow-back"
          onPress={() => {
            if (tool !== 'inspect' || panel) {
              setPanel(null);
              setTool('inspect');
              setHint(null);
            } else router.back();
          }}
        />
        <View style={[s.pill, s.metricPill]}>
          <Text style={s.metric}>{state.coins} монет</Text>
        </View>
        <View style={[s.pill, s.metricPill]}>
          <Text style={s.metric}>Ур. {levelForXp(state.xp)}</Text>
          <Text style={s.metricCaption}>{state.xp} XP</Text>
        </View>
      </View>
      <View style={[s.hud, { top, right }]}>
        <IconButton
          label="Задания Алекса"
          icon="clipboard-outline"
          onPress={() => setPanel('journal')}
        />
        <IconButton label="Заказы фермы" icon="basket-outline" onPress={() => setPanel('orders')} />

        <Button
          label="Магазин"
          icon="storefront-outline"
          testID="pick-farm-shop"
          onPress={() => setPanel('shop')}
        />
        <IconButton
          label="Как играть"
          icon="help-circle-outline"
          onPress={() => setPanel('help')}
        />
      </View>
      {!panel && !hint && tool === 'inspect' && nextQuest && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Задание: ${nextQuest.name}`}
          onPress={() => {
            if (!state.plots.length) {
              focusCell(32, 30);
              setPanel('shop');
            } else setPanel('journal');
          }}
          style={[
            s.pill,
            {
              position: 'absolute',
              top: top + 62,
              left,
              maxWidth: Math.min(280, width / 2),
              paddingVertical: 10,
            },
          ]}
        >
          <View style={[s.row, { gap: 8 }]}>
            <NativeImage
              source={require('../../../assets/profile/alex-avatar.png')}
              accessible={false}
              style={{ width: 32, height: 32, borderRadius: 10 }}
            />
            <Text style={[s.choiceName, { flex: 1 }]}>
              {nextQuest.name} · {nextQuest.progress}/{nextQuest.target}
            </Text>
          </View>
          <Text style={s.muted}>
            {!state.plots.length
              ? 'Алекс: начнём с первой грядки'
              : nextQuest.progress >= nextQuest.target
                ? 'Награда готова. Нажмите, чтобы забрать'
                : !tutorial.complete && tutorial.plantings < 2
                  ? 'Первые две моркови вырастут за 45 секунд'
                  : chapterAdvice[nextQuest.id]}
          </Text>
        </Pressable>
      )}
      {!panel && (hint || tool === 'plant') && (
        <View
          style={{
            position: 'absolute',
            top: top + 60,
            right,
            maxWidth: Math.min(360, width - left - right),
          }}
        >
          <View style={[s.pill, s.row, { paddingVertical: 4 }]}>
            <Text style={[s.muted, { flexShrink: 1 }]}>{hint || cropFor(seed).name}</Text>
            <IconButton
              label="Закончить посадку"
              icon="close"
              onPress={() => {
                setTool('inspect');
                setHint(null);
              }}
            />
          </View>
        </View>
      )}
      {panel === 'place' && (
        <View style={{ position: 'absolute', top: top + 60, right }} testID="pick-farm-panel-place">
          <View style={[s.pill, s.row, { paddingHorizontal: 4 }]}>
            <IconButton label="Отменить размещение" icon="close" onPress={() => setPanel(null)} />
            <Button
              primary
              label={placeCost ? `Разместить - ${placeCost} монет` : 'Разместить бесплатно'}
              disabled={busy || !validCell || state.coins < placeCost}
              onPress={() => {
                const command: FarmCommand =
                  gardenPlacement?.kind === 'decoration'
                    ? { type: 'buyDecoration', decorationId: gardenPlacement.decorationId, ...cell }
                    : gardenPlacement?.kind === 'storedDecoration'
                      ? { type: 'placeDecoration', instanceId: gardenPlacement.instanceId, ...cell }
                      : gardenPlacement?.kind === 'storedPlot'
                        ? { type: 'placePlot', plotId: gardenPlacement.plotId, ...cell }
                        : placement === 'tree'
                          ? { type: 'buyTree', cropId: 'apple', ...cell }
                          : { type: 'buyPlot', ...cell };
                void send(command)
                  .then((saved) => {
                    if (saved) {
                      setPanel(null);
                      setGardenPlacement(null);
                    }
                  })
                  .catch(() => undefined);
              }}
            />
          </View>
        </View>
      )}
      {panel && panel !== 'place' && (
        <View
          style={[
            s.panel,
            {
              bottom,
              left,
              right: right + (width > 700 ? 68 : 0),
              maxHeight: height - top - 64,
              ...(panel === 'shop' && width > 700 ? { left: Math.max(left, width - 740) } : {}),
              ...(['plot', 'remove', 'removeCrop'].includes(panel)
                ? {
                    bottom: undefined,
                    top: Math.max(top + 60, Math.min(contextY - 40, height - bottom - 270)),
                    left: Math.max(
                      left,
                      Math.min(contextX + 24, width - right - Math.min(340, width - left - right)),
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
            <IconButton label="Закрыть панель" icon="close" onPress={() => setPanel(null)} />
          </View>
          <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 3 }}>
            {panel === 'shop' && (
              <View style={[s.row, { flexWrap: 'wrap', marginBottom: 12 }]}>
                {(
                  [
                    { id: 'garden', label: 'Украшения' },
                    { id: 'workshop', label: 'Мастерские' },
                    { id: 'belongings', label: 'Ваши вещи' },
                    { id: 'house', label: 'Дом' },
                  ] as const
                ).map((item) => (
                  <Button key={item.id} label={item.label} onPress={() => setPanel(item.id)} />
                ))}
              </View>
            )}
            {(['journal', 'garden', 'workshop', 'belongings', 'house'] as string[]).includes(
              panel,
            ) && (
              <GardenPanels
                panel={panel as GardenPanel}
                state={state}
                now={serverNow}
                busy={busy}
                act={act}
                place={beginGardenPlacement}
              />
            )}
            {panel === 'decoration' && decoration && (
              <View style={{ gap: 10 }}>
                <GardenArt id={decoration.decorationId} size={96} />
                <Text style={s.text}>
                  Удерживайте и перетаскивайте украшение пальцем. На складе оно сохранится для новой
                  планировки.
                </Text>
                <Button
                  label="Убрать в вещи"
                  disabled={busy}
                  onPress={() => {
                    act({ type: 'storeDecoration', instanceId: decoration.id });
                    setPanel(null);
                  }}
                />
              </View>
            )}
            {panel === 'shop' && (
              <View style={[s.row, { marginBottom: 8, flexWrap: 'wrap' }]}>
                <Button
                  label={`Склад ${storageCount}`}
                  icon="archive-outline"
                  onPress={() => setPanel('storage')}
                />
                <Button
                  label="Заказы"
                  icon="clipboard-outline"
                  onPress={() => setPanel('orders')}
                />
                <Button
                  label={`Грядка - ${bedCost} монет`}
                  primary
                  onPress={() => {
                    setGardenPlacement(null);
                    setPlacement('bed');
                    focusCell(cell.x, cell.y);
                    setPanel('place');
                  }}
                />
                <Button
                  label={`Яблоня - ${treeCost} монет`}
                  onPress={() => {
                    setGardenPlacement(null);
                    setPlacement('tree');
                    focusCell(cell.x, cell.y);
                    setPanel('place');
                  }}
                />
              </View>
            )}
            {(panel === 'shop' || panel === 'seeds') && (
              <>
                {panel !== 'shop' && (
                  <Text style={[s.muted, { marginBottom: 8 }]}>
                    Посадите семена. Урожай продолжит расти после выхода.
                  </Text>
                )}
                <View style={[s.row, { justifyContent: 'space-between', marginBottom: 6 }]}>
                  <Text style={s.choiceName}>Культуры</Text>
                  <View style={[s.row, { gap: 5 }]}>
                    <Text style={s.muted}>Листайте культуры</Text>
                    <Icon name="arrow-forward" size={16} color={p.muted} />
                  </View>
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator
                  contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
                >
                  {CROPS.filter((item) => panel === 'shop' || item.id !== 'apple').map((item) => (
                    <Pressable
                      key={item.id}
                      testID={`pick-farm-seed-${item.id}`}
                      accessibilityRole="button"
                      accessibilityState={{
                        disabled:
                          busy || state.coins < (item.id === 'apple' ? treeCost : item.seedCost),
                      }}
                      accessibilityLabel={`${item.name}. ${item.id === 'apple' ? treeCost : item.seedCost} монет. Рост ${duration(item.growSeconds)}. Продажа ${cropEconomics(item.id).revenue} монет. ${item.id === 'apple' ? `Каждый сбор ${cropEconomics(item.id).profit} монет без новых семян.` : `Чистая прибыль ${cropEconomics(item.id).profit} монет без стоимости грядки.`} ${item.id === 'apple' ? 'Купить яблоню' : 'Выбрать для посадки'}`}
                      disabled={
                        busy || state.coins < (item.id === 'apple' ? treeCost : item.seedCost)
                      }
                      onPress={() => {
                        if (item.id === 'apple') {
                          setGardenPlacement(null);
                          focusCell(cell.x, cell.y);
                          setPlacement('tree');
                          setTool('inspect');
                          setPanel('place');
                        } else {
                          setSeed(item.id);
                          setTool('plant');
                          setHint(null);
                          setPanel(null);
                          if (panel === 'seeds' && current)
                            act({ type: 'plant', plotId: current.id, cropId: item.id });
                        }
                      }}
                      style={({ pressed }) => [
                        s.choice,
                        { padding: 10, gap: 4 },
                        state.coins < (item.id === 'apple' ? treeCost : item.seedCost) &&
                          s.disabled,
                        pressed && s.pressed,
                      ]}
                    >
                      <CropArt cropId={item.id} size={52} />
                      <Text style={s.choiceName}>{item.name}</Text>
                      {item.id === 'carrot' && tutorial.plantings < 2 && (
                        <Text style={s.profit}>Учебная посадка: 45 секунд</Text>
                      )}
                      <Text style={s.muted}>
                        {item.id === 'apple'
                          ? `Дерево ${treeCost} монет`
                          : `Семена ${item.seedCost} монет`}{' '}
                        · {duration(cropEconomics(item.id).growthSeconds)}
                      </Text>
                      <Text style={s.muted}>
                        Продажа урожая {cropEconomics(item.id).revenue} монет
                      </Text>
                      <Text style={s.profit}>
                        {item.id === 'apple'
                          ? `За сбор +${cropEconomics(item.id).profit} монет · окупится за ${Math.ceil(treeCost / cropEconomics(item.id).revenue)} сборов`
                          : `Чистая прибыль +${cropEconomics(item.id).profit} монет`}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            )}
            {panel === 'plot' && current && (
              <View style={{ gap: 10 }}>
                {crop ? (
                  <View style={[s.row, { alignItems: 'center' }]}>
                    <CropArt
                      cropId={crop.id}
                      size={52}
                      phase={phase === 'empty' ? undefined : phase}
                    />
                    <Text style={[s.text, { flex: 1 }]}>
                      {phase === 'withered'
                        ? 'Урожай увял'
                        : phase === 'ready'
                          ? 'Урожай готов'
                          : `До урожая ${duration(remaining)}`}
                    </Text>
                  </View>
                ) : (
                  <Button
                    label="Посадить"
                    icon="leaf-outline"
                    primary
                    disabled={busy}
                    onPress={() => setPanel('seeds')}
                  />
                )}
                {crop && current.plantedAt !== null && phase !== 'withered' && (
                  <Text style={s.muted}>
                    {phase === 'ready'
                      ? `Соберите в течение ${duration((current.plantedAt + (cropTiming(current).growSeconds + cropTiming(current).harvestWindowSeconds) * 1000 - serverNow) / 1000)}`
                      : `После созревания есть ${duration(cropTiming(current).harvestWindowSeconds)} для сбора`}
                  </Text>
                )}
                {crop && phase === 'ready' && (
                  <Button
                    label="Собрать"
                    icon="basket-outline"
                    primary
                    testID="pick-farm-harvest"
                    onPress={() => {
                      setPanel(null);
                      act({ type: 'harvest', plotId: current.id, destination: harvestDestination });
                    }}
                  />
                )}
                {crop && phase === 'withered' && (
                  <Button
                    label="Очистить"
                    icon="leaf-outline"
                    disabled={busy}
                    testID="pick-farm-harvest"
                    onPress={() => {
                      setPanel(null);
                      act({ type: 'clear', plotId: current.id });
                    }}
                  />
                )}
                {crop && current.kind === 'bed' && phase !== 'withered' && phase !== 'ready' && (
                  <Button
                    label="Убрать посадку"
                    icon="close"
                    disabled={busy}
                    onPress={() => setPanel('removeCrop')}
                  />
                )}
                {(current.kind === 'tree' || !current.cropId) && (
                  <Button
                    label="Убрать в вещи"
                    icon="archive-outline"
                    disabled={busy}
                    onPress={() => {
                      act({ type: 'storePlot', plotId: current.id });
                      setPanel(null);
                    }}
                  />
                )}
                <Button
                  label={current.kind === 'tree' ? 'Удалить яблоню' : 'Удалить грядку'}
                  icon="trash-outline"
                  disabled={busy}
                  onPress={() => setPanel('remove')}
                />
              </View>
            )}
            {panel === 'removeCrop' && current && (
              <View style={{ gap: 12 }}>
                <Text style={s.text}>
                  Посадка исчезнет, грядка останется. Монеты за семена не возвращаются.
                </Text>
                <View style={[s.row, { flexWrap: 'wrap' }]}>
                  <Button label="Оставить" onPress={() => setPanel('plot')} />
                  <Button
                    label="Убрать посадку"
                    primary
                    disabled={busy}
                    testID="pick-farm-remove-crop-confirm"
                    onPress={() => {
                      void send({ type: 'removeCrop', plotId: current.id })
                        .then((saved) => {
                          if (saved) {
                            setPanel(null);
                            setSelected(null);
                          }
                        })
                        .catch(() => undefined);
                    }}
                  />
                </View>
              </View>
            )}
            {panel === 'remove' && current && (
              <View style={{ gap: 12 }}>
                <Text style={s.text}>
                  {current.kind === 'tree' ? 'Яблоня' : 'Грядка'} в клетке {current.x + 1},{' '}
                  {current.y + 1} исчезнет с поля.{' '}
                  {crop ? `Посадка «${crop.name}» и несобранный урожай будут потеряны. ` : ''}Монеты
                  за покупку не возвращаются. Урожай на складе сохранится.
                </Text>
                <View style={[s.row, { flexWrap: 'wrap' }]}>
                  <Button label="Оставить" onPress={() => setPanel(null)} />
                  <Button
                    label={current.kind === 'tree' ? 'Удалить яблоню' : 'Удалить грядку'}
                    icon="trash-outline"
                    primary
                    disabled={busy}
                    testID="pick-farm-remove-confirm"
                    onPress={() => {
                      void send({ type: 'removePlot', plotId: current.id })
                        .then((saved) => {
                          if (saved) {
                            setPanel(null);
                            setSelected(null);
                            setHint('Объект удалён. Место свободно.');
                          }
                        })
                        .catch(() => undefined);
                    }}
                  />
                </View>
              </View>
            )}
            {panel === 'storage' && (
              <>
                <Text style={[s.muted, { marginBottom: 12 }]}>
                  Продайте урожай или сохраните его для заказов.
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {CROPS.map((item) => {
                    const needs = Object.entries(
                      ORDERS.find((o) => o.id === progression.reserveOrderId)?.requires ?? {},
                    );
                    const reserved = Math.min(
                      state.inventory[item.id],
                      needs.find(([id]) => id === item.id)?.[1] ?? 0,
                    );
                    const surplus = state.inventory[item.id] - reserved;
                    return (
                      <View key={item.id} style={[s.choice, { width: 150 }]}>
                        <View style={s.row}>
                          <CropArt cropId={item.id} size={64} />
                          <Text style={s.choiceName}>{state.inventory[item.id]} шт.</Text>
                        </View>
                        <Text style={s.choiceName}>{item.name}</Text>
                        {item.id === 'carrot' && tutorial.plantings < 2 && (
                          <Text style={s.profit}>Учебная посадка: 45 секунд</Text>
                        )}
                        <Text style={s.muted}>{item.sellPrice} монет за шт.</Text>
                        {reserved > 0 && (
                          <Text style={s.profit}>{reserved} оставлено для заказа</Text>
                        )}
                        <Button
                          label={`Продать ${surplus} · ${surplus * item.sellPrice}`}
                          disabled={busy || !surplus}
                          testID={`pick-farm-sell-${item.id}`}
                          onPress={() => act({ type: 'sell', cropId: item.id, quantity: surplus })}
                        />
                      </View>
                    );
                  })}
                </ScrollView>
              </>
            )}
            {panel === 'orders' && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 10 }}
              >
                {ORDERS.map((order) => {
                  const needs = Object.entries(order.requires) as [CropId, number][];
                  const available = needs.every(([id, n]) => state.inventory[id] >= n);
                  return (
                    <View key={order.id} style={[s.choice, { width: 220 }]}>
                      <Text style={s.choiceName}>{order.name}</Text>
                      {needs.map(([id, n]) => (
                        <View key={id} style={s.row}>
                          <CropArt cropId={id} size={23} />
                          <Text style={s.text}>
                            {cropFor(id).name} {state.inventory[id]}/{n}
                          </Text>
                        </View>
                      ))}
                      <Text style={s.muted}>
                        +{order.rewardCoins} монет · +{order.rewardXp} XP
                      </Text>
                      <Button
                        testID={`pick-farm-reserve-${order.id}`}
                        label={
                          progression.reserveOrderId === order.id
                            ? 'Сохраняем урожай'
                            : 'Оставлять урожай для заказа'
                        }
                        disabled={busy}
                        active={progression.reserveOrderId === order.id}
                        onPress={() =>
                          act({
                            type: 'setOrderReserve',
                            orderId: progression.reserveOrderId === order.id ? null : order.id,
                          })
                        }
                      />
                      <Button
                        label="Выполнить"
                        primary
                        disabled={busy || !available}
                        testID={`pick-farm-order-${order.id}`}
                        onPress={() => act({ type: 'fulfill', orderId: order.id })}
                      />
                    </View>
                  );
                })}
              </ScrollView>
            )}
            {panel === 'help' && (
              <View style={{ gap: 8 }}>
                <Button
                  label={sound ? 'Звук: включён' : 'Звук: выключен'}
                  icon={sound ? 'volume-high-outline' : 'volume-mute-outline'}
                  onPress={() => setSound(!sound)}
                />
                <HarvestMode destination={harvestDestination} onChange={setHarvestDestination} />
                {state.plots.some((plot) => !isPlantingCell(plot.x, plot.y)) && (
                  <>
                    <Text style={s.text}>Сохранённые грядки за новым участком</Text>
                    {state.plots
                      .filter((plot) => !isPlantingCell(plot.x, plot.y))
                      .map((plot) => (
                        <Button
                          key={plot.id}
                          label={`Грядка ${plot.id + 1}${plot.cropId ? ` - ${cropFor(plot.cropId).name}` : ''}`}
                          onPress={() => {
                            setSelected(plot.id);
                            setPanel('plot');
                          }}
                        />
                      ))}
                  </>
                )}

                <View style={s.row}>
                  <Button
                    label="Приблизить"
                    onPress={() =>
                      updateCamera(camera.current.x, camera.current.y, camera.current.zoom + 1)
                    }
                  />
                  <Button label="Весь участок" onPress={() => updateCamera(0, 0, 1)} />
                </View>
                {canRecoverFarm(state, serverNow) && (
                  <>
                    <Text style={s.text}>
                      Не осталось урожая и монет для посадки? Помощь даст морковь на грядке
                      бесплатно. Время роста будет показано на грядке. Продайте урожай, чтобы
                      продолжить.
                    </Text>
                    <Button
                      label="Восстановить ферму"
                      primary
                      disabled={busy}
                      testID="pick-farm-recover"
                      onPress={() => act({ type: 'recover' })}
                    />
                  </>
                )}
                <Text style={s.text}>
                  Купите грядку на свободном месте, посадите семена и соберите урожай. Продавайте
                  его сразу при сборе или выбирайте «На склад для заказов». Продажа сразу даёт
                  монеты; склад сохраняет продукты без продажи. Чистая прибыль в магазине - выручка
                  минус цена семян, без стоимости грядки. Яблоня плодоносит снова после каждого
                  сбора. Коснитесь спелой грядки для сбора, пустой - для выбора семян. Удерживайте
                  грядку, затем перетащите пальцем. Крестик рядом с названием семян завершает
                  посадку. Удаление грядки всегда просит подтверждение и не возвращает монеты. Рост
                  занимает от нескольких минут до часов. После созревания есть ограниченное время
                  для сбора: затем урожай увянет и будет потерян. Увядшие посадки нужно очистить.
                </Text>
                <Text style={s.text}>
                  Участок 32×32. Дом стоит за границей. Приближайте двумя пальцами; после увеличения
                  двигайте камеру одним. Отдалить дальше начального вида нельзя.
                </Text>
                <Text style={s.muted}>
                  Новые участки дорожают после каждой покупки. Стоимость грядки - вложение в
                  постоянное место; она не входит в прибыль с семян. Яблоня покупается один раз и
                  даёт урожай без повторной платы. Хранение в вещах не требует повторной покупки.
                </Text>
                <Text style={s.muted}>
                  Прогресс сохраняется на сервере. Монеты и XP используются только внутри фермы.
                </Text>
                <Text style={s.muted}>Иллюстрации фермы созданы для PICK FARM.</Text>
              </View>
            )}
          </ScrollView>
          {busy && (
            <Text accessibilityLiveRegion="polite" style={[s.muted, { marginTop: 8 }]}>
              Сохраняем действие...
            </Text>
          )}
        </View>
      )}
      {error && (
        <View style={[s.error, { left, right, top: top + 58 }]} accessibilityLiveRegion="polite">
          <Text style={s.errorText}>{error}</Text>
          <Button label="Обновить" icon="refresh" onPress={retry} />
        </View>
      )}
    </View>
  );
}
