import { useEffect, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { colors, fonts, useMetrics } from '../theme';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { Icon, type IconName } from './Icon';
import { PaymentQR } from './PaymentQR';
import { useEnter } from './motion';
import { checkoutCopy } from '../checkoutCopy';
const kaspiLogo = require('../../assets/v3/kaspi.webp');

const clock = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/** Seconds left until `expiresAt`, ticking once a second; null when there is no expiry. */
function useCountdown(expiresAt: string | null | undefined) {
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(expiry)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiry]);
  return Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now) / 1000)) : null;
}

function QrStep({ index, label }: { index: number; label: string }) {
  const { v } = useMetrics();
  const enter = useEnter(300 + index * 70, 460);
  return (
    <Animated.View
      style={{
        flex: 1,
        minWidth: 0,
        borderRadius: v(22),
        backgroundColor: colors.white,
        padding: v(16),
        gap: v(10),
        shadowColor: '#020A28',
        shadowOpacity: 0.18,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
        elevation: 6,
        // Prototype `rise`: translateY 34 and scale .97 to rest.
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [34, 0] }) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
        ],
      }}
    >
      <View
        style={{
          width: v(40),
          height: v(40),
          borderRadius: v(20),
          backgroundColor: colors.orange,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontFamily: fonts.black, fontSize: v(19), color: colors.white }}>
          {index + 1}
        </Text>
      </View>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: Math.max(16, v(17)),
          lineHeight: Math.max(16, v(17)) * 1.3,
          color: colors.navy,
        }}
      >
        {label}
      </Text>
    </Animated.View>
  );
}

/**
 * v3 payment centre on the blue surface: method tile and title (drop), the
 * amount (fade up), the QR card (springs in, scanning line, live expiry pill)
 * and three numbered steps (rise, 70 ms apart). Without a QR the existing
 * message is shown in a white card instead.
 */
export function PaymentStatus({
  state,
  title,
  total,
  reference,
  message,
  qrPayload,
  expiresAt,
  method = 'qr',
  locale = 'ru',
  dense = false,
}: {
  state: 'waiting' | 'unknown' | 'declined';
  title: string;
  total: string;
  reference: string;
  message: string;
  qrPayload?: string | null;
  expiresAt?: string | null;
  method?: 'qr' | 'invoice' | 'card';
  locale?: Locale;
  /** Closer vertical rhythm so a control below the steps stays above the footer. */
  dense?: boolean;
}) {
  const { v, height } = useMetrics();
  const t = copy(locale);
  const tight = height < v(1180);
  const waiting = state === 'waiting';
  const left = useCountdown(qrPayload ? expiresAt : null);
  const drop = useEnter(0, 520);
  const rise = useEnter(80, 520);
  // Prototype `qrIn` runs on the spring curve: the card overshoots, then settles.
  const card = useEnter(140, 640, 'spring');
  const methodLabel =
    method === 'invoice'
      ? 'Kaspi - ' + (locale === 'ru' ? 'счёт на телефон' : 'телефонға шот')
      : method === 'card'
        ? t.card
        : t.payQR;
  const icon: IconName =
    state === 'unknown'
      ? 'time-outline'
      : state === 'declined'
        ? 'close-circle-outline'
        : method === 'invoice'
          ? 'phone-portrait-outline'
          : method === 'card'
            ? 'card-outline'
            : 'qr-code-outline';
  // Design: Kaspi payments open with the Kaspi mark and "Kaspi QR" (no tile).
  // Only a real bank QR or invoice carries the brand; the simulator keeps the tile.
  const kaspi = waiting && (method === 'invoice' || (method === 'qr' && !!qrPayload));
  const heading = waiting ? (kaspi && method === 'qr' ? 'Kaspi QR' : methodLabel) : title;
  const amountSize = v(tight ? 58 : dense ? 62 : 70);
  return (
    <View style={{ width: '100%', alignItems: 'center', gap: v(tight || dense ? 12 : 26) }}>
      <Animated.View
        style={{
          flexDirection: waiting ? 'row' : 'column',
          alignItems: 'center',
          gap: v(16),
          maxWidth: '100%',
          // Prototype `drop`: from translateY -28 and scale .92.
          opacity: drop,
          transform: [
            { translateY: drop.interpolate({ inputRange: [0, 1], outputRange: [-28, 0] }) },
            { scale: drop.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
          ],
        }}
      >
        {kaspi ? (
          <Image
            testID="kiosk-payment-kaspi-mark"
            source={kaspiLogo}
            contentFit="contain"
            accessible={false}
            accessibilityLabel=""
            style={{ width: v(dense ? 64 : 76), height: v(dense ? 64 : 76) }}
          />
        ) : (
          <View
            style={{
              width: v(76),
              height: v(76),
              borderRadius: v(22),
              backgroundColor: waiting ? colors.orange : colors.white,
              alignItems: 'center',
              justifyContent: 'center',
              shadowColor: waiting ? colors.orange : '#020A28',
              shadowOpacity: 0.4,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 10 },
              elevation: 8,
            }}
          >
            <Icon name={icon} size="large" tone={waiting ? 'inverse' : 'brand'} />
          </View>
        )}
        <View style={{ flexShrink: 1, gap: v(2), alignItems: waiting ? 'flex-start' : 'center' }}>
          <Text
            accessibilityRole="header"
            style={{
              fontFamily: fonts.black,
              fontSize: v(44),
              lineHeight: v(48),
              letterSpacing: -0.5,
              color: colors.white,
              textAlign: waiting ? 'left' : 'center',
            }}
          >
            {heading}
          </Text>
          {/* With the QR on screen the design shows no status line; until then
              it says what the kiosk is waiting for. */}
          {waiting && !qrPayload ? (
            <Text
              style={{ fontFamily: fonts.body, fontSize: v(18), color: colors.onBlueMuted }}
              accessibilityLiveRegion="polite"
            >
              {title}
            </Text>
          ) : waiting ? (
            // Hidden with the QR on screen (design), but still announced to VoiceOver.
            <Text
              accessibilityLiveRegion="polite"
              style={{
                position: 'absolute',
                width: 1,
                height: 1,
                overflow: 'hidden',
                opacity: 0,
              }}
            >
              {title}
            </Text>
          ) : null}
        </View>
      </Animated.View>

      <Animated.View
        style={{
          alignItems: 'center',
          gap: v(2),
          opacity: rise,
          transform: [
            { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [22, 0] }) },
          ],
        }}
      >
        <Text style={{ fontFamily: fonts.medium, fontSize: v(20), color: colors.onBlueMuted }}>
          {/* Dense (live Kaspi QR): the design has no order chip, so the reference
              joins the "К оплате" line and the chip row goes away. */}
          {dense ? t.toPay + ' · ' + reference : t.toPay}
        </Text>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          style={{
            fontFamily: fonts.black,
            fontSize: amountSize,
            lineHeight: amountSize * 1.08,
            letterSpacing: -1,
            color: colors.white,
            fontVariant: ['tabular-nums'],
          }}
        >
          {money(total)}
        </Text>
        {dense ? null : (
          <View
            style={{
              marginTop: v(6),
              minHeight: v(36),
              paddingHorizontal: v(16),
              borderRadius: 999,
              backgroundColor: colors.glass,
              justifyContent: 'center',
            }}
          >
            <Text
              style={{ fontFamily: fonts.bold, fontSize: Math.max(15, v(16)), color: colors.white }}
            >
              {reference}
            </Text>
          </View>
        )}
      </Animated.View>

      {qrPayload ? (
        <Animated.View
          style={{
            borderRadius: v(40),
            backgroundColor: colors.white,
            padding: v(tight || dense ? 22 : 30),
            alignItems: 'center',
            gap: v(tight || dense ? 14 : 20),
            shadowColor: '#020A28',
            shadowOpacity: 0.45,
            shadowRadius: 35,
            shadowOffset: { width: 0, height: 30 },
            elevation: 18,
            opacity: card.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            }),
            transform: [
              { scale: card.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
              {
                translateY: card.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }),
              },
            ],
          }}
        >
          <PaymentQR
            payload={qrPayload}
            label="Kaspi QR"
            size={tight ? 'compact' : 'regular'}
            scanning={waiting}
          />
          {left !== null ? (
            <View
              accessible
              accessibilityLabel={`${t.qrValid} ${clock(left)}`}
              style={{
                minHeight: v(48),
                paddingHorizontal: v(20),
                borderRadius: 999,
                backgroundColor: colors.peach,
                flexDirection: 'row',
                alignItems: 'center',
                gap: v(10),
              }}
            >
              <Icon name="time-outline" size="small" tone="deep" />
              <Text style={{ fontFamily: fonts.bold, fontSize: v(18), color: '#B44A00' }}>
                {t.qrValid}
              </Text>
              <Text
                style={{
                  fontFamily: fonts.bold,
                  fontSize: v(18),
                  color: '#B44A00',
                  fontVariant: ['tabular-nums'],
                }}
              >
                {clock(left)}
              </Text>
            </View>
          ) : null}
        </Animated.View>
      ) : null}

      {qrPayload && waiting ? (
        <View style={{ width: '100%', flexDirection: 'row', gap: v(12) }}>
          {/* The QR on screen is always a Kaspi QR: design steps name Kaspi.kz. */}
          {checkoutCopy(locale).kaspiSteps.map((label, index) => (
            <QrStep key={index} index={index} label={label} />
          ))}
        </View>
      ) : (
        <Animated.View
          style={{
            width: '100%',
            maxWidth: v(640),
            borderRadius: v(22),
            backgroundColor: colors.white,
            paddingHorizontal: v(24),
            paddingVertical: v(20),
            shadowColor: '#020A28',
            shadowOpacity: 0.18,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
            elevation: 6,
            opacity: card.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            }),
            transform: [
              { translateY: card.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
            ],
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{
              fontFamily: fonts.medium,
              fontSize: Math.max(17, v(19)),
              lineHeight: Math.max(17, v(19)) * 1.4,
              color: colors.navy,
              textAlign: 'center',
            }}
          >
            {message}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}
