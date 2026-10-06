import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import {
  DECORATIONS,
  RECIPES,
  questProgress,
  getProgression,
  levelForXp,
  goalProgress,
  LEVEL_XP,
  itemCount,
  itemInfo,
  type FarmCommand,
  type FarmState,
  type ItemId,
} from '@pickchick/farm-game';
import { Icon } from '../../components/UI';
import { farmPalette as p, farmStyles as s } from './styles';
import { GardenArt } from './GardenArt';

export const chapterAdvice: Record<string, string> = {
  'first-harvest': 'Поставьте грядку, посадите морковь и соберите первый урожай.',
  'garden-path': 'Соберите два украшения. Подаренная дорожка уже лежит в ваших вещах.',
  'first-order': 'Откройте заказы, оставьте нужный урожай и выполните корзину Алекса.',
  'growing-garden': 'Выращивайте разные культуры и соберите 15 урожаев.',
  workshop: 'На уровне 4 можно открыть садовую кухню в мастерских.',
  'first-recipe': 'Отложите урожай на склад, приготовьте и заберите первое изделие.',
  'flower-yard': 'Соберите восемь украшений для вашего сада.',
  'almaty-garden': 'Выполните 15 игровых заказов.',
  master: 'Приготовьте и заберите 20 изделий в мастерских.',
  'cozy-home': 'Достигните уровня 10 и завершите историю сада.',
};
export type GardenPlacement =
  | { kind: 'decoration'; decorationId: (typeof DECORATIONS)[number]['id'] }
  | { kind: 'storedDecoration'; instanceId: number }
  | { kind: 'storedPlot'; plotId: number };
export type GardenPanel = 'journal' | 'garden' | 'workshop' | 'belongings' | 'house';
function Action({
  label,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  disabled?: boolean;
  onPress(): void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.button, s.primary, disabled && s.disabled, pressed && s.pressed]}
    >
      <Text style={[s.buttonText, s.primaryText]}>{label}</Text>
    </Pressable>
  );
}
function Meter({ value, total }: { value: number; total: number }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: Math.min(value, total) }}
      style={{ height: 5, backgroundColor: '#DFD4BB', borderRadius: 3, overflow: 'hidden' }}
    >
      <View
        style={{
          height: 5,
          width: `${Math.min(100, (value / total) * 100)}%`,
          backgroundColor: p.green,
        }}
      />
    </View>
  );
}
export function GardenPanels({
  panel,
  state,
  now,
  busy,
  act,
  place,
  v3 = true,
}: {
  panel: GardenPanel;
  state: FarmState;
  now: number;
  busy: boolean;
  act(command: FarmCommand): void;
  place(value: GardenPlacement): void;
  /** Recipes with eggs or milk need protocol 3; an older Farm API does not know them. */
  v3?: boolean;
}) {
  const [journalTab, setJournalTab] = useState<'story' | 'daily'>('story');
  const progress = getProgression(state),
    level = levelForXp(state.xp);
  if (panel === 'journal')
    return (
      <View style={{ gap: 16 }}>
        <Text style={s.text}>
          Обустраивайте свой сад вместе с Алексом. Награды открываются по порядку и сохраняются на
          вашем аккаунте.
        </Text>
        <Text style={s.choiceName}>
          Уровень {level} / 10 · {state.xp} XP
          {level < 10 ? ` · следующий: ${LEVEL_XP[level]} XP` : ''}
        </Text>
        <View style={s.row}>
          <Action
            label="История сада"
            disabled={journalTab === 'story'}
            onPress={() => setJournalTab('story')}
          />
          <Action
            label="День и неделя"
            disabled={journalTab === 'daily'}
            onPress={() => setJournalTab('daily')}
          />
        </View>
        {journalTab === 'daily' &&
          goalProgress(state, now).map((goal) => (
            <View key={goal.id} style={{ gap: 8 }}>
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.choiceName}>{goal.name}</Text>
                  <Text style={s.muted}>
                    {goal.progress}/{goal.target} · {goal.rewardCoins} монет + {goal.rewardXp} XP
                  </Text>
                </View>
                <Action
                  label={goal.claimed ? 'Получено' : 'Забрать'}
                  disabled={busy || goal.claimed || goal.progress < goal.target}
                  onPress={() =>
                    act({
                      type: 'claimGoal',
                      goalId: goal.id as Extract<FarmCommand, { type: 'claimGoal' }>['goalId'],
                    })
                  }
                />
              </View>
              <Meter value={goal.progress} total={goal.target} />
            </View>
          ))}

        {journalTab === 'story' &&
          questProgress(state).map((quest, index) => (
            <View
              key={quest.id}
              style={{
                gap: 8,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: p.border,
                opacity: quest.available || quest.claimed ? 1 : 0.65,
              }}
            >
              <View style={s.row}>
                <Icon
                  name={quest.claimed ? 'checkmark-circle' : 'leaf-outline'}
                  size={24}
                  color={p.green}
                />
                <View style={{ flex: 1 }}>
                  <Text style={s.choiceName}>{quest.name}</Text>
                  <Text style={s.muted}>
                    {quest.claimed
                      ? 'Награда получена'
                      : !quest.available
                        ? `После главы «${questProgress(state)[index - 1]?.name}»`
                        : `${quest.progress} / ${quest.target} · ${quest.rewardCoins} монет + ${quest.rewardXp} XP`}
                  </Text>
                </View>
                {!quest.claimed && quest.available && quest.progress >= quest.target && (
                  <Action
                    label="Забрать"
                    disabled={busy}
                    testID={`pick-farm-quest-${quest.id}`}
                    onPress={() => act({ type: 'claimQuest', questId: quest.id })}
                  />
                )}
              </View>
              <Text style={s.muted}>{chapterAdvice[quest.id]}</Text>
              <Meter value={quest.progress} total={quest.target} />
            </View>
          ))}
      </View>
    );
  if (panel === 'garden')
    return (
      <>
        <Text style={[s.text, { marginBottom: 12 }]}>
          Украшения остаются вашими. Их можно переносить пальцем и убирать на склад.
        </Text>
        <ScrollView
          horizontal
          style={{ flexShrink: 0, flexGrow: 0, minHeight: 260 }}
          contentContainerStyle={{ gap: 12, paddingBottom: 12 }}
          showsHorizontalScrollIndicator
        >
          {DECORATIONS.map((item) => (
            <View key={item.id} style={[s.choice, { width: 160, padding: 12 }]}>
              <GardenArt id={item.id} size={88} />
              <Text style={s.choiceName}>{item.name}</Text>
              <Text style={s.muted}>{item.cost} монет</Text>
              <Action
                label={level < item.unlockLevel ? `Уровень ${item.unlockLevel}` : 'Разместить'}
                disabled={busy || level < item.unlockLevel || state.coins < item.cost}
                testID={`pick-farm-decoration-${item.id}`}
                onPress={() => place({ kind: 'decoration', decorationId: item.id })}
              />
            </View>
          ))}
        </ScrollView>
      </>
    );
  if (panel === 'belongings')
    return (
      <View style={{ gap: 12 }}>
        <Text style={s.text}>
          Возвращайте объекты на участок бесплатно. Убранные яблони сохраняют время роста.
        </Text>
        {!progress.storedPlots.length && !progress.decorations.some((d) => d.x === null) && (
          <Text style={s.muted}>
            Пока здесь пусто. Удерживайте объект на поле, чтобы открыть его действия.
          </Text>
        )}
        {progress.storedPlots.map((plot) => (
          <View key={plot.id} style={[s.row, { justifyContent: 'space-between' }]}>
            <Text style={s.choiceName}>
              {plot.kind === 'tree' ? 'Яблоня' : 'Грядка'} {plot.id + 1}
            </Text>
            <Action
              label="На участок"
              disabled={busy}
              onPress={() => place({ kind: 'storedPlot', plotId: plot.id })}
            />
          </View>
        ))}
        {progress.decorations
          .filter((d) => d.x === null)
          .map((d) => (
            <View key={d.id} style={s.row}>
              <GardenArt id={d.decorationId} size={68} />
              <Text style={[s.choiceName, { flex: 1 }]}>
                {DECORATIONS.find((i) => i.id === d.decorationId)?.name}
              </Text>
              <Action
                label="На участок"
                disabled={busy}
                onPress={() => place({ kind: 'storedDecoration', instanceId: d.id })}
              />
            </View>
          ))}
      </View>
    );
  if (panel === 'house')
    return (
      <View style={{ gap: 12 }}>
        <Text style={s.text}>Дом всегда остаётся за участком. Выберите оформление двора.</Text>
        {(
          [
            { id: 'classic', name: 'Классический двор', level: 1 },
            { id: 'mint', name: 'Цветущий двор', level: 6 },
            { id: 'sunshine', name: 'Солнечный двор', level: 8 },
          ] as const
        ).map((item) => (
          <View key={item.id} style={[s.row, { justifyContent: 'space-between' }]}>
            <Text style={s.choiceName}>{item.name}</Text>
            <Action
              label={
                progress.houseStyle === item.id
                  ? 'Выбрано'
                  : level < item.level
                    ? `Уровень ${item.level}`
                    : 'Выбрать'
              }
              disabled={busy || progress.houseStyle === item.id || level < item.level}
              onPress={() => act({ type: 'setHouseStyle', style: item.id })}
            />
          </View>
        ))}
      </View>
    );
  return (
    <View style={{ gap: 18 }}>
      <Text style={s.text}>
        Сохраняйте урожай на склад, чтобы готовить изделия. Производство продолжается после выхода
        из игры.
      </Text>
      {(['kitchen', 'florist'] as const).map((id) => {
        const station = progress.stations.find((v) => v.id === id),
          unlock = id === 'kitchen' ? 4 : 5,
          cost = id === 'kitchen' ? 120 : 150;
        return (
          <View key={id} style={{ gap: 10 }}>
            <View style={s.row}>
              <GardenArt id={id} size={84} />
              <View style={{ flex: 1 }}>
                <Text style={s.panelTitle}>
                  {id === 'kitchen' ? 'Садовая кухня' : 'Цветочная мастерская'}
                </Text>
                <Text style={s.muted}>
                  {station
                    ? `${station.queue.length} / 3 места в очереди`
                    : `${cost} монет · уровень ${unlock}`}
                </Text>
              </View>
              {!station && (
                <Action
                  testID={`pick-farm-station-${id}`}
                  label="Открыть"
                  disabled={busy || level < unlock || state.coins < cost}
                  onPress={() => act({ type: 'buyStation', stationId: id })}
                />
              )}
            </View>
            {station?.queue.map((job) => (
              <View key={job.id} style={[s.row, { paddingVertical: 6 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.choiceName}>
                    {RECIPES.find((r) => r.id === job.recipeId)?.name}
                  </Text>
                  <Text style={s.muted}>
                    {job.readyAt <= now
                      ? 'Готово'
                      : `Ещё ${Math.ceil((job.readyAt - now) / 60000)} мин`}
                  </Text>
                </View>
                <Action
                  testID={`pick-farm-collect-${id}-${job.id}`}
                  label="Забрать"
                  disabled={busy || job.readyAt > now}
                  onPress={() => act({ type: 'collectProduction', stationId: id, jobId: job.id })}
                />
              </View>
            ))}
            <ScrollView
              horizontal
              style={{ flexShrink: 0, flexGrow: 0 }}
              contentContainerStyle={{ gap: 10, paddingBottom: 10 }}
            >
              {RECIPES.filter(
                (r) =>
                  r.stationId === id &&
                  (v3 || !Object.keys(r.requires).some((k) => k === 'egg' || k === 'milk')),
              ).map((recipe) => {
                const needs = Object.entries(recipe.requires) as [ItemId, number][];
                const stock = progress.products[recipe.id] ?? 0;
                return (
                  <View key={recipe.id} style={[s.choice, { width: 210 }]}>
                    <Text style={s.choiceName}>{recipe.name}</Text>
                    <Text style={s.muted}>
                      {Math.ceil(recipe.seconds / 60)} мин · продажа {recipe.sellPrice} монет
                    </Text>
                    {needs.map(([item, n]) => (
                      <Text key={item} style={s.muted}>
                        {itemInfo(item).name}: {itemCount(state, item)} / {n}
                      </Text>
                    ))}
                    <Action
                      testID={`pick-farm-produce-${recipe.id}`}
                      label={
                        level < recipe.unlockLevel ? `Уровень ${recipe.unlockLevel}` : 'Приготовить'
                      }
                      disabled={
                        busy ||
                        !station ||
                        station.queue.length >= 3 ||
                        level < recipe.unlockLevel ||
                        needs.some(([item, n]) => itemCount(state, item) < n)
                      }
                      onPress={() => act({ type: 'startProduction', recipeId: recipe.id })}
                    />
                    {stock > 0 && (
                      <Action
                        testID={`pick-farm-product-${recipe.id}`}
                        label={`Продать ${stock} · ${stock * recipe.sellPrice}`}
                        disabled={busy}
                        onPress={() =>
                          act({
                            type: 'sellProduct',
                            recipeId: recipe.id,
                            quantity: stock,
                          })
                        }
                      />
                    )}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        );
      })}
    </View>
  );
}
