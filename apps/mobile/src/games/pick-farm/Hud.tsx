import { memo, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { LEVEL_XP, levelForXp } from '@pickchick/farm-game';
import { Icon, type IconName } from '../../components/UI';
import { font } from '../../theme';
import { Coin, CountUp, usePulse } from './effects';
import { farmPalette as p, farmStyles as s } from './styles';

export function HudButton({
  label,
  icon,
  onPress,
  dot = false,
  count,
  text,
  testID,
  onLayout,
}: {
  label: string;
  icon: IconName;
  onPress(): void;
  dot?: boolean;
  count?: number;
  text?: string;
  testID?: string;
  onLayout?(event: LayoutChangeEvent): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={dot ? 'Есть готовая награда или действие' : undefined}
      testID={testID}
      onPress={onPress}
      onLayout={onLayout}
      hitSlop={4}
      style={({ pressed }) => [
        s.button,
        text ? null : { paddingHorizontal: 0, width: 48 },
        pressed && s.pressed,
      ]}
    >
      <Icon name={icon} size={text ? 20 : 24} color={p.ink} />
      {text ? <Text style={s.buttonText}>{text}</Text> : null}
      {dot && (
        <View
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 11,
            height: 11,
            borderRadius: 6,
            backgroundColor: '#E2553F',
            borderWidth: 2,
            borderColor: p.paper,
          }}
        />
      )}
      {count ? (
        <View
          style={{
            position: 'absolute',
            top: -4,
            right: -4,
            minWidth: 20,
            height: 20,
            paddingHorizontal: 5,
            borderRadius: 10,
            backgroundColor: p.blue,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontFamily: font.bold, fontSize: 11, color: '#FFFFFF' }}>
            {count > 999 ? '999+' : count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Narrow screens: secondary HUD buttons slide out in a row under the HUD. */
export function HudTray({
  top,
  right,
  reduced,
  children,
}: {
  top: number;
  right: number;
  reduced: boolean;
  children: ReactNode;
}) {
  const t = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    const animation = Animated.timing(t, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [t, reduced]);
  return (
    <Animated.View
      testID="pick-farm-hud-tray"
      style={[
        s.pill,
        {
          position: 'absolute',
          top,
          right,
          flexDirection: 'row',
          gap: 8,
          padding: 6,
          zIndex: 20,
          backgroundColor: '#283E35EE',
          opacity: t,
          transform: [{ translateX: t.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** Confirmed coins and XP only; predictions never change these counters. */
export const Wallet = memo(function Wallet({
  coins,
  xp,
  saving,
  reduced,
  onCoinsLayout,
  onLevelLayout,
  onLevelPress,
}: {
  coins: number;
  xp: number;
  saving: boolean;
  reduced: boolean;
  onCoinsLayout(event: LayoutChangeEvent): void;
  onLevelLayout(event: LayoutChangeEvent): void;
  onLevelPress(): void;
}) {
  const level = levelForXp(xp);
  const floor = LEVEL_XP[level - 1] ?? 0;
  const next = LEVEL_XP[level];
  const share = next === undefined ? 1 : (xp - floor) / (next - floor);
  const coinPulse = usePulse(coins, reduced);
  const levelPulse = usePulse(xp, reduced);
  return (
    <>
      <Animated.View
        onLayout={onCoinsLayout}
        accessible
        accessibilityLabel={`${coins} монет${saving ? '. Сохраняем действия' : ''}`}
        testID="pick-farm-coins"
        style={[
          s.metricPill,
          {
            minHeight: 48,
            paddingHorizontal: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            transform: [{ scale: coinPulse }],
          },
        ]}
      >
        <Coin size={20} />
        <CountUp value={coins} style={[s.metric, { minWidth: 34 }]} />
        {saving && (
          <View
            accessible={false}
            style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.orange }}
          />
        )}
      </Animated.View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Уровень ${level}. ${xp} опыта${next !== undefined ? `, до следующего уровня ${next - xp}` : ''}`}
        onPress={onLevelPress}
        onLayout={onLevelLayout}
        testID="pick-farm-level"
      >
        <Animated.View
          style={[
            s.metricPill,
            {
              minHeight: 48,
              paddingHorizontal: 12,
              justifyContent: 'center',
              transform: [{ scale: levelPulse }],
            },
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="star" size={15} color={p.orange} />
            <Text style={s.metric}>Ур. {level}</Text>
          </View>
          <View
            style={{
              marginTop: 4,
              width: 64,
              height: 5,
              borderRadius: 3,
              backgroundColor: '#FFFFFF33',
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                width: `${Math.round(Math.max(0.04, Math.min(1, share)) * 100)}%`,
                height: 5,
                backgroundColor: p.orange,
              }}
            />
          </View>
        </Animated.View>
      </Pressable>
    </>
  );
});
