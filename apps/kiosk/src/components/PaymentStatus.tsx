import { useEffect, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { Icon, type IconName } from './Icon';
import { PaymentQR } from './PaymentQR';
import { useEnter } from './motion';
import { checkoutCopy } from '../checkoutCopy';
import { fixedText } from './Body';
import { useAnnounce } from './announce';

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
  const enter = useEnter(120 + index * 35, 340);
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
        // A short, quiet cascade keeps the instructions readable promptly.
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
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
        <Text
          {...fixedText}
          style={{ fontFamily: fonts.black, fontSize: v(19), color: colors.white }}
        >
          {index + 1}
        </Text>
      </View>
      <Text
        {...fixedText}
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
 * Branded payment centre. The amount settles first, the QR fades into place
 * without stretching its modules, then the instructions arrive in a short cascade.
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
  demoWarning = null,
  checking = false,
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
  /**
   * Staff demo mode (owner decision 2026-10-11): "ДЕМО - не оплачивать" over the QR. The QR text
   * is not payable, and the Kaspi steps give way to the message card.
   */
  demoWarning?: string | null;
  checking?: boolean;
}) {
  const { v, height, width } = useMetrics();
  const t = copy(locale);
  // Shorter than the 820 x 1180 design (rounding of v() aside).
  const tight = height < v(1180) - 4;
  const waiting = state === 'waiting';
  // VoiceOver hears every status change (live regions below serve Android and the web).
  useAnnounce(title + '. ' + message);
  const left = useCountdown(qrPayload ? expiresAt : null);
  const drop = useEnter(0, 360);
  const rise = useEnter(40, 360);
  const card = useEnter(80, 300);
  const methodLabel = method === 'invoice' ? t.invoiceMethod : method === 'card' ? t.card : t.payQR;
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
  // Neutral payment heading; provider identifiers remain in the transport only.
  // Only a real bank QR or invoice carries the brand; the simulator keeps the tile.
  const heading = waiting ? methodLabel : title;
  const amountSize = v(tight ? 58 : dense ? 62 : 70);
  return (
    <View style={{ width: '100%', alignItems: 'center', gap: v(tight || dense ? 12 : 26) }}>
      <Animated.View
        style={{
          flexDirection: waiting ? 'row' : 'column',
          alignItems: 'center',
          gap: v(16),
          maxWidth: '100%',
          opacity: drop,
          transform: [
            { translateY: drop.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) },
          ],
        }}
      >
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

        <View style={{ flexShrink: 1, gap: v(2), alignItems: waiting ? 'flex-start' : 'center' }}>
          <Text
            {...fixedText}
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
          {waiting ? (
            <Text
              {...fixedText}
              testID="kiosk-payment-waiting-status"
              style={{
                fontFamily: fonts.body,
                fontSize: Math.max(17, v(18)),
                color: colors.onBlueMuted,
              }}
              accessibilityLiveRegion="polite"
            >
              {checking ? t.checkingPayment : qrPayload ? t.paymentAuto : title}
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
            { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
          ],
        }}
      >
        <Text
          {...fixedText}
          style={{ fontFamily: fonts.medium, fontSize: v(20), color: colors.onBlueMuted }}
        >
          {/* Dense (live Kaspi QR): the design has no order chip, so the reference
              joins the "К оплате" line and the chip row goes away. */}
          {dense ? t.toPay + ' · ' + reference : t.toPay}
        </Text>
        <Text
          {...fixedText}
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
              {...fixedText}
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
            // Design 07: white card 460 x 528 at 820 pt, radius 40.
            minWidth: Math.min(v(460), width - v(48)),
            borderRadius: v(40),
            backgroundColor: colors.white,
            paddingHorizontal: v(20),
            paddingTop: v(20),
            paddingBottom: v(24),
            alignItems: 'center',
            gap: v(16),
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
          }}
        >
          {demoWarning ? (
            <View
              testID="kiosk-demo-qr-warning"
              style={{
                maxWidth: v(400),
                paddingVertical: v(8),
                paddingHorizontal: v(18),
                borderRadius: 999,
                backgroundColor: colors.orangeInk,
              }}
            >
              <Text
                {...fixedText}
                style={{
                  fontFamily: fonts.bold,
                  fontSize: v(20),
                  color: colors.white,
                  textAlign: 'center',
                }}
              >
                {demoWarning}
              </Text>
            </View>
          ) : null}
          <PaymentQR
            payload={qrPayload}
            label={demoWarning ?? t.payKaspiQR}
            size={tight || demoWarning ? 'compact' : 'regular'}
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
              <Text
                {...fixedText}
                style={{ fontFamily: fonts.bold, fontSize: v(18), color: '#B44A00' }}
              >
                {t.qrValid}
              </Text>
              <Text
                {...fixedText}
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

      {qrPayload && waiting && !demoWarning ? (
        <View style={{ width: '100%', flexDirection: 'row', gap: v(12) }}>
          {/* Instructions refer to the guest banking app. */}
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
            {...fixedText}
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
