import { useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { assets } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Logo } from './Logo';
import { useEnter, useLoop, usePop, useSpringTo } from './motion';

export type OrderStage = 'accepted' | 'preparing' | 'ready';
const fill: Record<OrderStage, number> = { accepted: 0.18, preparing: 0.52, ready: 1 };
const order: OrderStage[] = ['accepted', 'preparing', 'ready'];
const labels: Record<Locale, Record<OrderStage, string>> = {
  ru: { accepted: 'Принят', preparing: 'Готовим', ready: 'Готов' },
  kk: { accepted: 'Қабылданды', preparing: 'Дайындалуда', ready: 'Дайын' },
};
/** Concentric translucent discs: a soft radial glow without a gradient library. */
const rings = Array.from({ length: 16 }, (_, index) => 1 - index * 0.055);

function StageLabel({ label, state }: { label: string; state: 'done' | 'active' | 'next' }) {
  const { v } = useMetrics();
  const blink = useLoop(1400, 0, true);
  return (
    <Animated.Text
      style={{
        fontFamily: fonts.medium,
        fontSize: Math.max(15, v(18)),
        color:
          state === 'done'
            ? colors.white
            : state === 'active'
              ? colors.orangeOnBlue
              : colors.onBlueMuted,
        opacity:
          state === 'active'
            ? blink.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] })
            : 1,
      }}
    >
      {label}
    </Animated.Text>
  );
}

/**
 * v3 order number on the blue surface: logo, chef, the stamped number with a
 * hard orange shadow, status, a three-stage progress bar, board hint, receipt.
 */
export function OrderTicket({
  number,
  status,
  confirmed,
  showBoard,
  receipt,
  locale,
  stage = 'accepted',
}: {
  number: string | null;
  status: string;
  confirmed: boolean;
  showBoard: boolean;
  receipt: string;
  locale: Locale;
  stage?: OrderStage | null;
}) {
  const { v, width, height } = useMetrics();
  const t = copy(locale);
  const tight = height < v(1180);
  const [track, setTrack] = useState(0);
  const logo = useEnter(0, 600);
  const chef = useEnter(120, 800);
  const label = useEnter(300, 500);
  const stamp = useEnter(380, 760);
  const pop = usePop(confirmed);
  const rest = useEnter(780, 500);
  const bar = useEnter(1000, 1400);
  const hint = useEnter(1000, 500);
  const target = useSpringTo(stage ? fill[stage] : 0);
  const glow = useLoop(4000, 0, true);
  const progress = Animated.multiply(bar, target);
  const prefixed = number?.startsWith('№') ?? false;
  const digits = prefixed ? number!.slice(1) : (number ?? '');
  const numberSize = Math.min(
    v(tight ? 200 : 230),
    Math.floor((width - v(120)) / Math.max(1, digits.length + (prefixed ? 0.5 : 0)) / 0.72),
  );
  const glowSize = v(760);
  const chefSize = v(tight ? 250 : 340);
  const reached = stage ? order.indexOf(stage) : -1;
  const fadeUp = (value: Animated.Value, distance = 16) => ({
    opacity: value,
    transform: [
      { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) },
    ],
  });
  return (
    <View style={{ width: '100%', alignItems: 'center', gap: v(6) }}>
      <Animated.View
        pointerEvents="none"
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          top: v(stage ? 110 : 20),
          left: '50%',
          marginLeft: -glowSize / 2,
          width: glowSize,
          height: glowSize,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] }),
          transform: [{ scale: glow.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }],
        }}
      >
        {rings.map((ring) => (
          <View
            key={ring}
            style={{
              position: 'absolute',
              width: glowSize * ring,
              height: glowSize * ring,
              borderRadius: (glowSize * ring) / 2,
              backgroundColor: 'rgba(255,255,255,.012)',
            }}
          />
        ))}
      </Animated.View>

      <Animated.View
        style={{
          opacity: logo,
          transform: [
            { translateY: logo.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) },
          ],
        }}
      >
        <Logo size="large" />
      </Animated.View>

      {stage ? (
        <Animated.View
          style={{
            marginTop: v(6),
            opacity: chef.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 1, 1] }),
            transform: [
              {
                scale: chef.interpolate({
                  inputRange: [0, 0.7, 0.85, 1],
                  outputRange: [0.5, 1.04, 0.99, 1],
                }),
              },
              {
                rotate: chef.interpolate({ inputRange: [0, 1], outputRange: ['-10deg', '0deg'] }),
              },
            ],
          }}
        >
          <Image
            source={stage === 'ready' ? assets.chefTray : assets.chefCooking}
            contentFit="contain"
            style={{ width: chefSize, height: chefSize }}
            accessible={false}
            accessibilityLabel=""
          />
        </Animated.View>
      ) : null}

      {number !== null ? (
        <>
          <Animated.Text
            style={{
              marginTop: v(6),
              fontFamily: fonts.heavy,
              fontSize: v(24),
              letterSpacing: 3,
              color: 'rgba(255,255,255,.7)',
              textTransform: 'uppercase',
              opacity: label,
            }}
          >
            {t.yourNumber}
          </Animated.Text>

          <Animated.View
            style={{
              opacity: stamp.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 1, 1] }),
              transform: [
                {
                  scale: Animated.multiply(
                    stamp.interpolate({
                      inputRange: [0, 0.6, 0.8, 1],
                      outputRange: [2.1, 0.95, 1.02, 1],
                    }),
                    pop,
                  ),
                },
              ],
            }}
          >
            <Text
              testID="kiosk-order-number"
              style={{
                fontFamily: fonts.black,
                fontVariant: ['tabular-nums'],
                fontSize: numberSize,
                lineHeight: numberSize * 0.96 + v(10),
                letterSpacing: -numberSize * 0.026,
                color: colors.white,
                textAlign: 'center',
                textShadowColor: colors.orange,
                textShadowOffset: { width: 0, height: v(10) },
                textShadowRadius: 0,
              }}
            >
              {prefixed ? <Text style={{ fontSize: numberSize * 0.42 }}>№</Text> : null}
              {digits}
            </Text>
          </Animated.View>
        </>
      ) : null}

      <Animated.View style={{ alignItems: 'center', gap: v(6), ...fadeUp(rest) }}>
        <Text
          testID="kiosk-order-state"
          accessibilityRole="header"
          accessibilityLiveRegion="polite"
          style={{
            marginTop: v(tight ? 12 : 22),
            fontFamily: fonts.black,
            fontSize: v(40),
            lineHeight: v(46),
            color: colors.white,
            textAlign: 'center',
          }}
        >
          {status}
        </Text>
        {number === null ? (
          <Text
            testID="kiosk-order-delivery-pending"
            style={{
              fontFamily: fonts.body,
              fontSize: Math.max(18, v(24)),
              lineHeight: v(34),
              color: colors.white,
              textAlign: 'center',
              marginTop: v(20),
            }}
          >
            {locale === 'ru'
              ? 'Передаём заказ на кухню. Номер появится здесь. Не оплачивайте повторно. Если ожидание затянулось, пригласите сотрудника.'
              : 'Тапсырысты асүйге жіберіп жатырмыз. Нөмірі осында пайда болады. Қайта төлем жасамаңыз. Күту ұзаққа созылса, қызметкерді шақырыңыз.'}
          </Text>
        ) : null}
      </Animated.View>

      {stage ? (
        <Animated.View
          style={{
            width: '100%',
            maxWidth: v(600),
            gap: v(12),
            marginTop: v(16),
            opacity: rest,
          }}
        >
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={status}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(fill[stage] * 100) }}
            onLayout={(event) => setTrack(event.nativeEvent.layout.width)}
            style={{
              height: v(14),
              borderRadius: v(7),
              backgroundColor: colors.glass,
              overflow: 'hidden',
            }}
          >
            {track > 0 ? (
              <Animated.View
                style={{
                  width: track,
                  height: '100%',
                  backgroundColor: colors.orange,
                  transform: [
                    {
                      translateX: progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-track / 2, 0],
                      }),
                    },
                    {
                      scaleX: progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.0001, 1],
                      }),
                    },
                  ],
                }}
              />
            ) : null}
          </View>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between' }}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            {order.map((item, index) => (
              <StageLabel
                key={item}
                label={labels[locale][item]}
                state={
                  index < reached || stage === 'ready'
                    ? 'done'
                    : index === reached
                      ? 'active'
                      : 'next'
                }
              />
            ))}
          </View>
        </Animated.View>
      ) : null}

      {showBoard ? (
        <Animated.Text
          style={{
            marginTop: v(14),
            fontFamily: fonts.body,
            fontSize: Math.max(17, v(21)),
            color: colors.onBlueMuted,
            textAlign: 'center',
            opacity: hint,
          }}
        >
          {t.board}
        </Animated.Text>
      ) : null}
      <Animated.Text
        style={{
          marginTop: v(6),
          fontFamily: fonts.body,
          fontSize: Math.max(15, v(16)),
          color: colors.onBlueMuted,
          textAlign: 'center',
          opacity: hint,
        }}
      >
        {receipt}
      </Animated.Text>
    </View>
  );
}
