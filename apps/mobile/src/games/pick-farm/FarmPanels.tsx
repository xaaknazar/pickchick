import { Pressable, ScrollView, Text, View } from 'react-native';
import {
  CROPS,
  ORDERS,
  WATER_SPEEDUP,
  canRecoverFarm,
  canWater,
  cropEconomics,
  cropPhase,
  cropTiming,
  getProgression,
  growthProgress,
  isPlantingCell,
  isWatered,
  msUntilReady,
  nextLandCost,
  tutorialProgress,
  type CropId,
  type FarmCommand,
  type FarmState,
} from '@pickchick/farm-game';
import { Icon, type IconName } from '../../components/UI';
import { GardenArt } from './GardenArt';
import { CropArt } from './visuals';
import { farmPalette as p, farmStyles as s } from './styles';
import { BoardCards, GoodsCards } from './RanchPanels';

export type BasicPanel =
  | 'decoration'
  | 'plot'
  | 'shop'
  | 'storage'
  | 'orders'
  | 'help'
  | 'remove'
  | 'seeds'
  | 'removeCrop';
const cropFor = (id: CropId) => CROPS.find((c) => c.id === id)!;
export function duration(seconds: number) {
  const n = Math.max(0, Math.ceil(seconds));
  return n >= 3600
    ? `${Math.floor(n / 3600)} ч${n % 3600 ? ` ${Math.ceil((n % 3600) / 60)} мин` : ''}`
    : n >= 60
      ? `${Math.ceil(n / 60)} мин`
      : `${n} с`;
}
export function Button({
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
        !primary && s.secondary,
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
function Progress({ value, color = p.green }: { value: number; color?: string }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      style={{ height: 8, borderRadius: 4, backgroundColor: '#DFD4BB', overflow: 'hidden' }}
    >
      <View
        style={{
          height: 8,
          width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

export type FarmPanelProps = {
  panel: BasicPanel;
  state: FarmState;
  now: number;
  plotId: number | null;
  decorationId: number | null;
  watering: boolean;
  sound: boolean;
  /** Protocol 3 features (land, animals, board, daily); off against an older Farm API. */
  v3: boolean;
  destination: 'sell' | 'storage';
  act(command: FarmCommand, options?: { close?: boolean }): void;
  setPanel(
    panel:
      | BasicPanel
      | 'place'
      | 'garden'
      | 'workshop'
      | 'belongings'
      | 'house'
      | 'coop'
      | 'barn'
      | 'land'
      | null,
  ): void;
  choosePlacement(kind: 'bed' | 'tree'): void;
  chooseSeed(cropId: CropId): void;
  setSound(value: boolean): void;
  /** Quiet meadow ambience under the effects. */
  birds: boolean;
  setBirds(value: boolean): void;
  setDestination(value: 'sell' | 'storage'): void;
  zoomIn(): void;
  overview(): void;
  selectPlot(id: number): void;
};

/** Contents of the cream panels; layout and title live in the screen. */
export function FarmPanel(props: FarmPanelProps) {
  const { panel, state, now, act, setPanel } = props;
  const progression = getProgression(state);
  const tutorial = tutorialProgress(state);
  const current = state.plots.find((plot) => plot.id === props.plotId);
  const crop = current?.cropId ? cropFor(current.cropId) : null;
  const phase = current ? cropPhase(current, now) : 'empty';
  const bedCost = nextLandCost(state, 'bed');
  const treeCost = nextLandCost(state, 'tree');
  const storageCount = Object.values(state.inventory).reduce((a, b) => a + b, 0);
  const decoration = progression.decorations.find((d) => d.id === props.decorationId);

  if (panel === 'decoration')
    return decoration ? (
      <View style={{ gap: 10 }}>
        <GardenArt id={decoration.decorationId} size={96} />
        <Text style={s.text}>
          Удерживайте украшение и перетащите пальцем. В вещах оно сохранится для новой планировки.
        </Text>
        <Button
          label="Убрать в вещи"
          icon="archive-outline"
          onPress={() =>
            act({ type: 'storeDecoration', instanceId: decoration.id }, { close: true })
          }
        />
      </View>
    ) : null;

  if (panel === 'shop')
    return (
      <>
        <>
          <View style={[s.row, { flexWrap: 'wrap', marginBottom: 10 }]}>
            <Button
              label={`Грядка - ${bedCost} монет`}
              icon="add"
              primary
              onPress={() => props.choosePlacement('bed')}
            />
            <Button
              label={`Яблоня - ${treeCost} монет`}
              onPress={() => props.choosePlacement('tree')}
            />
          </View>
          {props.v3 && (
            <View style={[s.row, { flexWrap: 'wrap', marginBottom: 10 }]}>
              <Button
                label="Расширить землю"
                icon="expand-outline"
                testID="pick-farm-shop-land"
                onPress={() => setPanel('land')}
              />
              <Button
                label="Курятник"
                icon="egg-outline"
                testID="pick-farm-shop-coop"
                onPress={() => setPanel('coop')}
              />
              <Button
                label="Коровник"
                icon="home-outline"
                testID="pick-farm-shop-barn"
                onPress={() => setPanel('barn')}
              />
            </View>
          )}
          <View style={[s.row, { flexWrap: 'wrap', marginBottom: 12 }]}>
            {(
              [
                { id: 'garden', label: 'Украшения', icon: 'flower-outline' },
                { id: 'workshop', label: 'Мастерские', icon: 'restaurant-outline' },
                { id: 'belongings', label: 'Ваши вещи', icon: 'cube-outline' },
                { id: 'house', label: 'Дом', icon: 'home-outline' },
                { id: 'storage', label: `Склад ${storageCount}`, icon: 'archive-outline' },
                { id: 'orders', label: 'Заказы', icon: 'clipboard-outline' },
              ] as const
            ).map((item) => (
              <Button
                key={item.id}
                label={item.label}
                icon={item.icon}
                onPress={() => setPanel(item.id)}
              />
            ))}
          </View>
        </>
        <View style={[s.row, { justifyContent: 'space-between', marginBottom: 6 }]}>
          <Text style={s.choiceName}>Культуры</Text>
          <View style={[s.row, { gap: 5 }]}>
            <Text style={s.muted}>Листайте</Text>
            <Icon name="arrow-forward" size={16} color={p.muted} />
          </View>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
        >
          {CROPS.map((item) => {
            const price = item.id === 'apple' ? treeCost : item.seedCost;
            const poor = state.coins < price;
            const economics = cropEconomics(item.id);
            return (
              <Pressable
                key={item.id}
                testID={`pick-farm-seed-${item.id}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: poor }}
                accessibilityLabel={`${item.name}. ${price} монет. Рост ${duration(item.growSeconds)}. Продажа ${economics.revenue} монет. ${item.id === 'apple' ? `Каждый сбор ${economics.profit} монет без новых семян.` : `Чистая прибыль ${economics.profit} монет без стоимости грядки.`} ${item.id === 'apple' ? 'Купить яблоню' : 'Выбрать для посадки'}`}
                disabled={poor}
                onPress={() =>
                  item.id === 'apple' ? props.choosePlacement('tree') : props.chooseSeed(item.id)
                }
                style={({ pressed }) => [
                  s.choice,
                  { padding: 10, gap: 4 },
                  poor && s.disabled,
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
                  · {duration(economics.growthSeconds)}
                </Text>
                <Text style={s.muted}>Продажа урожая {economics.revenue} монет</Text>
                <Text style={s.profit}>
                  {item.id === 'apple'
                    ? `За сбор +${economics.profit} монет · окупится за ${Math.ceil(treeCost / economics.revenue)} сборов`
                    : `Чистая прибыль +${economics.profit} монет`}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </>
    );

  if (panel === 'plot' && current) {
    const progress = growthProgress(current, now);
    const thirsty = canWater(current, now);
    const watered = isWatered(current);
    const timing = cropTiming(current);
    return (
      <View style={{ gap: 10 }}>
        {crop ? (
          <View style={[s.row, { alignItems: 'center' }]}>
            <CropArt cropId={crop.id} size={52} phase={phase === 'empty' ? undefined : phase} />
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={s.text}>
                {phase === 'withered'
                  ? 'Урожай увял'
                  : phase === 'ready'
                    ? 'Урожай готов'
                    : `До урожая ${duration(msUntilReady(current, now) / 1000)}`}
              </Text>
              {phase === 'growing' && (
                <Progress value={progress} color={watered ? '#3A8FC0' : p.green} />
              )}
            </View>
          </View>
        ) : (
          <Button label="Посадить" icon="leaf-outline" primary onPress={() => setPanel('seeds')} />
        )}
        {crop && current.plantedAt !== null && phase !== 'withered' && (
          <Text style={s.muted}>
            {phase === 'ready'
              ? `Соберите в течение ${duration((current.plantedAt + (timing.growSeconds + timing.harvestWindowSeconds) * 1000 - now) / 1000)}`
              : watered
                ? 'Полито: растёт быстрее, срок сбора сохранён'
                : `После созревания есть ${duration(timing.harvestWindowSeconds)} для сбора`}
          </Text>
        )}
        {crop && thirsty && (
          <Button
            label={
              props.watering
                ? `Полить - на ${Math.round(WATER_SPEEDUP * 100)}% быстрее`
                : 'Полив после обновления сервера'
            }
            icon="water-outline"
            primary
            disabled={!props.watering}
            testID="pick-farm-water"
            onPress={() => act({ type: 'water', plotId: current.id }, { close: true })}
          />
        )}
        {crop && phase === 'ready' && (
          <Button
            label="Собрать"
            icon="basket-outline"
            primary
            testID="pick-farm-harvest"
            onPress={() =>
              act(
                { type: 'harvest', plotId: current.id, destination: props.destination },
                { close: true },
              )
            }
          />
        )}
        {crop && phase === 'withered' && (
          <Button
            label="Очистить"
            icon="leaf-outline"
            testID="pick-farm-harvest"
            onPress={() => act({ type: 'clear', plotId: current.id }, { close: true })}
          />
        )}
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          {crop && current.kind === 'bed' && phase !== 'withered' && phase !== 'ready' && (
            <Button label="Убрать посадку" icon="close" onPress={() => setPanel('removeCrop')} />
          )}
          {(current.kind === 'tree' || !current.cropId) && (
            <Button
              label="Убрать в вещи"
              icon="archive-outline"
              onPress={() => act({ type: 'storePlot', plotId: current.id }, { close: true })}
            />
          )}
          <Button
            label={current.kind === 'tree' ? 'Удалить яблоню' : 'Удалить грядку'}
            icon="trash-outline"
            onPress={() => setPanel('remove')}
          />
        </View>
      </View>
    );
  }
  if (panel === 'removeCrop' && current)
    return (
      <View style={{ gap: 12 }}>
        <Text style={s.text}>
          Посадка исчезнет, грядка останется. Монеты за семена не возвращаются.
        </Text>
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          <Button label="Оставить" onPress={() => setPanel('plot')} />
          <Button
            label="Убрать посадку"
            primary
            testID="pick-farm-remove-crop-confirm"
            onPress={() => act({ type: 'removeCrop', plotId: current.id }, { close: true })}
          />
        </View>
      </View>
    );
  if (panel === 'remove' && current)
    return (
      <View style={{ gap: 12 }}>
        <Text style={s.text}>
          {current.kind === 'tree' ? 'Яблоня' : 'Грядка'} в клетке {current.x + 1}, {current.y + 1}{' '}
          исчезнет с поля.{' '}
          {crop ? `Посадка «${crop.name}» и несобранный урожай будут потеряны. ` : ''}
          Монеты за покупку не возвращаются. Урожай на складе сохранится.
        </Text>
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          <Button label="Оставить" onPress={() => setPanel(null)} />
          <Button
            label={current.kind === 'tree' ? 'Удалить яблоню' : 'Удалить грядку'}
            icon="trash-outline"
            primary
            testID="pick-farm-remove-confirm"
            onPress={() => act({ type: 'removePlot', plotId: current.id }, { close: true })}
          />
        </View>
      </View>
    );
  if (panel === 'storage')
    return (
      <>
        <Text style={[s.muted, { marginBottom: 12 }]}>
          {props.v3
            ? 'Продайте урожай или сохраните его для заказов и корма животным.'
            : 'Продайте урожай или сохраните его для заказов.'}
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {props.v3 && <GoodsCards state={state} act={act} />}
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
                <Text style={s.muted}>{item.sellPrice} монет за шт.</Text>
                {reserved > 0 && <Text style={s.profit}>{reserved} оставлено для заказа</Text>}
                <Button
                  label={`Продать ${surplus} · ${surplus * item.sellPrice}`}
                  disabled={!surplus}
                  testID={`pick-farm-sell-${item.id}`}
                  onPress={() => act({ type: 'sell', cropId: item.id, quantity: surplus })}
                />
              </View>
            );
          })}
        </ScrollView>
      </>
    );
  if (panel === 'orders')
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10 }}
      >
        {props.v3 && <BoardCards state={state} now={now} act={act} />}
        {props.v3 && <View style={{ width: 2, borderRadius: 1, backgroundColor: p.border }} />}
        {ORDERS.map((order) => {
          const needs = Object.entries(order.requires) as [CropId, number][];
          const available = needs.every(([id, n]) => state.inventory[id] >= n);
          return (
            <View
              key={order.id}
              style={[
                s.choice,
                { width: 220 },
                available && { borderWidth: 2, borderColor: p.green },
              ]}
            >
              <Text style={s.choiceName}>{order.name}</Text>
              {needs.map(([id, n]) => (
                <View key={id} style={s.row}>
                  <CropArt cropId={id} size={23} />
                  <Text style={[s.text, state.inventory[id] >= n && { color: p.green }]}>
                    {cropFor(id).name} {Math.min(state.inventory[id], n)}/{n}
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
                disabled={!available}
                testID={`pick-farm-order-${order.id}`}
                onPress={() => act({ type: 'fulfill', orderId: order.id })}
              />
            </View>
          );
        })}
      </ScrollView>
    );
  if (panel === 'help')
    return (
      <View style={{ gap: 8 }}>
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          <Button
            label={props.sound ? 'Звук: включён' : 'Звук: выключен'}
            icon={props.sound ? 'volume-high-outline' : 'volume-mute-outline'}
            onPress={() => props.setSound(!props.sound)}
          />
          {props.sound && (
            <Button
              label={props.birds ? 'Птицы: включены' : 'Птицы: выключены'}
              icon={props.birds ? 'musical-notes-outline' : 'musical-note-outline'}
              testID="pick-farm-birds"
              onPress={() => props.setBirds(!props.birds)}
            />
          )}
          <Button label="Приблизить" icon="add" onPress={props.zoomIn} />
          <Button label="Весь участок" icon="scan-outline" onPress={props.overview} />
        </View>
        <HarvestMode destination={props.destination} onChange={props.setDestination} />
        {state.plots.some((plot) => !isPlantingCell(plot.x, plot.y)) && (
          <>
            <Text style={s.text}>Сохранённые грядки за новым участком</Text>
            {state.plots
              .filter((plot) => !isPlantingCell(plot.x, plot.y))
              .map((plot) => (
                <Button
                  key={plot.id}
                  label={`Грядка ${plot.id + 1}${plot.cropId ? ` - ${cropFor(plot.cropId).name}` : ''}`}
                  onPress={() => props.selectPlot(plot.id)}
                />
              ))}
          </>
        )}
        {canRecoverFarm(state, now) && (
          <>
            <Text style={s.text}>
              Не осталось урожая и монет для посадки? Помощь даст морковь на грядке бесплатно. Время
              роста будет показано на грядке. Продайте урожай, чтобы продолжить.
            </Text>
            <Button
              label="Восстановить ферму"
              primary
              testID="pick-farm-recover"
              onPress={() => act({ type: 'recover' }, { close: true })}
            />
          </>
        )}
        <Text style={s.choiceName}>Как играть</Text>
        <Text style={s.text}>
          Коснитесь пустой грядки и выберите семена - дальше касайтесь или проводите пальцем по
          пустым грядкам. Капля над растением значит «полей меня»: касание поливает, полив ускоряет
          рост на {Math.round(WATER_SPEEDUP * 100)}% и даёт опыт. Корзинка - урожай готов: коснитесь
          или проведите пальцем по всем спелым грядкам. Увядшую посадку очищает одно касание.
        </Text>
        {props.v3 && (
          <Text style={s.text}>
            Животные: коснитесь курицы с яйцом или коровы с молоком - товар уйдёт на склад. Голодное
            животное сидит с облачком корма: касание кормит его морковью или томатами со склада.
            Проведите пальцем по двору - соберёте или накормите всех подряд. Касание загона собирает
            всё готовое, удержание открывает карточку загона.
          </Text>
        )}
        <Text style={s.text}>
          Удерживайте грядку, дерево или украшение, пока не появится кольцо, и перетащите пальцем. У
          края экрана поле само сдвинется. Двумя пальцами двигайте и приближайте поле, двойное
          касание по траве приближает. Отпустите объект на занятом месте - перенос отменится.
        </Text>
        <Text style={s.muted}>
          Сбор продаёт урожай сразу или кладёт на склад для заказов. Чистая прибыль в магазине -
          выручка минус цена семян, без стоимости грядки. Новые участки дорожают после каждой
          покупки, удаление не возвращает монеты. После созревания есть ограниченное время для
          сбора, затем урожай увянет. Полив не сокращает этот срок.
        </Text>
        <Text style={s.muted}>
          Действия видны сразу и сохраняются на сервере по порядку. Монеты и опыт меняются после
          подтверждения сервера. Монеты и XP используются только внутри фермы.
        </Text>
        <Text style={s.muted}>Иллюстрации фермы созданы для PICK FARM.</Text>
      </View>
    );
  return null;
}

/**
 * Compact seed picker along the bottom edge: the chosen bed stays visible above it.
 * Choosing a crop plants the tapped bed and keeps planting by touch or sweep.
 */
export function SeedBar({
  state,
  plotId,
  current: active,
  chooseSeed,
  close,
  openPlot,
}: {
  state: FarmState;
  plotId: number | null;
  current: CropId | null;
  chooseSeed(cropId: CropId): void;
  close(): void;
  openPlot(): void;
}) {
  const tutorial = tutorialProgress(state);
  const bed = state.plots.find((plot) => plot.id === plotId);
  return (
    <View style={{ gap: 8 }}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={[s.choiceName, { fontSize: 16 }]}>Что посадим?</Text>
        <View style={[s.row, { gap: 6 }]}>
          {bed && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Действия с грядкой"
              onPress={openPlot}
              style={({ pressed }) => [
                s.button,
                { minHeight: 40, paddingHorizontal: 10 },
                pressed && s.pressed,
              ]}
            >
              <Icon name="ellipsis-horizontal" size={18} color={p.ink} />
              <Text style={s.buttonText}>Грядка</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть панель"
            onPress={close}
            style={({ pressed }) => [
              s.button,
              { minHeight: 40, width: 44, paddingHorizontal: 0 },
              pressed && s.pressed,
            ]}
          >
            <Icon name="close" size={22} color={p.ink} />
          </Pressable>
        </View>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
      >
        {CROPS.filter((item) => item.kind !== 'tree').map((item) => {
          const poor = state.coins < item.seedCost;
          const economics = cropEconomics(item.id);
          const quick = item.id === 'carrot' && tutorial.plantings < 2;
          return (
            <Pressable
              key={item.id}
              testID={`pick-farm-seed-${item.id}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: poor, selected: active === item.id }}
              accessibilityLabel={`${item.name}. Семена ${item.seedCost} монет. Рост ${quick ? '45 секунд' : duration(item.growSeconds)}. Чистая прибыль ${economics.profit} монет.`}
              disabled={poor}
              onPress={() => chooseSeed(item.id)}
              style={({ pressed }) => [
                s.choice,
                {
                  width: 164,
                  padding: 8,
                  gap: 2,
                  flexDirection: 'row',
                  alignItems: 'center',
                  borderWidth: 2,
                  borderColor: active === item.id ? p.orange : 'transparent',
                },
                poor && s.disabled,
                pressed && s.pressed,
              ]}
            >
              <CropArt cropId={item.id} size={44} />
              <View style={{ flex: 1, marginLeft: 6, gap: 1 }}>
                <Text style={s.choiceName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={s.muted} numberOfLines={1}>
                  {item.seedCost} монет · {quick ? '45 с' : duration(item.growSeconds)}
                </Text>
                <Text style={s.profit} numberOfLines={1}>
                  +{economics.profit} прибыль
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
