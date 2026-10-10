import { useState } from 'react';
import { Animated, Easing, Text, View, type TextStyle } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { assets } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Logo } from './Logo';
import { OrderBurst } from './OrderBurst';
import { PaidStamp, paidLead } from './PaidStamp';
import { useEnter, useLoop, usePop, useSpringTo } from './motion';
import { useMotionPreference } from './useMotionPreference';
import { fixedText } from './Body';
import { useAnnounce } from './announce';

export type OrderStage = 'accepted' | 'preparing' | 'ready';
const fill: Record<OrderStage, number> = { accepted: 0.18, preparing: 0.52, ready: 1 };
const order: OrderStage[] = ['accepted', 'preparing', 'ready'];
const labels: Record<Locale, Record<OrderStage, string>> = {
  ru: { accepted: 'Принят', preparing: 'Готовим', ready: 'Готов' },
  kk: { accepted: 'Қабылданды', preparing: 'Дайындалуда', ready: 'Дайын' },
  en: { accepted: 'Accepted', preparing: 'Cooking', ready: 'Ready' },
};
/** Concentric translucent discs: a soft radial glow without a gradient library. */
const rings = Array.from({ length: 16 }, (_, index) => 1 - index * 0.055);
/**
 * Prototype `kShine` keyframes on a linear 0..1 cycle: 0-55 % sweeps
 * translateX -140 % -> 620 % with ease-in-out, then it waits off the bar.
 */
const sweep = Easing.bezier(0.42, 0, 0.58, 1);
const shineSteps = Array.from({ length: 12 }, (_, index) => index / 11);
const shineInput = [...shineSteps.map((k) => k * 0.55), 1];
const shineOutput = [...shineSteps.map((k) => -1.4 + 7.6 * sweep(k)), 6.2];

/** White highlight sweeping along the bar fill every 2 s, from 2.4 s after the ticket starts. */
function Shine({ span, after }: { span: number; after: number }) {
  const loop = useLoop(2000, after + 2400, false, 0, 'linear');
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        width: span,
        transform: [
          {
            translateX: loop.interpolate({
              inputRange: shineInput,
              outputRange: shineOutput.map((x) => x * span),
            }),
          },
          { skewX: '-20deg' },
        ],
      }}
    >
      <LinearGradient
        colors={['rgba(255,255,255,0)', 'rgba(255,255,255,.45)', 'rgba(255,255,255,0)']}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={{ flex: 1 }}
      />
    </Animated.View>
  );
}

function StageLabel({ label, state }: { label: string; state: 'done' | 'active' | 'next' }) {
  const { v } = useMetrics();
  const blink = useLoop(1400, 0, true);
  return (
    <Animated.Text
      {...fixedText}
      style={{
        fontFamily: fonts.medium,
        fontSize: Math.max(15, v(18)),
        color:
          state === 'done'
            ? colors.white
            : state === 'active'
              ? // Design `#k08` uses #FF8A3D / white 50 %; both miss 4.5:1 on the
                // blue, so the accessible light orange and muted white stay.
                colors.orangeOnBlue
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
 * When it opens already paid, a green "paid" card plays first and the ticket
 * choreography follows it; a burst of food cut-outs flies from the number.
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
  // Design 08 is drawn for 820 x 1180: the chef and the number give up the height a
  // taller-scaled screen lacks (13-inch iPad), so nothing is cut and nothing floats.
  const deficit = Math.max(0, v(1180) - height);
  const tight = deficit > v(60);
  useAnnounce(number ? `${t.yourNumber} ${number}. ${status}` : status);
  const [track, setTrack] = useState(0);
  const reduced = useMotionPreference();
  // Opening already paid: the paid card holds first, then the ticket arrives.
  const [lead] = useState(() => (confirmed && !reduced ? paidLead : 0));
  const logo = useEnter(lead, 600);
  // Prototype `chefPop` (800 ms, spring curve): scale .5 and -10deg overshoot, then settle.
  const chef = useEnter(lead + 120, 800, 'spring');
  const label = useEnter(lead + 300, 500);
  // Prototype `stamp` (760 ms, spring curve): scale 2.1 -> 1, blur -> sharp,
  // the hard orange shadow slides from 0 to 10 pt.
  const stamp = useEnter(lead + 380, 760, 'spring');
  const pop = usePop(confirmed);
  const rest = useEnter(lead + 780, 500);
  const bar = useEnter(lead + 1000, 1400);
  const hint = useEnter(lead + 1000, 500);
  const target = useSpringTo(stage ? fill[stage] : 0);
  const glow = useLoop(4000, 0, true);
  const progress = Animated.multiply(bar, target);
  const prefixed = number?.startsWith('№') ?? false;
  const digits = prefixed ? number!.slice(1) : (number ?? '');
  const tallNumber = Math.max(v(170), v(230) - deficit * 0.4);
  const numberSize = Math.min(
    tallNumber,
    Math.floor((width - v(120)) / Math.max(1, digits.length + (prefixed ? 0.5 : 0)) / 0.72),
  );
  // A long number is narrowed by the width; the height it leaves goes to the chef.
  const spare = tallNumber - numberSize;
  const numberText: TextStyle = {
    fontFamily: fonts.black,
    fontVariant: ['tabular-nums'],
    fontSize: numberSize,
    lineHeight: numberSize * 0.96 + v(10),
    letterSpacing: -numberSize * 0.026,
    textAlign: 'center',
  };
  const numberContent = (
    <>
      {prefixed ? (
        <Text {...fixedText} style={{ fontSize: numberSize * 0.42 }}>
          №
        </Text>
      ) : null}
      {digits}
    </>
  );
  const glowSize = v(760);
  const chefSize = Math.min(v(420), Math.max(v(200), v(340) - deficit * 0.6 + spare * 0.9));
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
            { translateY: logo.interpolate({ inputRange: [0, 1], outputRange: [-28, 0] }) },
            { scale: logo.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
          ],
        }}
      >
        <Logo size="large" />
      </Animated.View>

      {stage ? (
        <Animated.View
          style={{
            marginTop: v(6),
            opacity: chef.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            }),
            transform: [
              { scale: chef.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) },
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
            {...fixedText}
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

          <View style={{ zIndex: 2, alignItems: 'center' }}>
            <Animated.View
              style={{
                opacity: stamp.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 1],
                  extrapolate: 'clamp',
                }),
                transform: [
                  {
                    scale: Animated.multiply(
                      stamp.interpolate({ inputRange: [0, 1], outputRange: [2.1, 1] }),
                      pop,
                    ),
                  },
                ],
              }}
            >
              {/* The hard orange shadow is a copy behind the number that slides down. */}
              <Animated.Text
                {...fixedText}
                accessible={false}
                aria-hidden
                style={{
                  ...numberText,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  color: colors.orange,
                  transform: [
                    {
                      translateY: stamp.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, v(10)],
                      }),
                    },
                  ],
                }}
              >
                {numberContent}
              </Animated.Text>
              <Text
                {...fixedText}
                testID="kiosk-order-number"
                style={{ ...numberText, color: colors.white }}
              >
                {numberContent}
              </Text>
              {reduced ? null : (
                // Blur stand-in: a soft, larger ghost that dissolves as the number lands.
                <Animated.Text
                  {...fixedText}
                  accessible={false}
                  aria-hidden
                  style={{
                    ...numberText,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    color: colors.white,
                    opacity: stamp.interpolate({
                      inputRange: [0, 0.25, 0.7],
                      outputRange: [0, 0.35, 0],
                      extrapolate: 'clamp',
                    }),
                    transform: [{ scale: 1.15 }],
                  }}
                >
                  {numberContent}
                </Animated.Text>
              )}
            </Animated.View>
            {confirmed && stage ? (
              <View style={{ position: 'absolute', top: v(26), left: '50%' }}>
                <OrderBurst after={lead} />
              </View>
            ) : null}
          </View>
        </>
      ) : null}

      <Animated.View style={{ alignItems: 'center', gap: v(6), ...fadeUp(rest) }}>
        <Text
          {...fixedText}
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
            {...fixedText}
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
            {t.sendingToKitchen}
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
                  overflow: 'hidden',
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
              >
                {/* Child of the scaled fill, so it spans and sweeps the fill's width. */}
                {reduced ? null : <Shine span={track} after={lead} />}
              </Animated.View>
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
          {...fixedText}
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
        {...fixedText}
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
      <PaidStamp label={t.paid} active={confirmed} />
    </View>
  );
}
