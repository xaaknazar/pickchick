import { useEffect, useRef } from 'react';
import { Animated, Image, Pressable, Text, View } from 'react-native';
import {
  ANIMALS,
  CROPS,
  DAILY_REWARDS,
  GOODS,
  LAND_MAX,
  PENS,
  RECIPES,
  animalCost,
  animalStatus,
  boardEntries,
  boardOrder,
  dailyStatus,
  getProgression,
  itemCount,
  itemInfo,
  landBounds,
  levelForXp,
  nextLandExpansion,
  type CropId,
  type FarmCommand,
  type FarmState,
  type GoodId,
  type ItemId,
  type PenId,
} from '@pickchick/farm-game';
import { Icon } from '../../components/UI';
import { CropArt } from './visuals';
import { ANIMAL_ART, GOOD_ART } from './Ranch';
import { Button, duration } from './FarmPanels';
import { farmPalette as p, farmStyles as s } from './styles';

type Act = (command: FarmCommand, options?: { close?: boolean }) => boolean | void;

/** Picture for any item: crops, eggs and milk, kitchen and florist products. */
export function ItemIcon({ id, size = 26 }: { id: ItemId; size?: number }) {
  if (CROPS.some((c) => c.id === id)) return <CropArt cropId={id as CropId} size={size} />;
  if (id === 'egg' || id === 'milk')
    return (
      <Image
        source={GOOD_ART[id]}
        accessible={false}
        style={{ width: size, height: size, resizeMode: 'contain' }}
      />
    );
  const florist = RECIPES.find((r) => r.id === id)?.stationId === 'florist';
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: florist ? '#F6D6E4' : '#F7E2BE',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon
        name={florist ? 'flower' : 'restaurant'}
        size={size * 0.58}
        color={florist ? '#B4467A' : '#A3612A'}
      />
    </View>
  );
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10,
    m100 = n % 100;
  return m10 === 1 && m100 !== 11
    ? one
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)
      ? few
      : many;
};

/** Coop or barn: build, buy animals, feed from storage, collect goods. */
export function PenPanel({
  pen: penId,
  state,
  now,
  act,
}: {
  pen: PenId;
  state: FarmState;
  now: number;
  act: Act;
}) {
  const pen = PENS.find((v) => v.id === penId)!;
  const animal = ANIMALS.find((v) => v.id === pen.animal)!;
  const level = levelForXp(state.xp);
  const owned = (getProgression(state).pens ?? []).includes(penId);
  const [feedCrop, feedAmount] = Object.entries(animal.feed)[0] as [CropId, number];
  const feedName = CROPS.find((c) => c.id === feedCrop)!.name;
  const good = GOODS.find((g) => g.id === animal.good)!;
  const rule = `Корм: ${feedName} ${feedAmount} шт. на одно животное. ${good.name} через ${duration(animal.seconds)}.`;
  if (!owned)
    return (
      <View style={{ gap: 10 }}>
        <View style={[s.row, { alignItems: 'flex-start' }]}>
          <Image
            source={ANIMAL_ART[animal.id].source}
            accessible={false}
            style={{ width: 64, height: 64 * ANIMAL_ART[animal.id].ratio, resizeMode: 'contain' }}
          />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.text}>
              {pen.name} на {pen.capacity} {plural(pen.capacity, 'место', 'места', 'мест')}. {rule}
            </Text>
            <Text style={s.muted}>
              Корм берётся со склада. При сборе выберите «На склад для заказов».
            </Text>
          </View>
        </View>
        <Button
          primary
          testID={`pick-farm-buy-pen-${penId}`}
          icon="hammer-outline"
          label={
            level < pen.unlockLevel
              ? `Откроется на уровне ${pen.unlockLevel}`
              : `Построить - ${pen.cost} монет`
          }
          disabled={level < pen.unlockLevel || state.coins < pen.cost}
          onPress={() => act({ type: 'buyPen', pen: penId })}
        />
      </View>
    );
  const status = animalStatus(state, animal.id, now);
  const price = animalCost(state, animal.id);
  const full = status.list.length >= pen.capacity;
  const feedable = Math.min(
    status.hungry.length,
    Math.floor(state.inventory[feedCrop] / feedAmount),
  );
  const stock = getProgression(state).goods?.[good.id] ?? 0;
  return (
    <View style={{ gap: 10 }}>
      <View style={[s.row, { flexWrap: 'wrap' }]}>
        <Text style={s.choiceName}>
          {status.list.length} из {pen.capacity}
        </Text>
        {status.ready.length > 0 && <Text style={s.profit}>Готово: {status.ready.length}</Text>}
        {status.hungry.length > 0 && (
          <Text style={[s.muted, { color: '#B4621E' }]}>Голодные: {status.hungry.length}</Text>
        )}
        {status.nextReadyAt !== null && (
          <Text style={s.muted}>Ещё {duration((status.nextReadyAt - now) / 1000)}</Text>
        )}
      </View>
      <Text style={s.muted}>{rule}</Text>
      {status.list.length === 0 && (
        <Text style={s.text}>Купите первое животное - оно появится во дворе.</Text>
      )}
      <View style={[s.row, { flexWrap: 'wrap' }]}>
        {status.ready.length > 0 && (
          <Button
            primary
            icon="basket-outline"
            testID={`pick-farm-collect-${penId}`}
            label={`Собрать ${status.ready.length}`}
            onPress={() => act({ type: 'collectAnimals', kind: animal.id })}
          />
        )}
        {status.hungry.length > 0 && (
          <Button
            primary={!status.ready.length}
            icon="nutrition-outline"
            testID={`pick-farm-feed-${penId}`}
            label={
              feedable
                ? `Покормить ${feedable} · ${feedName} ${feedable * feedAmount}`
                : `Нет корма на складе: ${feedName}`
            }
            disabled={!feedable}
            onPress={() => act({ type: 'feedAnimals', kind: animal.id })}
          />
        )}
        <Button
          icon="add"
          testID={`pick-farm-buy-animal-${penId}`}
          label={full ? 'Мест нет' : `${animal.name} - ${price} монет`}
          disabled={full || state.coins < price}
          onPress={() => act({ type: 'buyAnimal', kind: animal.id })}
        />
      </View>
      {stock > 0 && (
        <View style={[s.row, { flexWrap: 'wrap' }]}>
          <ItemIcon id={good.id} size={28} />
          <Text style={s.text}>
            {good.name}: {stock} на складе
          </Text>
          <Button
            label={`Продать ${stock} · ${stock * good.sellPrice}`}
            testID={`pick-farm-sell-good-${good.id}`}
            onPress={() => act({ type: 'sellGood', good: good.id, quantity: stock })}
          />
        </View>
      )}
    </View>
  );
}

export function LandPanel({ state, act }: { state: FarmState; act: Act }) {
  const b = landBounds(state);
  const next = nextLandExpansion(state);
  const level = levelForXp(state.xp);
  const size = b.maxX - b.minX + 1;
  if (!next)
    return (
      <Text style={s.text}>
        Вся земля фермы открыта: участок {size} на {size} клеток.
      </Text>
    );
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.text}>
        Сейчас открыто {size} на {size} клеток. Расширение откроет участок {next.size} на{' '}
        {next.size}: +{next.size * next.size - size * size} клеток для грядок, деревьев и украшений.
      </Text>
      <Text style={s.muted}>
        Этап {b.land + 1} из {LAND_MAX}. Затемнённая трава - земля, которую ещё можно купить.
      </Text>
      <Button
        primary
        icon="expand-outline"
        testID="pick-farm-expand-land"
        label={
          level < next.unlockLevel
            ? `Откроется на уровне ${next.unlockLevel}`
            : `Расширить - ${next.cost} монет`
        }
        disabled={level < next.unlockLevel || state.coins < next.cost}
        onPress={() => act({ type: 'expandLand' }, { close: true })}
      />
    </View>
  );
}

function Countdown({ ms }: { ms: number }) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return (
    <Text style={s.choiceName}>
      {Math.floor(total / 60)}:{String(total % 60).padStart(2, '0')}
    </Text>
  );
}

/** Three customers on the board; a completed or skipped order is replaced after a pause. */
export function BoardCards({ state, now, act }: { state: FarmState; now: number; act: Act }) {
  return (
    <>
      {boardEntries(state).map((entry, slot) => {
        if (entry.readyAt > now)
          return (
            <View
              key={`board-${slot}`}
              testID={`pick-farm-board-${slot}`}
              style={[s.choice, { width: 220, alignItems: 'center', justifyContent: 'center' }]}
            >
              <Icon name="time-outline" size={26} color={p.muted} />
              <Text style={s.muted}>Новый заказ через</Text>
              <Countdown ms={entry.readyAt - now} />
            </View>
          );
        const order = boardOrder(slot, entry);
        const needs = Object.entries(order.requires) as [ItemId, number][];
        const ready = needs.every(([id, n]) => itemCount(state, id) >= n);
        return (
          <View
            key={`board-${slot}`}
            testID={`pick-farm-board-${slot}`}
            style={[
              s.choice,
              { width: 220, gap: 4 },
              ready && { borderWidth: 2, borderColor: p.green },
            ]}
          >
            <View style={s.row}>
              <Icon name="person-circle-outline" size={22} color={p.ink} />
              <Text style={s.choiceName} numberOfLines={1}>
                {order.customer}
              </Text>
            </View>
            {needs.map(([id, n]) => (
              <View key={id} style={[s.row, { gap: 6 }]}>
                <ItemIcon id={id} size={22} />
                <Text
                  style={[s.text, { flex: 1 }, itemCount(state, id) >= n && { color: p.green }]}
                  numberOfLines={1}
                >
                  {itemInfo(id).name} {Math.min(itemCount(state, id), n)}/{n}
                </Text>
              </View>
            ))}
            <Text style={s.profit}>
              +{order.rewardCoins} монет · +{order.rewardXp} XP
            </Text>
            <View style={[s.row, { gap: 8 }]}>
              <View style={{ flex: 1 }}>
                <Button
                  primary
                  label="Отдать"
                  disabled={!ready}
                  testID={`pick-farm-board-fulfill-${slot}`}
                  onPress={() => act({ type: 'fulfillBoard', slot })}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Другой заказ: новый покупатель через 5 минут"
                testID={`pick-farm-board-skip-${slot}`}
                onPress={() => act({ type: 'skipBoard', slot })}
                style={({ pressed }) => [
                  s.button,
                  { width: 48, paddingHorizontal: 0, justifyContent: 'center' },
                  pressed && s.pressed,
                ]}
              >
                <Icon name="refresh" size={20} color={p.ink} />
              </Pressable>
            </View>
          </View>
        );
      })}
    </>
  );
}

/** Eggs and milk in storage, sold here or kept for recipes and the order board. */
export function GoodsCards({ state, act }: { state: FarmState; act: Act }) {
  return (
    <>
      {GOODS.map((good) => {
        const n = getProgression(state).goods?.[good.id as GoodId] ?? 0;
        return (
          <View key={good.id} style={[s.choice, { width: 150 }]}>
            <View style={s.row}>
              <ItemIcon id={good.id} size={56} />
              <Text style={s.choiceName}>{n} шт.</Text>
            </View>
            <Text style={s.choiceName}>{good.name}</Text>
            <Text style={s.muted}>{good.sellPrice} монет за шт.</Text>
            <Button
              label={`Продать ${n} · ${n * good.sellPrice}`}
              disabled={!n}
              testID={`pick-farm-sell-good-${good.id}`}
              onPress={() => act({ type: 'sellGood', good: good.id, quantity: n })}
            />
          </View>
        );
      })}
    </>
  );
}

/** Daily gift: a 7-day ladder; missing a day starts it again. */
export function DailyCard({
  state,
  now,
  reduced,
  onClaim,
  onClose,
}: {
  state: FarmState;
  now: number;
  reduced: boolean;
  onClaim(): void;
  onClose(): void;
}) {
  const daily = dailyStatus(state, now);
  const step = (daily.streak - 1) % DAILY_REWARDS.length;
  const t = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    const a = Animated.spring(t, {
      toValue: 1,
      damping: 13,
      stiffness: 160,
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [t, reduced]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Закрыть подарок дня"
      onPress={onClose}
      testID="pick-farm-daily"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        backgroundColor: '#14261D66',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Animated.View
        onStartShouldSetResponder={() => true}
        style={{
          backgroundColor: p.paper,
          borderRadius: 24,
          paddingHorizontal: 22,
          paddingVertical: 18,
          alignItems: 'center',
          gap: 10,
          maxWidth: 560,
          marginHorizontal: 16,
          opacity: t,
          transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }],
        }}
      >
        <View style={s.row}>
          <Icon name="gift" size={26} color={p.orange} />
          <Text style={s.title}>Подарок дня</Text>
        </View>
        <Text style={[s.muted, { textAlign: 'center' }]}>
          Заходите каждый день: награда растёт 7 дней подряд. Пропуск начинает серию заново.
        </Text>
        <View style={[s.row, { gap: 6, flexWrap: 'wrap', justifyContent: 'center' }]}>
          {DAILY_REWARDS.map((reward, i) => {
            const done = daily.available ? i < step : i <= step;
            const today = i === step;
            return (
              <View
                key={i}
                style={{
                  width: 62,
                  paddingVertical: 6,
                  borderRadius: 12,
                  alignItems: 'center',
                  backgroundColor: today ? '#FFE5CF' : done ? '#DCEBD2' : '#EEE4CC',
                  borderWidth: today ? 2 : 0,
                  borderColor: p.orange,
                }}
              >
                <Text style={s.muted}>День {i + 1}</Text>
                {done && !today ? (
                  <Icon name="checkmark-circle" size={20} color={p.green} />
                ) : (
                  <Text style={s.choiceName}>{reward.coins}</Text>
                )}
              </View>
            );
          })}
        </View>
        {daily.available ? (
          <Button
            primary
            icon="gift-outline"
            testID="pick-farm-daily-claim"
            label={`Забрать ${daily.reward.coins} монет и ${daily.reward.xp} XP`}
            onPress={onClaim}
          />
        ) : (
          <Text style={s.text}>Сегодняшний подарок получен. Приходите завтра!</Text>
        )}
        <Button label="Позже" onPress={onClose} />
      </Animated.View>
    </Pressable>
  );
}
