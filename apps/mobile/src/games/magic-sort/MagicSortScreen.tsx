import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '../../components/UI';
import { useReducedMotion } from '../../components/Motion';
import { isSealed, isWon, hasMoves, type Color } from './engine';
import { useMagicSort } from './useMagicSort';
import { POUR_DURATION, POUR_TIMELINE, pouringPose } from './motion';
import { sortColors as c, sortStyles as s } from './styles';
const glass = require('../../../assets/games/magic-sort/bottle-glass.png');
const propsAtlas = require('../../../assets/games/magic-sort/props-atlas.png');
const colorNames: Record<Color, string> = {
  yellow: 'жёлтый',
  ivory: 'белый',
  taupe: 'бежевый',
  orange: 'оранжевый',
  rose: 'розовый',
  wine: 'бордовый',
};
function moves(count: number): string {
  const tens = count % 100,
    ones = count % 10;
  const word =
    tens >= 11 && tens <= 14
      ? 'ходов'
      : ones === 1
        ? 'ход'
        : ones >= 2 && ones <= 4
          ? 'хода'
          : 'ходов';
  return `${count} ${word}`;
}
function Prop({ kind, width, height }: { kind: 'shelf' | 'cork'; width: number; height: number }) {
  const box = kind === 'shelf' ? ([38, 238, 1216, 386] as const) : ([474, 738, 782, 1095] as const);
  const sx = width / (box[2] - box[0]),
    sy = height / (box[3] - box[1]);
  return (
    <View pointerEvents="none" accessible={false} style={{ width, height, overflow: 'hidden' }}>
      <Image
        source={propsAtlas}
        resizeMode="stretch"
        style={{
          position: 'absolute',
          left: -box[0] * sx,
          top: -box[1] * sy,
          width: 1254 * sx,
          height: 1254 * sy,
        }}
      />
    </View>
  );
}
function GlassSlice({
  width,
  height,
  sourceTop,
  sourceBottom,
}: {
  width: number;
  height: number;
  sourceTop: number;
  sourceBottom: number;
}) {
  const scaleY = height / (sourceBottom - sourceTop);
  return (
    <View style={{ width, height, overflow: 'hidden' }}>
      <Image
        source={glass}
        resizeMode="stretch"
        style={{
          position: 'absolute',
          left: (-300 * width) / 492,
          top: -sourceTop * scaleY,
          width: (1101 * width) / 492,
          height: 1428 * scaleY,
          opacity: 0.58,
        }}
      />
    </View>
  );
}
function Bottle({
  colors,
  width,
  height,
  collector = false,
  fluid,
}: {
  colors: readonly Color[];
  width: number;
  height: number;
  collector?: boolean;
  fluid?: {
    progress: Animated.Value;
    before: number;
    after: number;
    role: 'source' | 'target';
    incoming?: Color;
  };
}) {
  const capacity = collector ? 16 : 4;
  const neckHeight = collector ? width * 0.9 : height * 0.22;
  const baseHeight = collector ? width * 0.24 : height * 0.075;
  const bodyHeight = height - neckHeight - baseHeight;
  const sealed = !collector && !fluid && isSealed(colors);
  const fillHeight = fluid
    ? fluid.progress.interpolate({
        inputRange: [...POUR_TIMELINE],
        outputRange: [fluid.before, fluid.before, fluid.after, fluid.after].map(
          (amount) => (amount * bodyHeight) / capacity,
        ),
      })
    : (colors.length * bodyHeight) / capacity;
  const surfaceTop = fluid
    ? fluid.progress.interpolate({
        inputRange: [...POUR_TIMELINE],
        outputRange: [fluid.before, fluid.before, fluid.after, fluid.after].map(
          (amount) =>
            neckHeight + bodyHeight * (1 - amount / capacity) - Math.max(5, width * 0.18) / 2,
        ),
      })
    : neckHeight + bodyHeight * (1 - colors.length / capacity) - Math.max(5, width * 0.18) / 2;
  const flowOpacity = fluid?.progress.interpolate({
    inputRange: [0, 0.22, 0.25, 0.75, 0.78, 1],
    outputRange: [0, 0, 0.8, 0.8, 0, 0],
  });
  const surfaceOpacity = fluid
    ? fluid.progress.interpolate({
        inputRange: [...POUR_TIMELINE],
        outputRange: [fluid.before, fluid.before, fluid.after, fluid.after].map((amount) =>
          amount ? 1 : 0,
        ),
      })
    : 1;
  return (
    <View pointerEvents="none" accessible={false} style={{ width, height, position: 'relative' }}>
      <View
        style={{
          position: 'absolute',
          left: width * 0.075,
          right: width * 0.075,
          top: neckHeight,
          bottom: baseHeight,
          borderRadius: width * 0.19,
          overflow: 'hidden',
          backgroundColor: '#CFEBEB0A',
        }}
      >
        <Animated.View
          testID={fluid ? `magic-sort-${fluid.role}-fill` : undefined}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: fillHeight,
            overflow: 'hidden',
          }}
        >
          {colors.map((color, index) => (
            <View
              key={index}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: (index * bodyHeight) / capacity,
                height: bodyHeight / capacity + 0.5,
                backgroundColor: c[color],
              }}
            />
          ))}
        </Animated.View>
        <View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: width * 0.075,
            width: width * 0.08,
            backgroundColor: '#FFFFFF24',
            borderRadius: 10,
          }}
        />
      </View>
      {fluid?.incoming && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: width / 2 - 1.5,
            top: neckHeight * 0.3,
            width: 3,
            height: fluid.progress.interpolate({
              inputRange: [...POUR_TIMELINE],
              outputRange: [fluid.before, fluid.before, fluid.after, fluid.after].map(
                (amount) => neckHeight * 0.7 + bodyHeight * (1 - amount / capacity),
              ),
            }),
            borderRadius: 2,
            backgroundColor: c[fluid.incoming],
            opacity: flowOpacity,
          }}
        />
      )}
      {!!colors.length && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: width * 0.075,
            right: width * 0.075,
            top: surfaceTop,
            opacity: surfaceOpacity,
            transform: [
              {
                scaleX: fluid
                  ? fluid.progress.interpolate({
                      inputRange: [0, 0.22, 0.34, 0.46, 0.58, 0.7, 0.78, 1],
                      outputRange: [1, 1, 1.06, 0.98, 1.05, 0.98, 1, 1],
                    })
                  : 1,
              },
            ],
            height: Math.max(5, width * 0.18),
            borderRadius: width / 2,
            overflow: 'hidden',
            backgroundColor:
              fluid?.role === 'source' && fluid.after > 0
                ? fluid.progress.interpolate({
                    inputRange: [0, 0.76, 0.78, 1],
                    outputRange: [
                      c[colors[colors.length - 1]!],
                      c[colors[colors.length - 1]!],
                      c[colors[fluid.after - 1]!],
                      c[colors[fluid.after - 1]!],
                    ],
                  })
                : c[colors[colors.length - 1]!],
            borderTopWidth: 1,
            borderTopColor: '#FFFFFF65',
          }}
        >
          <View style={{ position: 'absolute', inset: 0, backgroundColor: '#FFFFFF26' }} />
        </Animated.View>
      )}
      <View style={{ position: 'absolute', inset: 0 }}>
        <GlassSlice width={width} height={neckHeight} sourceTop={14} sourceBottom={330} />
        <GlassSlice width={width} height={bodyHeight} sourceTop={330} sourceBottom={1304} />
        <GlassSlice width={width} height={baseHeight} sourceTop={1304} sourceBottom={1414} />
      </View>
      {sealed && (
        <View style={{ position: 'absolute', left: width * 0.21, top: -height * 0.015 }}>
          <Prop kind="cork" width={width * 0.58} height={height * 0.1} />
        </View>
      )}
      {collector && (
        <View
          style={{
            position: 'absolute',
            top: collector ? width * 0.17 : height * 0.055,
            right: -3,
            width: 12,
            height: 18,
            borderRadius: 3,
            backgroundColor: c.accent,
            transform: [{ rotate: '-18deg' }],
            borderWidth: 2,
            borderColor: '#F9DEA3',
          }}
        />
      )}
    </View>
  );
}
function Control({
  label,
  icon,
  onPress,
  disabled = false,
  testID,
}: {
  label: string;
  icon: IconName;
  onPress(): void;
  disabled?: boolean;
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
      style={({ pressed }) => [s.action, disabled && s.disabled, pressed && s.pressed]}
    >
      <Icon name={icon} size={20} color={c.ink} />
      <Text style={s.actionLabel}>{label}</Text>
    </Pressable>
  );
}
export function MagicSortScreen() {
  const router = useRouter(),
    insets = useSafeAreaInsets(),
    { width, height } = useWindowDimensions();
  const model = useMagicSort(),
    reduced = useReducedMotion();
  const [panel, setPanel] = useState<'help' | 'restart' | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const top = Math.max(insets.top, 12),
    bottom = Math.max(insets.bottom, 12);
  const boardWidth = Math.min(width - 12, 570),
    collectorWidth = boardWidth * 0.105;
  const slot = (boardWidth - collectorWidth - 12) / 6;
  const pourClearance = width <= 340 ? 20 : 0;
  const rowHeight = Math.max(56, Math.min(154, (height - top - bottom - 158 - pourClearance) / 4));
  const boardHeight = rowHeight * 4,
    bottleWidth = slot * 0.8,
    bottleHeight = rowHeight - 17;
  const position = (index: number) => {
    if (index === 24) return { x: boardWidth / 2 - collectorWidth / 2, y: 0 };
    const row = Math.floor(index / 6),
      col = index % 6;
    return {
      x:
        (col < 3 ? col * slot : 3 * slot + collectorWidth + 12 + (col - 3) * slot) +
        (slot - bottleWidth) / 2,
      y: row * rowHeight + 4,
    };
  };
  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(0);
    if (!model.pending) return;
    const pending = model.pending;
    if (reduced) {
      model.finishPour(pending);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: POUR_DURATION,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished) model.finishPour(pending);
    });
    return () => animation.stop();
  }, [model.pending, model.finishPour, reduced, progress]);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (panel) {
        setPanel(null);
        return true;
      }
      if (!model.paused) {
        model.pause();
        return true;
      }
      return false;
    });
    return () => back.remove();
  }, [panel, model.paused, model.pause]);
  const source = model.pending ? position(model.pending.move.from) : null;
  const target = model.pending ? position(model.pending.move.to) : null;
  const targetWidth = model.pending?.move.to === 24 ? collectorWidth : bottleWidth;
  const direction: 1 | -1 = source && target && source.x < target.x ? 1 : -1;
  const landingX = target ? target.x + targetWidth / 2 : 0;
  const landingY = target
    ? target.y + (model.pending?.move.to === 24 ? collectorWidth * 0.025 : 6 + bottleHeight * 0.025)
    : 0;
  const pose = pouringPose(bottleWidth, bottleHeight, landingX, landingY, direction);
  const won = model.game ? isWon(model.game) : false;
  return (
    <View testID="magic-sort-screen" style={[s.screen, { paddingTop: top, paddingBottom: bottom }]}>
      <View style={s.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Выйти из Magic Sort"
          onPress={() => {
            model.pause();
            router.back();
          }}
          style={({ pressed }) => [s.iconButton, pressed && s.pressed]}
        >
          <Icon name="arrow-back" color={c.ink} />
        </Pressable>
        <View style={{ alignItems: 'center' }}>
          <Text style={s.title}>MAGIC SORT</Text>
          <View style={s.stats}>
            <Text testID="magic-sort-moves" style={s.caption}>
              Ходы: {model.game?.history.length ?? 0}
            </Text>
            <Text testID="magic-sort-record" style={s.caption}>
              Рекорд: {model.record ?? '-'}
            </Text>
          </View>
        </View>
        <Pressable
          testID="magic-sort-help"
          accessibilityRole="button"
          accessibilityLabel="Как играть"
          disabled={!!model.pending}
          onPress={() => setPanel('help')}
          style={({ pressed }) => [s.iconButton, pressed && s.pressed]}
        >
          <Icon name="help-circle-outline" color={c.ink} />
        </Pressable>
      </View>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: boardHeight + pourClearance,
          paddingTop: pourClearance,
        }}
      >
        {!model.game ? (
          <ActivityIndicator color={c.accent} />
        ) : (
          <View testID="magic-sort-board" style={{ width: boardWidth, height: boardHeight }}>
            {Array.from({ length: 4 }, (_, row) => (
              <View
                key={row}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: (row + 1) * rowHeight - 13,
                  left: 0,
                  right: 0,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                }}
              >
                <Prop kind="shelf" width={slot * 3} height={20} />
                <Prop kind="shelf" width={slot * 3} height={20} />
              </View>
            ))}
            {model.game.bottles.map((colors, index) => {
              const pos = position(index),
                selected = model.selected === index;
              return (
                <Pressable
                  key={index}
                  testID={`magic-sort-bottle-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Бутылка ${index + 1}: ${colors.length ? colors.map((color) => colorNames[color]).join(', ') : 'пустая'}${isSealed(colors) ? ', закрыта' : ''}`}
                  accessibilityState={{
                    selected,
                    disabled: !!model.pending || model.paused || isSealed(colors),
                  }}
                  disabled={!!model.pending || model.paused || isSealed(colors)}
                  onPress={() => model.select(index)}
                  style={({ pressed }) => [
                    {
                      position: 'absolute',
                      left: pos.x - (slot - bottleWidth) / 2,
                      top: pos.y - 4,
                      width: slot,
                      height: rowHeight - 7,
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      borderRadius: 12,
                      opacity: model.pending?.move.from === index ? 0 : pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <View
                    pointerEvents="none"
                    style={{ transform: [{ translateY: selected ? -7 : 0 }] }}
                  >
                    <Bottle
                      colors={
                        model.pending?.move.to === index
                          ? (model.pending.next.bottles[index] ?? colors)
                          : colors
                      }
                      width={bottleWidth}
                      height={bottleHeight}
                      fluid={
                        model.pending?.move.to === index
                          ? {
                              progress,
                              before: colors.length,
                              after: model.pending.next.bottles[index]?.length ?? colors.length,
                              role: 'target',
                              incoming: model.pending.color,
                            }
                          : undefined
                      }
                    />
                  </View>
                </Pressable>
              );
            })}
            <Pressable
              testID="magic-sort-collector"
              accessibilityRole="button"
              accessibilityLabel={`Жёлтый коллектор: ${model.game.collector.length} из 16`}
              accessibilityState={{ disabled: !!model.pending || model.paused }}
              disabled={!!model.pending || model.paused}
              onPress={() => model.select(24)}
              hitSlop={{ left: 6, right: 6 }}
              style={({ pressed }) => [
                {
                  position: 'absolute',
                  left: boardWidth / 2 - collectorWidth / 2,
                  top: 0,
                  width: collectorWidth,
                  height: boardHeight - 12,
                  opacity: pressed ? 0.75 : 1,
                },
              ]}
            >
              <Bottle
                colors={
                  model.pending?.move.to === 24
                    ? model.pending.next.collector
                    : model.game.collector
                }
                fluid={
                  model.pending?.move.to === 24
                    ? {
                        progress,
                        before: model.game.collector.length,
                        after: model.pending.next.collector.length,
                        role: 'target',
                        incoming: model.pending.color,
                      }
                    : undefined
                }
                collector
                width={collectorWidth}
                height={boardHeight - 12}
              />
            </Pressable>
            {model.pending && source && target && (
              <>
                <Animated.View
                  pointerEvents="none"
                  testID="magic-sort-pour"
                  style={{
                    position: 'absolute',
                    zIndex: 8,
                    width: bottleWidth,
                    height: bottleHeight,
                    transform: [
                      {
                        translateX: progress.interpolate({
                          inputRange: [...POUR_TIMELINE],
                          outputRange: [source.x, pose.x, pose.x, source.x],
                        }),
                      },
                      {
                        translateY: progress.interpolate({
                          inputRange: [...POUR_TIMELINE],
                          outputRange: [source.y - 1, pose.y, pose.y, source.y + 6],
                        }),
                      },
                      {
                        rotate: progress.interpolate({
                          inputRange: [...POUR_TIMELINE],
                          outputRange: ['0deg', `${pose.angle}deg`, `${pose.angle}deg`, '0deg'],
                        }),
                      },
                    ],
                  }}
                >
                  <Bottle
                    colors={model.game.bottles[model.pending.move.from] ?? []}
                    fluid={{
                      progress,
                      before: model.game.bottles[model.pending.move.from]?.length ?? 0,
                      after: model.pending.next.bottles[model.pending.move.from]?.length ?? 0,
                      role: 'source',
                    }}
                    width={bottleWidth}
                    height={bottleHeight}
                  />
                </Animated.View>
                <Animated.View
                  pointerEvents="none"
                  testID="magic-sort-stream"
                  style={{
                    position: 'absolute',
                    zIndex: 9,
                    left: pose.mouthX - 2,
                    top: pose.mouthY,
                    width: 4,
                    height: pose.streamLength,
                    borderRadius: 3,
                    backgroundColor: c[model.pending.color],
                    transformOrigin: 'center top',
                    transform: [
                      { rotate: `${pose.streamAngle}deg` },
                      {
                        scaleX: progress.interpolate({
                          inputRange: [0, 0.22, 0.35, 0.48, 0.61, 0.74, 0.78, 1],
                          outputRange: [0.4, 0.4, 1, 0.8, 1, 0.9, 0.4, 0.4],
                        }),
                      },
                    ],
                    opacity: progress.interpolate({
                      inputRange: [0, 0.22, 0.25, 0.75, 0.78, 1],
                      outputRange: [0, 0, 1, 1, 0, 0],
                    }),
                  }}
                >
                  <View
                    testID="magic-sort-source-mouth"
                    style={{ position: 'absolute', top: -1, left: 1, width: 2, height: 2 }}
                  />
                  <View
                    testID="magic-sort-target-mouth"
                    style={{ position: 'absolute', bottom: -1, left: 1, width: 2, height: 2 }}
                  />
                  <Animated.View
                    style={{
                      position: 'absolute',
                      left: 0.5,
                      width: 1,
                      height: 4,
                      borderRadius: 1,
                      backgroundColor: '#FFFFFF85',
                      transform: [
                        {
                          translateY: progress.interpolate({
                            inputRange: [0, 0.22, 0.34, 0.35, 0.47, 0.48, 0.6, 0.61, 0.73, 0.78, 1],
                            outputRange: [
                              0,
                              0,
                              pose.streamLength - 4,
                              0,
                              pose.streamLength - 4,
                              0,
                              pose.streamLength - 4,
                              0,
                              pose.streamLength - 4,
                              0,
                              0,
                            ],
                          }),
                        },
                      ],
                    }}
                  />
                </Animated.View>
              </>
            )}
          </View>
        )}
      </View>
      <View style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 18 }}>
        <Text testID="magic-sort-notice" accessibilityLiveRegion="polite" style={s.notice}>
          {model.saveError ? 'Прогресс пока не сохранён. Повторите сохранение.' : model.notice}
        </Text>
      </View>
      {model.saveError ? (
        <View style={s.dock}>
          <Control label="Сохранить снова" icon="refresh" onPress={model.retrySave} />
        </View>
      ) : (
        <View style={s.dock}>
          <Control
            label="Отменить"
            icon="arrow-undo"
            testID="magic-sort-undo"
            disabled={!model.game?.history.length || !!model.pending || model.paused}
            onPress={model.undo}
          />
          <Control
            label="Заново"
            icon="refresh"
            testID="magic-sort-restart"
            disabled={!!model.pending || !model.game}
            onPress={() => setPanel('restart')}
          />
          <Control label="Пауза" icon="pause" testID="magic-sort-pause" onPress={model.pause} />
        </View>
      )}
      {(panel ||
        model.paused ||
        won ||
        (model.game && !hasMoves(model.game) && !model.pending)) && (
        <View testID={won ? 'magic-sort-won' : 'magic-sort-overlay'} style={s.overlay}>
          <View style={s.panel}>
            <Text style={s.panelTitle}>
              {panel === 'help'
                ? 'Как играть'
                : panel === 'restart'
                  ? 'Начать заново?'
                  : won
                    ? 'Все цвета на месте'
                    : model.paused
                      ? 'Пауза'
                      : 'Нет доступных ходов'}
            </Text>
            <Text style={s.body}>
              {panel === 'help'
                ? 'Отсортируйте все цвета за наименьшее число ходов. Выберите бутылку и затем другую с таким же верхним цветом или пустую. Переливается весь верхний слой, если хватает места. Жёлтый собирайте в длинной бутылке по центру; остальные цвета - в отдельных полных бутылках. Готовые бутылки закрываются пробкой. Каждое переливание - один ход, отмена убирает ход. Раскладка одна для всех, лучший результат сохраняется как ваш рекорд на этом устройстве для вашего аккаунта. Монеты и награды не начисляются.'
                : panel === 'restart'
                  ? 'Раскладка начнётся с начала, счётчик ходов обнулится. Ваш рекорд сохранится.'
                  : won
                    ? `Отсортировано за ${moves(model.game?.history.length ?? 0)}.`
                    : model.paused
                      ? 'Переливание остановлено. Продолжите, когда будете готовы.'
                      : 'Отмените последний ход или начните уровень заново.'}
            </Text>
            {won && !panel && (
              <View style={s.resultRow}>
                <Text testID="magic-sort-best" style={s.resultLabel}>
                  Ваш рекорд: {model.result ? moves(model.result.best) : '-'}
                </Text>
                {model.result?.isNew && (
                  <View testID="magic-sort-new-record" style={s.badge}>
                    <Text style={s.badgeLabel}>Новый рекорд!</Text>
                  </View>
                )}
              </View>
            )}
            {panel ? (
              <>
                <Pressable
                  style={s.panelButton}
                  onPress={() => {
                    if (panel === 'restart') model.restart();
                    setPanel(null);
                  }}
                  testID="magic-sort-panel-confirm"
                  accessibilityRole="button"
                >
                  <Text style={s.panelButtonLabel}>
                    {panel === 'restart' ? 'Начать заново' : 'Понятно'}
                  </Text>
                </Pressable>
                {panel === 'restart' && (
                  <Pressable
                    accessibilityRole="button"
                    style={s.panelButton}
                    onPress={() => setPanel(null)}
                  >
                    <Text style={s.panelButtonLabel}>Продолжить игру</Text>
                  </Pressable>
                )}
              </>
            ) : (
              <Pressable
                accessibilityRole="button"
                testID="magic-sort-resume"
                style={[s.panelButton, won && s.primaryButton]}
                onPress={won ? model.restart : model.paused ? model.resume : model.undo}
              >
                <Text style={s.panelButtonLabel}>
                  {won ? 'Сыграть снова' : model.paused ? 'Продолжить' : 'Отменить ход'}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
}
