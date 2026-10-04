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
  BED_COST,
  TREE_COST,
  FIELD_SIZE,
  HOUSE_CELL,
  cropPhase,
  canRecoverFarm,
  levelForXp,
  type CropId,
  type FarmCommand,
} from '@pickchick/farm-game';
import { Icon, type IconName } from '../../components/UI';
import { useFarm } from './useFarm';
import { CropArt, Landscape, Sprite, isoPoint, cellAtPoint } from './visuals';
import { farmPalette as p, farmStyles as s } from './styles';
import { CropMotion, HarvestFeedback, useFarmMotion, type FarmFeedback } from './motion';

type Panel = 'plot' | 'shop' | 'storage' | 'orders' | 'place' | 'help' | 'remove' | null;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
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

function FarmTool({
  label,
  icon,
  active = false,
  onPress,
  testID,
}: {
  label: string;
  icon: IconName;
  active?: boolean;
  onPress(): void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [s.dockTool, active && s.dockActive, pressed && s.pressed]}
    >
      <Icon name={icon} size={23} color={active ? p.ink : p.paper} />
      <Text style={[s.dockLabel, active && { color: p.ink }]}>{label}</Text>
    </Pressable>
  );
}

export function PickFarmScreen() {
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const inset = useSafeAreaInsets();
  const { state, serverNow, loading, busy, error, retry, send } = useFarm();
  const [panel, setPanel] = useState<Panel>(null);
  const [tool, setTool] = useState<'inspect' | 'harvest' | 'plant' | 'move' | 'remove'>('inspect');
  const [seed, setSeed] = useState<CropId>('carrot');
  const [hint, setHint] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [placement, setPlacement] = useState<'bed' | 'tree' | 'move'>('bed');
  const [cell, setCell] = useState({ x: 32, y: 30 });
  const motion = useFarmMotion();
  const [feedback, setFeedback] = useState<FarmFeedback | null>(null);
  const feedbackId = useRef(0);
  const clearFeedback = useCallback(() => setFeedback(null), []);
  const camera = useRef({ x: 0, y: 0, zoom: 1 });
  const gestureStart = useRef({ x: 0, y: 0, zoom: 1, distance: 0, moved: false, multi: false });
  const pan = useRef(new Animated.ValueXY()).current;
  const zoom = useRef(new Animated.Value(1)).current;
  const fit = Math.min(1.5, Math.max(1.05, height / 420));
  const updateCamera = useCallback(
    (x: number, y: number, scale: number) => {
      const next = {
        x: clamp(x, -2900 * scale * fit, 2900 * scale * fit),
        y: clamp(y, -1450 * scale * fit, 1450 * scale * fit),
        zoom: clamp(scale, 0.6, 2),
      };
      camera.current = next;
      pan.setValue({ x: next.x, y: next.y });
      zoom.setValue(next.zoom);
    },
    [pan, zoom, fit],
  );
  useEffect(() => {
    updateCamera(0, 0, camera.current.zoom);
  }, [updateCamera]);
  const distance = (e: GestureResponderEvent) => {
    const [a, b] = e.nativeEvent.touches;
    return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
  };
  const act = useCallback(
    (command: FarmCommand) => {
      const harvested =
        command.type === 'harvest'
          ? state?.plots.find((plot) => plot.id === command.plotId)?.cropId
          : null;
      void send(command)
        .then((saved) => {
          if (saved === true) setHint(null);
          if (saved === true && harvested) {
            feedbackId.current += 1;
            setFeedback({
              id: feedbackId.current,
              text: `+${cropFor(harvested).harvestYield} ${cropFor(harvested).name} на склад`,
            });
          }
        })
        .catch(() => undefined);
    },
    [send, state],
  );
  const selectAt = useCallback(
    (event: GestureResponderEvent) => {
      if (panel && panel !== 'place') return;
      const scale = camera.current.zoom * fit;
      // Web Pressable mouse events expose page coordinates, native exposes local ones.
      const tapX = Number.isFinite(event.nativeEvent.locationX)
        ? event.nativeEvent.locationX
        : event.nativeEvent.pageX;
      const tapY = Number.isFinite(event.nativeEvent.locationY)
        ? event.nativeEvent.locationY
        : event.nativeEvent.pageY;
      const px = (tapX - width / 2 - camera.current.x) / scale;
      const py = (tapY - height / 2 - 54 - camera.current.y + 70 * scale) / scale;
      const { x, y } = cellAtPoint(px + 450, py + 230);
      if (
        x < 0 ||
        y < 0 ||
        x >= FIELD_SIZE ||
        y >= FIELD_SIZE ||
        (panel !== 'place' && x === HOUSE_CELL.x && y === HOUSE_CELL.y)
      )
        return;
      const plot = state?.plots.find((item) => item.x === x && item.y === y);
      setCell({ x, y });
      if (panel === 'place') return;
      if (busy) return;
      if (plot) {
        setSelected(plot.id);
        if (tool === 'harvest') {
          const phase = cropPhase(plot, serverNow);
          if (phase === 'ready') act({ type: 'harvest', plotId: plot.id });
          else
            setHint(
              phase === 'withered'
                ? 'Урожай увял. Откройте грядку и очистите её.'
                : phase === 'empty'
                  ? 'Грядка пуста. Выберите «Посадить».'
                  : 'Урожай ещё растёт. Собирайте грядки с галочкой.',
            );
          return;
        }
        if (tool === 'plant') {
          if (plot.kind !== 'bed' || plot.cropId) {
            setHint('Для семян выберите пустую грядку.');
            return;
          }
          if ((state?.coins ?? 0) < cropFor(seed).seedCost) {
            setHint('Не хватает монет. Продайте урожай на складе.');
            return;
          }
          act({ type: 'plant', plotId: plot.id, cropId: seed });
          return;
        }
        if (tool === 'remove') {
          setPanel('remove');
          return;
        }
        if (tool === 'move') {
          setPlacement('move');
          setPanel('place');
          return;
        }
        setPanel('plot');
      } else {
        if (tool !== 'inspect') {
          setHint(
            tool === 'plant'
              ? 'Сначала купите грядку в магазине.'
              : 'Выберите грядку или яблоню на поле.',
          );
          return;
        }
        setPlacement('bed');
        setPanel('place');
      }
    },
    [fit, width, height, state, panel, tool, seed, busy, serverNow, act],
  );
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (e, g) =>
          e.nativeEvent.touches.length > 1 || Math.abs(g.dx) + Math.abs(g.dy) > 7,
        onPanResponderGrant: (e) => {
          gestureStart.current = {
            ...camera.current,
            distance: distance(e),
            moved: false,
            multi: e.nativeEvent.touches.length > 1,
          };
        },
        onPanResponderMove: (e, g) => {
          const start = gestureStart.current;
          if (Math.abs(g.dx) + Math.abs(g.dy) > 7) start.moved = true;
          if (e.nativeEvent.touches.length > 1) start.multi = true;
          const d = distance(e);
          if (d > 0) {
            if (start.distance === 0) {
              start.distance = d;
              start.zoom = camera.current.zoom;
            }
            updateCamera(camera.current.x, camera.current.y, (start.zoom * d) / start.distance);
          } else if (start.moved) updateCamera(start.x + g.dx, start.y + g.dy, camera.current.zoom);
        },
        onPanResponderRelease: (e) => {
          if (!gestureStart.current.moved && !gestureStart.current.multi) selectAt(e);
        },
      }),
    [updateCamera, selectAt],
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
      ? Math.max(0, (current.plantedAt + crop.growSeconds * 1000 - serverNow) / 1000)
      : 0;
  if (!state)
    return (
      <View style={s.screen}>
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
  const readyCount = state.plots.filter((plot) => cropPhase(plot, serverNow) === 'ready').length;
  const phase = current ? cropPhase(current, serverNow) : 'empty';
  const occupied =
    (cell.x === HOUSE_CELL.x && cell.y === HOUSE_CELL.y) ||
    state.plots.some(
      (plot) =>
        plot.x === cell.x && plot.y === cell.y && !(placement === 'move' && plot.id === selected),
    );
  const validCell =
    cell.x >= 0 && cell.y >= 0 && cell.x < FIELD_SIZE && cell.y < FIELD_SIZE && !occupied;
  const storageCount = Object.values(state.inventory).reduce((a, b) => a + b, 0);
  const panelTitle =
    panel === 'plot'
      ? crop?.name || `Грядка ${Number(selected) + 1}`
      : {
          shop: 'Магазин фермы',
          remove: 'Удалить с поля?',
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
    <View style={s.screen} testID="pick-farm-screen">
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -80,
          top: -60,
          width: width + 160,
          height: height + 120,
          transform: [
            {
              translateX: pan.x.interpolate({
                inputRange: [-3000, 3000],
                outputRange: [-45, 45],
                extrapolate: 'clamp',
              }),
            },
            {
              translateY: pan.y.interpolate({
                inputRange: [-1500, 1500],
                outputRange: [-30, 30],
                extrapolate: 'clamp',
              }),
            },
          ],
        }}
      >
        <NativeImage
          source={require('../../../assets/games/pick-farm/meadow-painted-v2.png')}
          resizeMode="cover"
          accessible={false}
          style={{ width: '100%', height: '100%' }}
        />
      </Animated.View>
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
            top: (height - 600) / 2 + 54,
            transform: [
              { translateX: pan.x },
              { translateY: pan.y },
              { scale: Animated.multiply(zoom, fit) },
            ],
          }}
        >
          <Landscape grid={panel === 'place'} cell={cell} />
          {state.plots
            .slice()
            .sort((a, b) => a.x + a.y - b.x - b.y)
            .map((plot) => {
              const point = isoPoint(plot.x, plot.y),
                planted = plot.cropId ? cropFor(plot.cropId) : null,
                plotPhase = cropPhase(plot, serverNow);
              return (
                <View
                  key={plot.id}
                  pointerEvents="none"
                  style={{ position: 'absolute', left: point.x, top: point.y }}
                >
                  {plot.kind === 'bed' && <Sprite kind="soil" x={0} y={20} width={100} />}
                  <View
                    testID={`pick-farm-plot-${plot.id}`}
                    style={[s.plot, { left: -43, top: -78 }]}
                  >
                    {selected === plot.id && <View style={[s.selection, { top: 28 }]} />}
                    <CropMotion cropId={plot.cropId} ready={plotPhase === 'ready'} {...motion}>
                      {planted && (
                        <CropArt
                          cropId={planted.id}
                          size={plot.kind === 'tree' ? 112 : plotPhase === 'growing' ? 58 : 76}
                          phase={plotPhase === 'empty' ? undefined : plotPhase}
                        />
                      )}
                    </CropMotion>
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
          {panel === 'place' && (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: isoPoint(cell.x, cell.y).x - 32,
                top: isoPoint(cell.x, cell.y).y - 32,
              }}
            >
              <View
                style={[
                  s.selection,
                  {
                    borderColor: validCell ? '#FFF9EA' : '#AA372A',
                    backgroundColor: validCell ? '#FFFFFF35' : '#AA372A55',
                  },
                ]}
              />
            </View>
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
      <View style={{ position: 'absolute', right, top: top + 60, gap: 8 }}>
        <IconButton
          label="Приблизить ферму"
          icon="add"
          onPress={() =>
            updateCamera(camera.current.x, camera.current.y, camera.current.zoom + 0.2)
          }
        />
        <IconButton
          label="Отдалить ферму"
          icon="remove"
          onPress={() =>
            updateCamera(camera.current.x, camera.current.y, camera.current.zoom - 0.2)
          }
        />
        <IconButton
          label="Вернуть ферму в центр"
          icon="locate-outline"
          onPress={() => updateCamera(0, 0, 1)}
        />
      </View>
      {!panel && (
        <View style={{ position: 'absolute', bottom, left, right, gap: 8 }}>
          {canRecoverFarm(state, serverNow) && (
            <Button label="Нет семян? Получить помощь" onPress={() => setPanel('help')} />
          )}
          <View style={[s.row, { alignItems: 'flex-end' }]}>
            <View
              style={[s.pill, { flex: 1, minHeight: 36, paddingVertical: 8 }]}
              accessibilityLiveRegion="polite"
            >
              <Text style={s.muted}>
                {busy
                  ? 'Сохраняем...'
                  : hint ||
                    (tool === 'harvest'
                      ? `Сбор: касайтесь урожая с галочкой (${readyCount})`
                      : tool === 'plant'
                        ? `${cropFor(seed).name}: ${cropFor(seed).seedCost} монет за посадку. Выберите пустые грядки.`
                        : tool === 'move'
                          ? 'Перенос: выберите грядку или яблоню.'
                          : tool === 'remove'
                            ? 'Удаление: выберите объект. Затем подтвердите.'
                            : readyCount
                              ? `Готово к сбору: ${readyCount}. Выберите «Собрать».`
                              : state.plots.length
                                ? 'Ваша ферма. Коснитесь грядки, чтобы посмотреть урожай.'
                                : 'Начните свою ферму: откройте магазин и купите первую грядку.')}
              </Text>
            </View>
            {tool !== 'inspect' && (
              <Button
                label="Готово"
                icon="checkmark"
                testID="pick-farm-tool-done"
                onPress={() => {
                  setTool('inspect');
                  setHint(null);
                  setSelected(null);
                }}
              />
            )}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={s.dock}
            contentContainerStyle={{
              gap: 4,
              padding: 6,
              flexGrow: 1,
              justifyContent: 'space-around',
            }}
          >
            {(
              [
                { id: 'harvest', label: 'Собрать', icon: 'basket-outline' },
                { id: 'plant', label: 'Посадить', icon: 'leaf-outline' },
                { id: 'move', label: 'Перенести', icon: 'move-outline' },
                { id: 'remove', label: 'Удалить', icon: 'trash-outline' },
              ] as const
            ).map((item) => (
              <FarmTool
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={tool === item.id}
                testID={`pick-farm-tool-${item.id}`}
                onPress={() => {
                  setHint(null);
                  if (tool === item.id) {
                    setTool('inspect');
                    return;
                  }
                  if (item.id === 'plant') setPanel('shop');
                  else setTool(item.id);
                }}
              />
            ))}
            <FarmTool
              label={`Склад ${storageCount}`}
              icon="archive-outline"
              onPress={() => setPanel('storage')}
            />
            <FarmTool label="Заказы" icon="clipboard-outline" onPress={() => setPanel('orders')} />
          </ScrollView>
        </View>
      )}
      {panel && (
        <View
          style={[
            s.panel,
            {
              bottom,
              left,
              right: right + (width > 700 ? 68 : 0),
              maxHeight: height - top - 64,
              ...(panel === 'shop' && width > 700 ? { left: Math.max(left, width - 740) } : {}),
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
              <View style={[s.row, { marginBottom: 8, flexWrap: 'wrap' }]}>
                <Button
                  label={`Грядка - ${BED_COST} монет`}
                  primary
                  onPress={() => {
                    setPlacement('bed');
                    setPanel('place');
                  }}
                />
                <Button
                  label={`Яблоня - ${TREE_COST} монет`}
                  onPress={() => {
                    setPlacement('tree');
                    setPanel('place');
                  }}
                />
              </View>
            )}
            {(panel === 'shop' || (panel === 'plot' && !crop)) && (
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
                          busy || state.coins < (item.id === 'apple' ? TREE_COST : item.seedCost),
                      }}
                      accessibilityLabel={`${item.name}. ${item.id === 'apple' ? TREE_COST : item.seedCost} монет. ${item.growSeconds} секунд. ${item.id === 'apple' ? 'Купить яблоню' : 'Выбрать для посадки'}`}
                      disabled={
                        busy || state.coins < (item.id === 'apple' ? TREE_COST : item.seedCost)
                      }
                      onPress={() => {
                        if (item.id === 'apple') {
                          setPlacement('tree');
                          setTool('inspect');
                          setPanel('place');
                        } else {
                          setSeed(item.id);
                          setTool('plant');
                          setHint(null);
                          setPanel(null);
                          if (panel === 'plot' && current)
                            act({ type: 'plant', plotId: current.id, cropId: item.id });
                        }
                      }}
                      style={({ pressed }) => [
                        s.choice,
                        { padding: 10, gap: 4 },
                        state.coins < (item.id === 'apple' ? TREE_COST : item.seedCost) &&
                          s.disabled,
                        pressed && s.pressed,
                      ]}
                    >
                      <CropArt cropId={item.id} size={52} />
                      <Text style={s.choiceName}>{item.name}</Text>
                      <Text style={s.muted}>
                        {item.id === 'apple' ? TREE_COST : item.seedCost} монет ·{' '}
                        {duration(item.growSeconds)}
                      </Text>
                      <Text style={s.muted}>
                        {item.id === 'apple'
                          ? 'Плодоносит повторно'
                          : `Урожай ${item.harvestYield} шт. · продажа ${item.harvestYield * item.sellPrice} монет`}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            )}
            {panel === 'plot' && crop && current && (
              <View style={[s.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <CropArt cropId={crop.id} size={84} phase={phase === 'empty' ? undefined : phase} />
                <View style={{ flex: 1, minWidth: 150 }}>
                  <Text style={s.text}>
                    {phase === 'withered'
                      ? 'Урожай увял и потерян'
                      : remaining
                        ? `До урожая ${duration(remaining)}`
                        : `Урожай готов: ${crop.harvestYield} шт.`}
                  </Text>
                  <Text style={s.muted}>
                    {phase === 'ready' && current.plantedAt !== null
                      ? `Соберите в течение ${duration((current.plantedAt + (crop.growSeconds + crop.harvestWindowSeconds) * 1000 - serverNow) / 1000)}. `
                      : ''}
                    {crop.id === 'apple'
                      ? 'Дерево остаётся и плодоносит повторно.'
                      : 'После сбора здесь можно посадить снова.'}
                  </Text>
                </View>
                <Button
                  label={
                    phase === 'withered' ? 'Очистить' : remaining ? 'Растёт' : 'Собрать урожай'
                  }
                  icon="basket-outline"
                  primary
                  testID="pick-farm-harvest"
                  disabled={busy || phase === 'growing'}
                  onPress={() =>
                    act({ type: phase === 'withered' ? 'clear' : 'harvest', plotId: current.id })
                  }
                />
              </View>
            )}
            {panel === 'plot' && current && (
              <View style={[s.row, { marginTop: 12, flexWrap: 'wrap' }]}>
                <Button label="Удалить" icon="trash-outline" onPress={() => setPanel('remove')} />
                <Button
                  label="Переместить"
                  onPress={() => {
                    setCell({ x: current.x, y: current.y });
                    setPlacement('move');
                    setPanel('place');
                  }}
                />
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
                  {CROPS.map((item) => (
                    <View key={item.id} style={[s.choice, { width: 150 }]}>
                      <View style={s.row}>
                        <CropArt cropId={item.id} size={64} />
                        <Text style={s.choiceName}>{state.inventory[item.id]} шт.</Text>
                      </View>
                      <Text style={s.choiceName}>{item.name}</Text>
                      <Text style={s.muted}>{item.sellPrice} монет за шт.</Text>
                      <Button
                        label={`Продать · ${state.inventory[item.id] * item.sellPrice}`}
                        disabled={busy || !state.inventory[item.id]}
                        testID={`pick-farm-sell-${item.id}`}
                        onPress={() =>
                          act({ type: 'sell', cropId: item.id, quantity: state.inventory[item.id] })
                        }
                      />
                    </View>
                  ))}
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
            {panel === 'place' && (
              <View style={{ gap: 10 }}>
                <Text style={s.text}>
                  Коснитесь свободной клетки. Поле можно перемещать и приближать.
                </Text>
                <View style={[s.row, { flexWrap: 'wrap' }]}>
                  <Text style={s.text}>
                    Клетка {cell.x + 1}, {cell.y + 1}
                  </Text>
                  <IconButton
                    label="На клетку влево"
                    icon="arrow-back"
                    onPress={() => setCell((c) => ({ ...c, x: Math.max(0, c.x - 1) }))}
                  />
                  <IconButton
                    label="На клетку вправо"
                    icon="arrow-forward"
                    onPress={() => setCell((c) => ({ ...c, x: Math.min(FIELD_SIZE - 1, c.x + 1) }))}
                  />
                  <IconButton
                    label="На клетку вверх"
                    icon="arrow-up"
                    onPress={() => setCell((c) => ({ ...c, y: Math.max(0, c.y - 1) }))}
                  />
                  <IconButton
                    label="На клетку вниз"
                    icon="arrow-down"
                    onPress={() => setCell((c) => ({ ...c, y: Math.min(FIELD_SIZE - 1, c.y + 1) }))}
                  />
                  <Button
                    primary
                    label={
                      placement === 'move'
                        ? 'Переместить сюда'
                        : `Купить - ${placement === 'tree' ? TREE_COST : BED_COST} монет`
                    }
                    disabled={
                      busy ||
                      !validCell ||
                      (placement !== 'move' &&
                        state.coins < (placement === 'tree' ? TREE_COST : BED_COST))
                    }
                    onPress={() => {
                      const command: FarmCommand =
                        placement === 'move' && current
                          ? { type: 'movePlot', plotId: current.id, ...cell }
                          : placement === 'tree'
                            ? { type: 'buyTree', cropId: 'apple', ...cell }
                            : { type: 'buyPlot', ...cell };
                      void send(command)
                        .then((saved) => {
                          if (saved) setPanel(null);
                        })
                        .catch(() => undefined);
                    }}
                  />
                </View>
                {!validCell && (
                  <Text style={s.errorText}>Это место занято. Выберите свободную клетку.</Text>
                )}
              </View>
            )}
            {panel === 'help' && (
              <View style={{ gap: 8 }}>
                {canRecoverFarm(state, serverNow) && (
                  <>
                    <Text style={s.text}>
                      Не осталось урожая и монет для посадки? Помощь даст морковь на грядке
                      бесплатно. Она вырастет за 1 час. Продайте урожай, чтобы продолжить.
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
                  его на складе или выполняйте заказы. Яблоня плодоносит снова после каждого сбора.
                  Кнопка «Собрать» включает сбор по касанию; «Посадить» выбирает семена для
                  нескольких пустых грядок. «Готово» завершает инструмент. «Удалить» всегда просит
                  подтверждение и не возвращает монеты. Рост занимает часы. После созревания есть
                  ограниченное время для сбора: затем урожай увянет и будет потерян. Увядшие посадки
                  нужно очистить.
                </Text>
                <Text style={s.text}>
                  Перемещайте поле одним пальцем, приближайте двумя. Кнопки справа меняют масштаб и
                  возвращают ферму в центр.
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
