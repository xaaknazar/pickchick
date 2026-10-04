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
  expansionCost,
  levelForXp,
  type CropId,
  type FarmCommand,
} from '@pickchick/farm-game';
import { Icon, type IconName } from '../../components/UI';
import { useFarm } from './useFarm';
import { CropArt, Landscape, Sprite, isoPoint } from './visuals';
import { farmPalette as p, farmStyles as s } from './styles';
import { CropMotion, HarvestFeedback, useFarmMotion, type FarmFeedback } from './motion';

type Panel = 'plot' | 'shop' | 'storage' | 'orders' | 'expand' | 'help' | null;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const cropFor = (id: CropId) => CROPS.find((c) => c.id === id)!;
function duration(seconds: number) {
  const n = Math.max(0, Math.ceil(seconds));
  return n < 60 ? `${n} с` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
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
  const motion = useFarmMotion();
  const [feedback, setFeedback] = useState<FarmFeedback | null>(null);
  const feedbackId = useRef(0);
  const clearFeedback = useCallback(() => setFeedback(null), []);
  const camera = useRef({ x: 0, y: 0, zoom: 1 });
  const gestureStart = useRef({ x: 0, y: 0, zoom: 1, distance: 0 });
  const movedAt = useRef(0);
  const pan = useRef(new Animated.ValueXY()).current;
  const zoom = useRef(new Animated.Value(1)).current;
  const fit = Math.min(1.45, Math.max(0.48, Math.min((width - 100) / 660, (height - 110) / 340)));
  const updateCamera = useCallback(
    (x: number, y: number, scale: number) => {
      const next = {
        x: clamp(x, -340, 340),
        y: clamp(y, -230, 230),
        zoom: clamp(scale, 0.65, 2.4),
      };
      camera.current = next;
      pan.setValue({ x: next.x, y: next.y });
      zoom.setValue(next.zoom);
    },
    [pan, zoom],
  );
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
  const readyCount = state.plots.filter(
    (plot) =>
      plot.cropId &&
      plot.plantedAt !== null &&
      plot.plantedAt + cropFor(plot.cropId).growSeconds * 1000 <= serverNow,
  ).length;
  const storageCount = Object.values(state.inventory).reduce((a, b) => a + b, 0);
  const panelTitle =
    panel === 'plot'
      ? crop?.name || `Грядка ${Number(selected) + 1}`
      : {
          shop: 'Семена и саженцы',
          storage: 'Склад урожая',
          orders: 'Заказы фермы',
          expand: 'Больше места для урожая',
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
      <View style={{ flex: 1 }} {...responder.panHandlers} testID="pick-farm-world">
        <Animated.View
          style={{
            position: 'absolute',
            width: 900,
            height: 600,
            left: (width - 900) / 2,
            top: (height - 600) / 2 + 26,
            transform: [
              { translateX: pan.x },
              { translateY: pan.y },
              { scale: Animated.multiply(zoom, fit) },
            ],
          }}
        >
          <Landscape />
          {state.plots.map((plot) => {
            const point = isoPoint(2 + (plot.id % 4), 2 + Math.floor(plot.id / 4));
            const planted = plot.cropId ? cropFor(plot.cropId) : null;
            const wait =
              planted && plot.plantedAt !== null
                ? Math.max(0, (plot.plantedAt + planted.growSeconds * 1000 - serverNow) / 1000)
                : 0;
            return (
              <View key={plot.id} style={{ position: 'absolute', left: point.x, top: point.y }}>
                <Sprite kind="soil" x={0} y={12} width={86} />
                <Pressable
                  testID={`pick-farm-plot-${plot.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Грядка ${plot.id + 1}. ${planted ? `${planted.name}. ${wait ? `До урожая ${duration(wait)}` : 'Урожай готов'}` : 'Пустая. Выбрать семена'}`}
                  onPress={() => {
                    if (Date.now() - movedAt.current < 160) return;
                    setSelected(plot.id);
                    setPanel('plot');
                  }}
                  style={[s.plot, { left: -43, top: -49 }]}
                >
                  {selected === plot.id && (
                    <View pointerEvents="none" style={[s.selection, { top: 24 }]} />
                  )}
                  <CropMotion cropId={plot.cropId} ready={Boolean(planted && !wait)} {...motion}>
                    {planted ? (
                      <View style={{ opacity: wait ? 0.65 : 1, marginBottom: 9 }}>
                        <CropArt cropId={planted.id} size={planted.id === 'apple' ? 55 : 44} />
                      </View>
                    ) : (
                      <Text style={s.emptyPlot}>+</Text>
                    )}
                  </CropMotion>
                  {planted && !wait && (
                    <View style={s.ready}>
                      <Icon name="checkmark" color="#FFFFFF" size={17} />
                    </View>
                  )}
                  {planted && wait > 0 && <Text style={s.time}>{duration(wait)}</Text>}
                </Pressable>
              </View>
            );
          })}
        </Animated.View>
      </View>
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
            label="Расширить ферму"
            icon="expand-outline"
            onPress={() => setPanel('expand')}
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
                    ? 'Выберите пустую грядку, чтобы посадить. Монеты фермы - игровые.'
                    : 'Посадите семена. Урожай продолжит расти после выхода.'}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {CROPS.map((item) => (
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
                    {remaining
                      ? `До урожая ${duration(remaining)}`
                      : `Урожай готов: ${crop.harvestYield} шт.`}
                  </Text>
                  <Text style={s.muted}>
                    {crop.id === 'apple'
                      ? `Сбор ${current.harvests + 1} из ${crop.maxHarvests}. Дерево плодоносит повторно.`
                      : 'После сбора здесь можно посадить снова.'}
                  </Text>
                </View>
                <Button
                  label={remaining ? 'Растёт' : 'Собрать урожай'}
                  icon="basket-outline"
                  primary
                  testID="pick-farm-harvest"
                  disabled={busy || remaining > 0}
                  onPress={() => act({ type: 'harvest', plotId: current.id })}
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
            {panel === 'expand' && (
              <View style={{ gap: 12 }}>
                <Text style={s.text}>
                  {state.plots.length >= 24
                    ? 'Все 24 грядки уже открыты.'
                    : `Добавьте 4 грядки за ${expansionCost(state.plots.length)} монет. Сейчас грядок: ${state.plots.length}/24.`}
                </Text>
                {state.plots.length < 24 && (
                  <>
                    <Text style={s.muted}>
                      После расширения останется минимум 4 монеты на семена.
                    </Text>
                    <Button
                      label={`Открыть 4 грядки · ${expansionCost(state.plots.length)}`}
                      primary
                      disabled={busy || state.coins < expansionCost(state.plots.length) + 4}
                      onPress={() => act({ type: 'expand' })}
                      testID="pick-farm-expand"
                    />
                  </>
                )}
              </View>
            )}
            {panel === 'help' && (
              <View style={{ gap: 8 }}>
                <Text style={s.text}>
                  Коснитесь грядки, посадите семена и соберите урожай. Продавайте его на складе или
                  выполняйте заказы. Яблоня даёт три урожая.
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
