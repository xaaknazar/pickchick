import { Pressable, View } from 'react-native';
import { colors, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Body, Heading, Icon, Wrapper } from './UI';
import type { KioskPaymentMethod } from '../model';
export function PaymentMethodCard({
  method,
  selected,
  busy,
  commercial,
  locale,
  onSelect,
}: {
  method: KioskPaymentMethod;
  selected: boolean;
  busy: boolean;
  commercial: boolean;
  locale: Locale;
  onSelect: () => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const invoice = method === 'kaspi_invoice';
  const title = invoice
    ? locale === 'ru'
      ? 'Счёт на телефон'
      : 'Телефонға шот'
    : method === 'kaspi'
      ? commercial
        ? 'Kaspi QR'
        : 'Kaspi'
      : t.card;
  const description = commercial
    ? locale === 'ru'
      ? invoice
        ? 'Получите счёт в Kaspi.kz по номеру телефона'
        : 'Отсканируйте QR в приложении Kaspi.kz'
      : invoice
        ? 'Телефон нөмірі бойынша Kaspi.kz шотын алыңыз'
        : 'Kaspi.kz қосымшасында QR сканерлеңіз'
    : locale === 'ru'
      ? method === 'kaspi'
        ? 'Тестовый сценарий Kaspi - без QR и списания денег.'
        : 'Тестовый сценарий карты - без терминала и списания денег.'
      : method === 'kaspi'
        ? 'Kaspi сынағы - QR-кодсыз, ақша алынбайды.'
        : 'Карта сынағы - терминалсыз, ақша алынбайды.';
  return (
    <Pressable
      testID={'kiosk-payment-method-' + method}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: busy }}
      aria-checked={selected}
      disabled={busy}
      onPress={onSelect}
      style={({ pressed }) => ({
        backgroundColor: selected ? '#EEF4FF' : colors.white,
        borderWidth: 2,
        borderColor: selected ? colors.blue : colors.border,
        borderRadius: 16,
        padding: px(24),
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Wrapper dir="row" align="center" gap={22}>
        <View
          style={{
            width: px(72),
            height: px(72),
            borderRadius: 16,
            backgroundColor: method !== 'card' ? '#E52A2E' : colors.blue,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name={
              invoice
                ? 'phone-portrait-outline'
                : method === 'kaspi'
                  ? 'qr-code-outline'
                  : 'card-outline'
            }
            tone="inverse"
          />
        </View>
        <Wrapper flex={1} gap={6}>
          <Heading size="card">{title}</Heading>
          <Body variant="caption" tone="muted">
            {description}
          </Body>
        </Wrapper>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            borderWidth: 2,
            borderColor: selected ? colors.blue : colors.muted,
            backgroundColor: selected ? colors.blue : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {selected ? <Icon name="checkmark" size="small" tone="inverse" /> : null}
        </View>
      </Wrapper>
    </Pressable>
  );
}
