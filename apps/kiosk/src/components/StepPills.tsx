import { Fragment } from 'react';
import { Text, View } from 'react-native';
import { copy, type Locale } from '../i18n';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { Icon } from './Icon';
/** The four steps of the redesigned order path, in order. */
export type OrderStep = 'menu' | 'extras' | 'payment' | 'number';
const STEPS: OrderStep[] = ['menu', 'extras', 'payment', 'number'];
/**
 * Order steps under the smart upsell header (kiosk redesign 2026-10-13): Меню ✓ → Допы →
 * Оплата → Номер заказа. Pills 42 high joined by lines that share the row: a done step is a
 * glass pill with an orange check, the current one a white pill with an orange number and navy
 * label, later ones faded glass. The line up to the current step is orange.
 */
export function StepPills({ current, locale }: { current: OrderStep; locale: Locale }) {
  const { px } = useMetrics();
  const t = copy(locale);
  const at = STEPS.indexOf(current);
  const labels: Record<OrderStep, string> = {
    menu: t.menu,
    extras: t.extras,
    payment: t.stepPayment,
    number: t.stepNumber,
  };
  const dot = Math.max(22, px(28));
  return (
    <View
      testID="kiosk-step-pills"
      accessible
      accessibilityLabel={`${t.orderStage}: ${at + 1}/${STEPS.length}, ${labels[current]}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: px(24),
        paddingTop: px(14),
      }}
    >
      {STEPS.map((step, index) => {
        const done = index < at;
        const active = index === at;
        return (
          <Fragment key={step}>
            {index ? (
              <View
                style={{
                  flex: 1,
                  minWidth: px(12),
                  height: Math.max(2, px(2.5)),
                  marginHorizontal: px(10),
                  borderRadius: 2,
                  backgroundColor: index <= at ? redesign.cta : 'rgba(255,255,255,.22)',
                }}
              />
            ) : null}
            <View
              testID={'kiosk-step-' + step}
              style={{
                height: Math.max(34, px(42)),
                paddingLeft: px(7),
                paddingRight: px(16),
                borderRadius: 999,
                flexDirection: 'row',
                alignItems: 'center',
                gap: px(10),
                backgroundColor: active ? colors.white : redesign.glass,
                borderWidth: active ? 0 : 1,
                borderColor: redesign.glassLine,
                opacity: done || active ? 1 : 0.7,
              }}
            >
              <View
                style={{
                  width: dot,
                  height: dot,
                  borderRadius: dot / 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: done || active ? redesign.cta : 'rgba(255,255,255,.16)',
                }}
              >
                {done ? (
                  <Icon name="checkmark" size="small" tone="inverse" />
                ) : (
                  <Text
                    {...fixedText}
                    style={{
                      fontFamily: fonts.black,
                      fontSize: Math.max(12, px(15)),
                      color: active ? colors.white : 'rgba(255,255,255,.6)',
                    }}
                  >
                    {index + 1}
                  </Text>
                )}
              </View>
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{
                  fontFamily: fonts.heavy,
                  fontSize: Math.max(13, px(17)),
                  color: active ? redesign.cardInk : done ? colors.white : 'rgba(255,255,255,.6)',
                }}
              >
                {labels[step]}
              </Text>
            </View>
          </Fragment>
        );
      })}
    </View>
  );
}
