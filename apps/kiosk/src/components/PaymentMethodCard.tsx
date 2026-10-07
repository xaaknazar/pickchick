import { Pressable, View } from 'react-native';
import { colors, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Body, Heading, Icon, Wrapper } from './UI';
export function PaymentMethodCard({
  method,
  selected,
  busy,
  commercial,
  locale,
  onSelect,
}: {
  method: 'kaspi' | 'card';
  selected: boolean;
  busy: boolean;
  commercial: boolean;
  locale: Locale;
  onSelect: () => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const description = commercial
    ? locale === 'ru'
      ? 'QR в приложении Kaspi.kz'
      : 'Kaspi.kz қосымшасындағы QR'
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
            backgroundColor: method === 'kaspi' ? '#E52A2E' : colors.blue,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={method === 'kaspi' ? 'qr-code-outline' : 'card-outline'} tone="inverse" />
        </View>
        <Wrapper flex={1} gap={6}>
          <Heading size="card">{method === 'kaspi' ? 'Kaspi' : t.card}</Heading>
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
