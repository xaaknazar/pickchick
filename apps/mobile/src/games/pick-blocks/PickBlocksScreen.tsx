import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  AccessibilityInfo,
  BackHandler,
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, Logo, type IconName } from '../../components/UI';
import { colors, font } from '../../theme';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  cells,
  ghostPiece,
  gravityIntervalMs,
  type GameState,
  type PieceKind,
} from './engine';
import { usePickBlocks } from './usePickBlocks';
import { blockDrag, blockDragAxis, isBlockDrop, type BlockDragAxis } from './gestures';
import { Tile } from './visuals';
import { assets } from '../../assets';
import { ArcadeButton, ArcadeBackdrop, ArcadeIntro, arcade } from '../ArcadeExperience';

function useGentleMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}
const number = (value: number) => value.toLocaleString('ru-RU');
const lineLabel = (count: number) =>
  count % 10 === 1 && count % 100 !== 11
    ? 'ряд'
    : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)
      ? 'ряда'
      : 'рядов';

function SolidButton({
  title,
  onPress,
  secondary = false,
  testID,
}: {
  title: string;
  onPress(): void;
  secondary?: boolean;
  testID?: string;
}) {
  return <ArcadeButton title={title} onPress={onPress} secondary={secondary} testID={testID} />;
}

function Stats({ game, best }: { game: GameState; best: number }) {
  return (
    <View style={s.stats}>
      <View style={s.stat}>
        <Text style={s.eyebrow}>СЧЁТ</Text>
        <Text
          testID="blocks-score"
          accessibilityLabel={`Счёт ${game.score}`}
          adjustsFontSizeToFit
          numberOfLines={1}
          style={s.score}
        >
          {number(game.score)}
        </Text>
      </View>
      <View style={[s.stat, { alignItems: 'flex-end' }]}>
        <View style={s.bestLabel}>
          <Icon name="trophy-outline" size={12} color="#EFC080" />
          <Text style={s.eyebrow}>РЕКОРД</Text>
        </View>
        <Text testID="blocks-best" adjustsFontSizeToFit numberOfLines={1} style={s.best}>
          {number(Math.max(best, game.score))}
        </Text>
      </View>
    </View>
  );
}
function NextPiece({ kind, small = false }: { kind: PieceKind | undefined; small?: boolean }) {
  if (!kind) return null;
  const shape = cells({ kind, rotation: 0, x: 0, y: 0 });
  const left = Math.min(...shape.map((p) => p.x)),
    top = Math.min(...shape.map((p) => p.y));
  const width = Math.max(...shape.map((p) => p.x)) - left + 1,
    height = Math.max(...shape.map((p) => p.y)) - top + 1;
  const size = small ? 12 : 15;
  return (
    <View style={{ width: width * size, height: height * size }} pointerEvents="none">
      {shape.map((p, i) => (
        <Tile key={i} x={p.x - left} y={p.y - top} kind={kind} size={size} />
      ))}
    </View>
  );
}
function SideRail({ game, compact }: { game: GameState; compact: boolean }) {
  return (
    <View style={[s.rail, compact && { width: 68, gap: 8 }]}>
      <View
        style={[s.nextBox, compact && { paddingVertical: 8 }]}
        testID="blocks-next"
        accessibilityLabel="Следующие фигуры"
      >
        <Text maxFontSizeMultiplier={1.3} style={s.railLabel}>
          ДАЛЬШЕ
        </Text>
        <View style={[s.nextShape, compact && { minHeight: 24, marginTop: 8 }]}>
          <NextPiece kind={game.next[0]} small={compact} />
        </View>
        {!compact ? (
          <View style={{ opacity: 0.5, marginTop: 8 }}>
            <NextPiece kind={game.next[1]} small />
          </View>
        ) : null}
      </View>
      <View style={s.railStat}>
        <Text maxFontSizeMultiplier={1.3} style={s.railLabel}>
          УРОВЕНЬ
        </Text>
        <Text maxFontSizeMultiplier={1.3} style={s.railNumber}>
          {game.level}
        </Text>
      </View>
      <View style={s.railStat}>
        <Text maxFontSizeMultiplier={1.3} style={s.railLabel}>
          РЯДЫ
        </Text>
        <Text testID="blocks-lines" maxFontSizeMultiplier={1.3} style={s.railNumber}>
          {game.lines}
        </Text>
        <View style={s.levelTrack}>
          <View style={[s.levelFill, { width: `${(game.lines % 10) * 10}%` }]} />
        </View>
      </View>
      {!compact ? (
        <View style={s.railTip}>
          <Icon name="sparkles-outline" size={21} color="#FFD09E" />
          <Text style={s.tipText}>
            Больше рядов{`\n`}за раз -{`\n`}больше очков
          </Text>
        </View>
      ) : null}
    </View>
  );
}
/** Native-driver interpolation fills the time between deterministic gravity steps. */
function FallingPiece({
  game,
  cell,
  playing,
  reduced,
}: {
  game: GameState;
  cell: number;
  playing: boolean;
  reduced: boolean;
}) {
  const piece = game.active;
  const position = useRef(
    new Animated.ValueXY({ x: (piece?.x ?? 0) * cell, y: (piece?.y ?? 0) * cell }),
  ).current;
  const previous = useRef({ id: game.piecesPlaced, cell, score: game.score });
  useLayoutEffect(() => {
    if (!piece) return;
    const interval = gravityIntervalMs(game.level);
    const canFall = (ghostPiece(game)?.y ?? piece.y) > piece.y;
    const progress = canFall ? game.gravityMs / interval : 0;
    const currentY = (piece.y + progress) * cell;
    const fresh = previous.current.id !== game.piecesPlaced || previous.current.cell !== cell;
    const softFall = !fresh && game.score > previous.current.score;
    previous.current = { id: game.piecesPlaced, cell, score: game.score };
    position.stopAnimation();
    if (fresh || reduced || !playing) position.setValue({ x: piece.x * cell, y: currentY });
    else if (!softFall) position.y.setValue(currentY);
    if (!playing || reduced) return;
    // Horizontal positions and rotations are committed together by the engine.
    // Tweening an old origin with a new shape can cross a wall or a settled tile.
    const fall = Animated.timing(position.y, {
      toValue: canFall && playing && !reduced ? (piece.y + 1) * cell : currentY,
      duration: canFall && playing && !reduced ? Math.max(1, interval - game.gravityMs) : 0,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    const vertical = softFall
      ? Animated.sequence([
          Animated.timing(position.y, {
            toValue: currentY,
            duration: 65,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          fall,
        ])
      : fall;
    const animation = vertical;
    animation.start();
    return () => animation.stop();
  }, [
    piece,
    game.piecesPlaced,
    game.level,
    game.gravityMs,
    game.score,
    game.board,
    cell,
    playing,
    reduced,
    position,
  ]);
  if (!piece) return null;
  return (
    <Animated.View
      testID="blocks-falling-piece"
      style={{ position: 'absolute', left: 0, top: 0, transform: position.getTranslateTransform() }}
    >
      {cells(piece).map((point, i) => (
        <Tile key={i} x={point.x - piece.x} y={point.y - piece.y} size={cell} kind={piece.kind} />
      ))}
    </Animated.View>
  );
}
function Board({
  game,
  cell,
  controller,
  reduced,
}: {
  game: GameState;
  cell: number;
  controller: ReturnType<typeof usePickBlocks>;
  reduced: boolean;
}) {
  const glow = useRef(new Animated.Value(0)).current;
  const live = useRef({ controller, cell });
  live.current = { controller, cell };
  const drag = useRef({
    x: 0,
    y: 0,
    moved: false,
    cancelled: false,
    started: 0,
    piece: -1,
    axis: null as BlockDragAxis,
  });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.controller.status === 'playing',
      onMoveShouldSetPanResponder: () => live.current.controller.status === 'playing',
      onPanResponderGrant: () => {
        drag.current = {
          x: 0,
          y: 0,
          moved: false,
          cancelled: false,
          started: Date.now(),
          piece: live.current.controller.game?.piecesPlaced ?? -1,
          axis: null,
        };
      },
      onPanResponderStart: (_, gesture) => {
        if (gesture.numberActiveTouches > 1) drag.current.cancelled = true;
      },
      onPanResponderMove: (_, gesture) => {
        if (gesture.numberActiveTouches > 1) drag.current.cancelled = true;
        if (
          live.current.controller.status !== 'playing' ||
          drag.current.cancelled ||
          drag.current.piece !== live.current.controller.game?.piecesPlaced
        )
          return;
        if (Math.abs(gesture.dx) > 8 || Math.abs(gesture.dy) > 8) drag.current.moved = true;
        drag.current.axis = blockDragAxis(gesture.dx, gesture.dy, drag.current.axis);
        const displacement = blockDrag(
          gesture.dx,
          gesture.dy,
          live.current.cell,
          drag.current.axis,
        );
        const x = drag.current.axis === 'horizontal' ? displacement.x : drag.current.x;
        const y = Math.max(drag.current.y, displacement.y);
        const delta = x - drag.current.x;
        for (let i = 0; i < Math.min(BOARD_WIDTH, Math.abs(delta)); i++)
          live.current.controller.move(delta < 0 ? -1 : 1, drag.current.piece);
        for (let i = drag.current.y; i < Math.min(y, drag.current.y + BOARD_HEIGHT); i++)
          live.current.controller.softDrop(drag.current.piece);
        drag.current.x = x;
        drag.current.y = y;
      },
      onPanResponderRelease: (_, gesture) => {
        if (
          live.current.controller.status !== 'playing' ||
          drag.current.cancelled ||
          drag.current.piece !== live.current.controller.game?.piecesPlaced
        )
          return;
        if (!drag.current.moved) live.current.controller.rotate(drag.current.piece);
        else if (
          drag.current.axis === 'vertical' &&
          isBlockDrop(gesture.dx, gesture.dy, live.current.cell, Date.now() - drag.current.started)
        )
          live.current.controller.hardDrop(drag.current.piece);
      },
      onPanResponderTerminate: () => {
        drag.current.cancelled = true;
      },
      onPanResponderTerminationRequest: () => true,
      onShouldBlockNativeResponder: () => true,
    }),
  ).current;
  const clearId = game.lastClear?.id;
  useEffect(() => {
    if (!game.lastClear?.count) return;
    AccessibilityInfo.announceForAccessibility(
      `${game.lastClear.count} ${lineLabel(game.lastClear.count)}!`,
    );
    if (reduced) return;
    glow.setValue(1);
    const effect = Animated.timing(glow, { toValue: 0, duration: 420, useNativeDriver: true });
    effect.start();
    return () => effect.stop();
  }, [clearId, reduced, glow]); // The engine increments the event id once per clear.
  const ghost = ghostPiece(game);
  const danger = game.board.slice(0, 5).some((row) => row.some(Boolean));
  return (
    <View
      testID="blocks-board"
      {...pan.panHandlers}
      style={[
        s.board,
        danger && { borderColor: '#F4A37C' },
        {
          width: BOARD_WIDTH * cell + 2,
          height: BOARD_HEIGHT * cell + 2,
          ...(Platform.OS === 'web' ? { touchAction: 'none' } : {}),
        },
      ]}
      accessible
      accessibilityLabel="Игровое поле. Касание - поворот, свайп - движение, вниз - ускорение, быстрый свайп вниз - сброс"
      accessibilityActions={[
        { name: 'left', label: 'Сдвинуть влево' },
        { name: 'right', label: 'Сдвинуть вправо' },
        { name: 'rotate', label: 'Повернуть фигуру' },
        { name: 'down', label: 'Опустить на клетку' },
        { name: 'drop', label: 'Сбросить фигуру' },
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (controller.status !== 'playing') return;
        const actions: Record<string, () => void> = {
          left: () => controller.move(-1),
          right: () => controller.move(1),
          rotate: controller.rotate,
          down: controller.softDrop,
          drop: controller.hardDrop,
        };
        actions[nativeEvent.actionName]?.();
      }}
    >
      <View
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {Array.from({ length: BOARD_WIDTH - 1 }, (_, i) => (
          <View
            key={`v${i}`}
            style={[
              s.gridLine,
              { left: (i + 1) * cell, top: 0, bottom: 0, width: StyleSheet.hairlineWidth },
            ]}
          />
        ))}
        {Array.from({ length: BOARD_HEIGHT - 1 }, (_, i) => (
          <View
            key={`h${i}`}
            style={[
              s.gridLine,
              { top: (i + 1) * cell, left: 0, right: 0, height: StyleSheet.hairlineWidth },
            ]}
          />
        ))}
        <View style={{ position: 'absolute', top: cell * 7, left: cell * 2.5, opacity: 0.075 }}>
          <Logo size={cell * 5} />
        </View>
        {game.board.flatMap((row, y) =>
          row.map((kind, x) =>
            kind ? <Tile key={`${x}-${y}`} x={x} y={y} size={cell} kind={kind} /> : null,
          ),
        )}
        {ghost && game.active
          ? cells(ghost)
              .filter((p, i, all) => all.findIndex((q) => q.x === p.x) === i)
              .map((p, i) => (
                <View
                  key={`lane${i}`}
                  style={{
                    position: 'absolute',
                    left: p.x * cell,
                    top: Math.max(0, game.active!.y + 2) * cell,
                    width: cell,
                    height: Math.max(0, ghost.y - game.active!.y - 1) * cell,
                    backgroundColor: '#8BADFF08',
                  }}
                />
              ))
          : null}
        {ghost
          ? cells(ghost)
              .filter((p) => p.y >= 0)
              .map((p, i) => <Tile key={`g${i}`} {...p} size={cell} kind={ghost.kind} ghost />)
          : null}
        <FallingPiece
          key={`${game.piecesPlaced}:${game.active?.rotation}:${game.active?.x}:${cell}`}
          game={game}
          cell={cell}
          playing={controller.status === 'playing'}
          reduced={reduced}
        />
        {!reduced && game.lastClear
          ? game.lastClear.rows.map((y) => (
              <Animated.View
                key={`clear${y}`}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: y * cell,
                  height: cell,
                  backgroundColor: '#FFE2B7',
                  opacity: glow,
                }}
              />
            ))
          : null}
        {!reduced && game.lastClear ? (
          <Animated.View
            style={{
              position: 'absolute',
              top: '39%',
              left: 0,
              right: 0,
              alignItems: 'center',
              opacity: glow,
            }}
          >
            <View
              style={{
                backgroundColor: '#FFBB83',
                borderRadius: 16,
                paddingHorizontal: 15,
                paddingVertical: 10,
              }}
            >
              <Text
                style={{
                  fontFamily: font.display,
                  color: colors.orangeInk,
                  fontSize: Math.min(20, cell),
                  lineHeight: 26,
                }}
              >
                {game.lastClear.count === 4
                  ? 'ИДЕАЛЬНО! 4 РЯДА'
                  : `${game.lastClear.count} ${lineLabel(game.lastClear.count).toUpperCase()}!`}
              </Text>
            </View>
          </Animated.View>
        ) : null}
      </View>
    </View>
  );
}

export function PickBlocksScreen() {
  const controller = usePickBlocks();
  const { game, status, best } = controller;
  const router = useRouter(),
    safe = useSafeAreaInsets();
  const { width, height } = useWindowDimensions(),
    reduced = useGentleMotion();
  const wide = width > height;
  const [region, setRegion] = useState(() => ({
    width: wide ? Math.max(100, width - 340) : width - (width < 350 ? 24 : 36),
    height: Math.max(100, height - safe.top - safe.bottom - (wide ? 80 : 225)),
  }));
  const [help, setHelp] = useState(false),
    [restart, setRestart] = useState(false);
  const oldOrientation = useRef(wide);
  useEffect(() => {
    if (oldOrientation.current !== wide) {
      oldOrientation.current = wide;
      controller.pause();
    }
  }, [wide, controller.pause]);
  useFocusEffect(
    useCallback(() => {
      const back = BackHandler.addEventListener('hardwareBackPress', () => {
        if (status !== 'playing') return false;
        controller.pause();
        return true;
      });
      return () => back.remove();
    }, [status, controller.pause]),
  );
  const exit = () => {
    controller.pause();
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/events');
  };
  const openHelp = () => {
    controller.pause();
    setHelp(true);
  };
  const compact = height < 700 || region.height < 350;
  const railWidth = compact ? 68 : 78;
  const cell = Math.max(
    1,
    Math.floor(
      Math.min((region.width - railWidth - 14) / BOARD_WIDTH, (region.height - 2) / BOARD_HEIGHT),
    ),
  );
  const tooSmall = cell < 10 || region.height < 220;
  useEffect(() => {
    if (tooSmall && status === 'playing') controller.pause();
  }, [tooSmall, status, controller.pause]);
  const showOverlay = help || restart || status === 'paused' || status === 'over';
  const closeOverlay = () => {
    if (help) setHelp(false);
    else if (restart) setRestart(false);
    else exit();
  };
  const start = () => {
    setRestart(false);
    controller.start();
  };
  return (
    <View
      testID="pick-blocks-screen"
      style={[
        s.page,
        {
          paddingTop: Math.max(safe.top, 8),
          paddingBottom: Math.max(safe.bottom, 10),
          paddingHorizontal: width < 350 ? 12 : 18,
        },
      ]}
    >
      <ArcadeBackdrop />
      <View style={s.header}>
        <Pressable
          testID="blocks-exit"
          accessibilityRole="button"
          accessibilityLabel="Вернуться назад"
          onPress={exit}
          style={s.iconButton}
        >
          <Icon name="chevron-back" color="#DFE9FF" size={25} />
        </Pressable>
        <View style={s.headerBrand}>
          <Logo size={28} />
          <Text maxFontSizeMultiplier={1.3} style={s.headerTitle}>
            PICK BLOCKS
          </Text>
        </View>
        <Pressable
          testID="blocks-help"
          accessibilityRole="button"
          accessibilityLabel="Как играть"
          onPress={openHelp}
          style={s.iconButton}
        >
          <Icon name="help-circle-outline" color="#BBD0F5" size={24} />
        </Pressable>
        {status !== 'ready' && status !== 'loading' ? (
          <Pressable
            testID="blocks-pause"
            accessibilityRole="button"
            accessibilityLabel="Пауза"
            onPress={controller.pause}
            style={s.iconButton}
          >
            <Icon name="pause" size={23} color="#F5F7FF" />
          </Pressable>
        ) : null}
      </View>
      {status === 'loading' ? (
        <View style={s.loading}>
          <ActivityIndicator color={colors.accent} />
          <Text style={s.body}>Собираем игровое поле…</Text>
        </View>
      ) : status === 'ready' ? (
        <ArcadeIntro
          cover={assets.pickBlocksCover}
          title="Всё сложится."
          subtitle="Найди идеальное место. Собери ряд. Поймай свой ритм."
          best={best}
          onStart={start}
          testID="blocks-start"
          steps={[
            ['swap-horizontal-outline', 'Веди пальцем', 'Свайп в сторону перемещает фигуру.'],
            ['refresh', 'Коснись - поверни', 'Светлый контур покажет место посадки.'],
            [
              'arrow-down',
              'Собери красивую комбинацию',
              'Вниз - ускорение. Быстрый свайп - сброс.',
            ],
          ]}
        >
          <Pressable onPress={openHelp} accessibilityRole="button" style={s.helpLink}>
            <Text style={s.helpLinkText}>Правила и управление</Text>
          </Pressable>
        </ArcadeIntro>
      ) : game ? (
        <View style={[s.playArea, wide && s.playAreaWide]}>
          {!wide ? <Stats game={game} best={best} /> : null}
          <View
            testID="blocks-stage"
            style={s.stage}
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              setRegion({ width, height });
            }}
          >
            {!tooSmall ? (
              <>
                <Board game={game} cell={cell} controller={controller} reduced={reduced} />
                <SideRail game={game} compact={compact} />
              </>
            ) : (
              <Text style={s.body}>Поверни телефон, чтобы открыть поле</Text>
            )}
          </View>
          <View style={wide ? s.wideControls : s.portraitControls}>
            {wide ? <Stats game={game} best={best} /> : null}
            <View style={s.controlHint}>
              <View style={s.hintLine} />
              <Text style={s.hintText}>ДО СЛЕДУЮЩЕГО УРОВНЯ: {10 - (game.lines % 10)}</Text>
              <View style={s.hintLine} />
            </View>
            <Text testID="blocks-gesture-hint" style={s.gestureHint}>
              Свайп - двигать · касание - поворот{`\n`}Вниз - ускорить · быстрый свайп вниз - сброс
            </Text>
          </View>
        </View>
      ) : null}
      {controller.storageError ? (
        <Pressable
          style={s.storageNotice}
          onPress={controller.retryStorage}
          accessibilityRole="button"
        >
          <Icon name="alert-circle-outline" size={17} color="#FFD2AE" />
          <Text style={s.storageText}>Игра пока не сохранилась. Повторить</Text>
        </Pressable>
      ) : null}
      <Modal
        visible={showOverlay}
        transparent
        animationType={reduced ? 'none' : 'fade'}
        onRequestClose={closeOverlay}
      >
        <View
          style={[
            s.modalShade,
            { paddingTop: Math.max(safe.top, 16), paddingBottom: Math.max(safe.bottom, 16) },
          ]}
        >
          <ScrollView contentContainerStyle={s.modalScroll} showsVerticalScrollIndicator={false}>
            <View style={s.modalCard} accessibilityViewIsModal>
              <View style={s.modalSymbol}>
                <Icon
                  name={
                    help
                      ? 'bulb-outline'
                      : restart
                        ? 'refresh'
                        : status === 'over'
                          ? 'trophy-outline'
                          : 'pause'
                  }
                  size={30}
                  color="#FFBB85"
                />
              </View>
              <Text style={s.modalTitle}>
                {help
                  ? 'Лови ритм.'
                  : restart
                    ? 'Начать заново?'
                    : status === 'over'
                      ? 'Вот это сборка!'
                      : 'Выдохни.'}
              </Text>
              <Text style={s.modalText}>
                {help
                  ? 'У каждой фигуры есть своё место.'
                  : restart
                    ? 'Текущая партия начнётся с нуля. Личный рекорд останется.'
                    : status === 'over'
                      ? 'Места больше нет. А новый пик - впереди.'
                      : tooSmall
                        ? 'Поверни телефон: полю нужно чуть больше места.'
                        : 'Игра на паузе. Продолжим с того же места.'}
              </Text>
              {controller.storageError ? (
                <Text style={s.storageText}>
                  Партия пока не сохранилась на телефоне. Можно продолжить игру или повторить
                  сохранение.
                </Text>
              ) : null}
              {help ? (
                <>
                  <View style={s.rules}>
                    {(
                      [
                        [
                          'swap-horizontal-outline',
                          'Двигай',
                          'Веди пальцем по полю влево или вправо.',
                        ],
                        ['refresh', 'Поворачивай', 'Коротко коснись поля, чтобы повернуть фигуру.'],
                        [
                          'arrow-down',
                          'Ускоряй',
                          'Веди пальцем вниз для ускорения. Быстрый свайп вниз сразу уложит фигуру на контур.',
                        ],
                        [
                          'sparkles-outline',
                          'Собирай ряды',
                          'Заполненный ряд исчезает. Несколько рядов за раз дают больше очков.',
                        ],
                      ] as [IconName, string, string][]
                    ).map(([icon, title, copy]) => (
                      <View key={title} style={s.rule}>
                        <View style={s.ruleIcon}>
                          <Icon name={icon} size={23} color="#A9C8FF" />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={s.ruleTitle}>{title}</Text>
                          <Text style={s.ruleCopy}>{copy}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                  <Text style={s.smallPrint}>
                    Контур показывает, куда приземлится фигура. Рекорд хранится на этом телефоне.
                    Игровые очки не переводятся в Чики.
                  </Text>
                  <SolidButton
                    title="Понятно"
                    testID="blocks-help-close"
                    onPress={() => setHelp(false)}
                  />
                </>
              ) : restart ? (
                <>
                  <SolidButton
                    title="Да, новая игра"
                    testID="blocks-restart-confirm"
                    onPress={start}
                  />
                  <SolidButton title="Отмена" secondary onPress={() => setRestart(false)} />
                </>
              ) : status === 'over' ? (
                <>
                  <View style={s.resultScoreBox}>
                    <Text style={s.eyebrow}>ТВОЙ РЕЗУЛЬТАТ</Text>
                    <Text
                      testID="blocks-result"
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      style={s.resultScore}
                    >
                      {number(game?.score ?? 0)}
                    </Text>
                    <Text style={s.resultDetail}>
                      {game?.lines ?? 0} {lineLabel(game?.lines ?? 0)} · уровень {game?.level ?? 1}
                    </Text>
                  </View>
                  <Text style={s.recordText}>
                    Рекорд на телефоне: {number(Math.max(best, game?.score ?? 0))}
                  </Text>
                  <SolidButton title="Ещё одну!" testID="blocks-replay" onPress={start} />
                  <SolidButton title="К событиям" secondary onPress={exit} />
                </>
              ) : (
                <>
                  <View style={s.pauseScore}>
                    <Text style={s.eyebrow}>ТЕКУЩИЙ СЧЁТ</Text>
                    <Text style={s.pauseNumber}>{number(game?.score ?? 0)}</Text>
                  </View>
                  {!tooSmall ? (
                    <SolidButton
                      title="Продолжить"
                      testID="blocks-resume"
                      onPress={controller.resume}
                    />
                  ) : null}
                  <SolidButton title="Как играть" secondary onPress={() => setHelp(true)} />
                  <Pressable
                    testID="blocks-restart"
                    accessibilityRole="button"
                    onPress={() => setRestart(true)}
                    style={s.helpLink}
                  >
                    <Text style={s.helpLinkText}>Начать заново</Text>
                  </Pressable>
                  <Pressable
                    testID="blocks-leave-paused"
                    accessibilityRole="button"
                    onPress={exit}
                    style={s.helpLink}
                  >
                    <Text style={s.helpLinkText}>К событиям</Text>
                  </Pressable>
                </>
              )}
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: arcade.ink },
  header: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 2 },
  iconButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  headerBrand: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  headerTitle: {
    fontFamily: font.display,
    color: '#F3F6FF',
    fontSize: 16,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  body: { fontFamily: font.body, fontSize: 15, lineHeight: 24, color: '#B9CBEA' },
  intro: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 16,
    gap: 12,
  },
  introArt: { paddingTop: 24, paddingBottom: 30, alignItems: 'center', justifyContent: 'center' },
  halo: {
    position: 'absolute',
    width: 235,
    height: 235,
    borderRadius: 120,
    backgroundColor: '#16408755',
    borderWidth: 1,
    borderColor: '#2962BC33',
  },
  introBadge: {
    flexDirection: 'row',
    gap: 7,
    alignItems: 'center',
    marginTop: 27,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#122A55',
  },
  introBadgeText: {
    fontFamily: font.bold,
    fontSize: 10,
    lineHeight: 15,
    letterSpacing: 0.9,
    color: '#C8D9F7',
  },
  introTitle: {
    fontFamily: font.display,
    fontSize: 35,
    lineHeight: 43,
    letterSpacing: -1,
    color: '#F5F7FF',
    textAlign: 'center',
  },
  introFeatures: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  feature: { fontFamily: font.medium, fontSize: 12, lineHeight: 20, color: '#99B3DE' },
  featureDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: '#607DAA' },
  introBest: { fontFamily: font.heading, fontSize: 15, lineHeight: 22, color: '#FFCDA6' },
  introFooter: { paddingTop: 8, gap: 3 },
  button: {
    minHeight: 56,
    backgroundColor: '#FFAF75',
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  buttonSecondary: { backgroundColor: '#132D57', borderWidth: 1, borderColor: '#2B4671' },
  buttonText: {
    fontFamily: font.display,
    fontSize: 18,
    lineHeight: 24,
    color: '#251609',
    textAlign: 'center',
  },
  helpLink: {
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
  helpLinkText: {
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 20,
    color: '#A6BDE3',
    textAlign: 'center',
  },
  playArea: { flex: 1, minHeight: 0 },
  playAreaWide: { flexDirection: 'row', gap: 24 },
  stats: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 5,
    paddingBottom: 5,
    alignItems: 'flex-start',
  },
  stat: { flex: 1, minWidth: 0 },
  eyebrow: {
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 1.3,
    color: '#8DAAD4',
  },
  score: {
    fontFamily: font.display,
    fontSize: 32,
    lineHeight: 38,
    color: '#FFBC8B',
    letterSpacing: -0.7,
  },
  best: { fontFamily: font.display, fontSize: 25, lineHeight: 34, color: '#E6EEFF' },
  bestLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  stage: {
    flex: 1,
    minHeight: 0,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 8,
  },
  board: {
    backgroundColor: '#020C25',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#31558B',
    overflow: 'hidden',
  },
  gridLine: { position: 'absolute', backgroundColor: '#142745' },
  rail: { width: 78, gap: 14, alignSelf: 'stretch', justifyContent: 'center' },
  nextBox: {
    alignItems: 'center',
    paddingHorizontal: 3,
    paddingVertical: 13,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#244676',
    backgroundColor: '#0A2149',
  },
  railLabel: {
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.75,
    color: '#8CACD8',
    textAlign: 'center',
  },
  nextShape: { minHeight: 36, marginTop: 12, justifyContent: 'center', alignItems: 'center' },
  railStat: { paddingVertical: 4, alignItems: 'center' },
  railNumber: {
    fontFamily: font.display,
    fontSize: 24,
    lineHeight: 31,
    color: '#E9F0FF',
    marginTop: 1,
  },
  levelTrack: {
    height: 3,
    backgroundColor: '#15315B',
    borderRadius: 3,
    width: 48,
    marginTop: 5,
    overflow: 'hidden',
  },
  levelFill: { height: 3, backgroundColor: '#FFAB71', borderRadius: 3 },
  railTip: { alignItems: 'center', gap: 8, marginTop: 2 },
  tipText: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
    color: '#809FCB',
    textAlign: 'center',
  },
  portraitControls: { paddingTop: 0 },
  wideControls: { width: 220, justifyContent: 'center' },
  controlHint: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  hintText: {
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 1.2,
    color: '#6689BC',
  },
  hintLine: { height: 1, flex: 1, backgroundColor: '#244268' },
  gestureHint: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 18,
    textAlign: 'center',
    color: '#A3BDE2',
    marginTop: 9,
  },
  storageNotice: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    minHeight: 48,
    paddingVertical: 6,
  },
  storageText: { fontFamily: font.medium, fontSize: 11, lineHeight: 17, color: '#FFD2AE', flex: 1 },
  modalShade: { flex: 1, backgroundColor: '#01091BCF', paddingHorizontal: 22 },
  modalScroll: { flexGrow: 1, justifyContent: 'center', paddingVertical: 12 },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    padding: 23,
    borderRadius: 28,
    backgroundColor: '#09214A',
    borderWidth: 1,
    borderColor: '#355B8B',
    gap: 13,
  },
  modalSymbol: {
    alignSelf: 'center',
    width: 66,
    height: 66,
    borderRadius: 22,
    backgroundColor: '#173561',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 3,
  },
  modalTitle: {
    fontFamily: font.display,
    fontSize: 30,
    lineHeight: 37,
    letterSpacing: -0.7,
    color: '#F4F7FF',
    textAlign: 'center',
  },
  modalText: {
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 22,
    color: '#AFC5E7',
    textAlign: 'center',
    marginBottom: 4,
  },
  rules: { gap: 17, marginVertical: 8 },
  rule: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  ruleIcon: { width: 35, minHeight: 38, alignItems: 'center', justifyContent: 'center' },
  ruleTitle: { fontFamily: font.display, fontSize: 16, lineHeight: 23, color: '#EEF3FF' },
  ruleCopy: { fontFamily: font.body, fontSize: 12, lineHeight: 20, color: '#A7BDDE', marginTop: 2 },
  smallPrint: {
    fontFamily: font.body,
    fontSize: 11,
    lineHeight: 18,
    color: '#8DAAD2',
    marginBottom: 6,
  },
  pauseScore: { alignItems: 'center', gap: 3, paddingVertical: 5 },
  pauseNumber: { fontFamily: font.display, fontSize: 38, lineHeight: 47, color: '#FFC99D' },
  resultScoreBox: { alignItems: 'center', paddingVertical: 9 },
  resultScore: {
    fontFamily: font.display,
    fontSize: 54,
    lineHeight: 65,
    letterSpacing: -1,
    color: '#FFC697',
  },
  resultDetail: { fontFamily: font.medium, fontSize: 13, lineHeight: 21, color: '#ABC2E6' },
  recordText: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 20,
    color: '#FFCCA5',
    textAlign: 'center',
    marginBottom: 8,
  },
});
