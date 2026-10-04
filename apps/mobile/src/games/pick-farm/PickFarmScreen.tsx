import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  PanResponder,
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
  levelForXp,
  type CropId,
  type FarmCommand,
} from '@pickchick/farm-game';
import { Icon, type IconName } from '../../components/UI';
import { useFarm } from './useFarm';
import { CropArt, Landscape, Sprite, isoPoint, cellAtPoint } from './visuals';
import { farmPalette as p, farmStyles as s } from './styles';
import { CropMotion, HarvestFeedback, useFarmMotion, type FarmFeedback } from './motion';

type Panel = 'plot' | 'shop' | 'storage' | 'orders' | 'place' | 'help' | null;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const cropFor = (id: CropId) => CROPS.find((c) => c.id === id)!;
function duration(seconds: number) {
  const n = Math.max(0, Math.ceil(seconds));
  return n >= 3600
    ? `${Math.floor(n / 3600)} ч ${Math.ceil((n % 3600) / 60)} мин`
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
}: {
  label: string;
  icon?: IconName;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary && s.primary,
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

export function PickFarmScreen() {
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const inset = useSafeAreaInsets();
  const { state, serverNow, loading, busy, error, retry, send } = useFarm();
  const [panel, setPanel] = useState<Panel>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [placement, setPlacement] = useState<'bed' | 'tree' | 'move'>('bed');
  const [cell, setCell] = useState({ x: 32, y: 30 });
  const motion = useFarmMotion();
  const [feedback, setFeedback] = useState<FarmFeedback | null>(null);
  const feedbackId = useRef(0);
  const clearFeedback = useCallback(() => setFeedback(null), []);
  const camera = useRef({ x: 0, y: 0, zoom: 1 });
  const gestureStart = useRef({ x: 0, y: 0, zoom: 1, distance: 0 });
  const movedAt = useRef(0);
  const pan = useRef(new Animated.ValueXY()).current;
  const zoom = useRef(new Animated.Value(1)).current;
  const fit = Math.min(1.3, Math.max(0.75, height / 520));
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
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (e) => e.nativeEvent.touches.length > 1,
        onMoveShouldSetPanResponder: (e, g) =>
          e.nativeEvent.touches.length > 1 || Math.abs(g.dx) + Math.abs(g.dy) > 7,
        onPanResponderGrant: (e) => {
          gestureStart.current = { ...camera.current, distance: distance(e) };
          movedAt.current = Date.now();
        },
        onPanResponderMove: (e, g) => {
          movedAt.current = Date.now();
          const start = gestureStart.current;
          const d = distance(e);
          if (d > 0) {
            if (start.distance === 0) {
              start.distance = d;
              start.zoom = camera.current.zoom;
            }
            updateCamera(camera.current.x, camera.current.y, (start.zoom * d) / start.distance);
          } else updateCamera(start.x + g.dx, start.y + g.dy, camera.current.zoom);
        },
        onPanResponderRelease: () => {
          movedAt.current = Date.now();
        },
        onPanResponderTerminate: () => {
          movedAt.current = Date.now();
        },
      }),
    [updateCamera],
  );
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (panel) {
        setPanel(null);
        return true;
      }
      return false;
    });
    return () => back.remove();
  }, [panel]);
  const act = (command: FarmCommand) => {
    const harvested =
      command.type === 'harvest'
        ? state?.plots.find((plot) => plot.id === command.plotId)?.cropId
        : null;
    void send(command)
      .then((saved) => {
        if (saved === true && harvested) {
          feedbackId.current += 1;
          setFeedback({
            id: feedbackId.current,
            text: `+${cropFor(harvested).harvestYield} урожая`,
          });
        }
      })
      .catch(() => undefined);
  };
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
          shop: 'Семена и саженцы',
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
      <Pressable
        style={{ flex: 1 }}
        {...responder.panHandlers}
        testID="pick-farm-world"
        accessibilityLabel="Поле фермы. Выберите место для грядки"
        onPress={(event) => {
          if (Date.now() - movedAt.current < 180) return;
          const scale = camera.current.zoom * fit;
          const px = (event.nativeEvent.locationX - width / 2 - camera.current.x) / scale;
          const py =
            (event.nativeEvent.locationY - height / 2 - 54 - camera.current.y + 70 * scale) / scale;
          const { x, y } = cellAtPoint(px + 450, py + 230);
          if (
            x < 0 ||
            y < 0 ||
            x >= FIELD_SIZE ||
            y >= FIELD_SIZE ||
            (panel !== 'place' && x === HOUSE_CELL.x && y === HOUSE_CELL.y)
          )
            return;
          const plot = state.plots.find((item) => item.x === x && item.y === y);
          setCell({ x, y });
          if (panel === 'place') return;
          if (plot) {
            setSelected(plot.id);
            setPanel('plot');
          } else {
            setPlacement('bed');
            setPanel('place');
          }
        }}
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
                  {plot.kind === 'bed' && <Sprite kind="soil" x={0} y={12} width={92} />}
                  <View
                    testID={`pick-farm-plot-${plot.id}`}
                    style={[s.plot, { left: -43, top: -58 }]}
                  >
                    {selected === plot.id && <View style={[s.selection, { top: 28 }]} />}
                    <CropMotion cropId={plot.cropId} ready={plotPhase === 'ready'} {...motion}>
                      {planted && (
                        <CropArt
                          cropId={planted.id}
                          size={plot.kind === 'tree' ? 78 : plotPhase === 'growing' ? 35 : 48}
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
      </Pressable>
      <View style={[s.hud, { top, left }]}>
        <IconButton label="Выйти из фермы" icon="arrow-back" onPress={() => router.back()} />
        <View style={s.pill}>
          <Text style={s.metric}>{state.coins} монет</Text>
        </View>
        <View style={s.pill}>
          <Text style={s.metric}>Ур. {levelForXp(state.xp)}</Text>
          <Text style={s.muted}>{state.xp} XP</Text>
        </View>
      </View>
      <View style={[s.hud, { top, right }]}>
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
        <View style={[s.bottomBar, { bottom, left }]}>
          <Button label="Магазин" icon="leaf-outline" onPress={() => setPanel('shop')} />
          <Button
            label={`Склад ${storageCount}`}
            icon="basket-outline"
            onPress={() => setPanel('storage')}
          />
          <Button label="Заказы" icon="clipboard-outline" onPress={() => setPanel('orders')} />
          <IconButton
            label="Купить грядку"
            icon="expand-outline"
            onPress={() => {
              setPlacement('bed');
              setPanel('place');
            }}
          />
        </View>
      )}
      {!panel && (
        <View pointerEvents="none" style={[s.pill, { position: 'absolute', bottom, right }]}>
          <Text style={s.muted}>
            {busy
              ? 'Сохраняем...'
              : readyCount
                ? `Готово к сбору: ${readyCount}`
                : 'Коснитесь грядки'}
          </Text>
        </View>
      )}
      {panel && (
        <View
          style={[
            s.panel,
            { bottom, left, right: right + (width > 700 ? 68 : 0), maxHeight: height - top - 64 },
          ]}
          testID={`pick-farm-panel-${panel}`}
        >
          <View style={s.panelHeader}>
            <Text style={[s.panelTitle, { flex: 1 }]}>{panelTitle}</Text>
            <IconButton label="Закрыть панель" icon="close" onPress={() => setPanel(null)} />
          </View>
          <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 3 }}>
            {(panel === 'shop' || (panel === 'plot' && !crop)) && (
              <>
                <Text style={[s.muted, { marginBottom: 12 }]}>
                  {panel === 'shop'
                    ? 'Купите грядку или яблоню, выбрав свободное место на поле.'
                    : 'Посадите семена. Урожай продолжит расти после выхода.'}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {CROPS.filter((item) => panel === 'shop' || item.id !== 'apple').map((item) => (
                    <Pressable
                      key={item.id}
                      testID={`pick-farm-seed-${item.id}`}
                      accessibilityRole="button"
                      accessibilityState={{
                        disabled: busy || state.coins < item.seedCost || panel === 'shop',
                      }}
                      accessibilityLabel={`${item.name}. ${item.seedCost} монет. ${item.growSeconds} секунд. ${panel === 'shop' ? 'Сначала выберите грядку' : 'Посадить'}`}
                      disabled={busy || state.coins < item.seedCost || panel === 'shop'}
                      onPress={() => {
                        if (current) act({ type: 'plant', plotId: current.id, cropId: item.id });
                      }}
                      style={({ pressed }) => [
                        s.choice,
                        state.coins < item.seedCost && s.disabled,
                        pressed && s.pressed,
                      ]}
                    >
                      <CropArt cropId={item.id} size={36} />
                      <Text style={s.choiceName}>{item.name}</Text>
                      <Text style={s.muted}>
                        {item.seedCost} монет · {duration(item.growSeconds)}
                      </Text>
                      <Text style={s.muted}>
                        {item.id === 'apple' ? '3 урожая с дерева' : `Урожай: ${item.harvestYield}`}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            )}
            {panel === 'plot' && crop && current && (
              <View style={[s.row, { alignItems: 'center', flexWrap: 'wrap' }]}>
                <CropArt cropId={crop.id} size={54} />
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
                      ? `Сбор ${current.harvests + 1} из ${crop.maxHarvests}. Дерево плодоносит повторно.`
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
              <Button
                label="Переместить"
                onPress={() => {
                  setCell({ x: current.x, y: current.y });
                  setPlacement('move');
                  setPanel('place');
                }}
              />
            )}
            {panel === 'shop' && state.plots.length > 0 && (
              <ScrollView horizontal contentContainerStyle={{ gap: 8, marginTop: 12 }}>
                {state.plots.map((plot) => (
                  <Button
                    key={plot.id}
                    label={`${plot.kind === 'tree' ? 'Яблоня' : 'Грядка'} ${plot.x + 1}, ${plot.y + 1}`}
                    onPress={() => {
                      setSelected(plot.id);
                      setPanel('plot');
                    }}
                  />
                ))}
              </ScrollView>
            )}
            {panel === 'shop' && (
              <View style={[s.row, { marginTop: 12 }]}>
                <Button
                  label={`Грядка - ${BED_COST} монет`}
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
                        <CropArt cropId={item.id} size={32} />
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
                <Text style={s.text}>
                  Купите грядку на свободном месте, посадите семена и соберите урожай. Продавайте
                  его на складе или выполняйте заказы. Яблоня даёт три урожая. Рост занимает часы.
                  После созревания есть ограниченное время для сбора: затем урожай увянет и будет
                  потерян. Увядшие посадки нужно очистить.
                </Text>
                <Text style={s.text}>
                  Перемещайте поле одним пальцем, приближайте двумя. Кнопки справа меняют масштаб и
                  возвращают ферму в центр.
                </Text>
                <Text style={s.muted}>
                  Прогресс сохраняется на сервере. Монеты и XP используются только внутри фермы.
                </Text>
                <Text style={s.muted}>
                  Графика: Kenney (CC0); ботанические значки: Delapouite и Lorc, game-icons.net (CC
                  BY 3.0).
                </Text>
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
