import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, useMetrics } from '../theme';
import { Body, Heading, IconButton, Wrapper } from './UI';
export function ProductToolbar({
  locale,
  onClose,
  step,
  steps,
}: {
  locale: Locale;
  onClose: () => void;
  step?: number;
  steps?: number;
}) {
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  return (
    <View
      style={{
        paddingTop: Math.max(safe.top, px(20)),
        paddingHorizontal: px(28),
        paddingBottom: px(16),
        backgroundColor: colors.white,
        borderBottomWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Wrapper dir="row" align="center" gap={18}>
        <IconButton
          name={step === 2 ? 'arrow-back' : 'close'}
          label={t.close}
          testID="kiosk-product-close"
          onPress={onClose}
        />
        <Wrapper flex={1} gap={4}>
          <Heading size="section">
            {step === 1
              ? t.saucesTitle
              : step === 2
                ? t.extrasTitle
                : locale === 'ru'
                  ? 'Ваш выбор'
                  : 'Таңдауыңыз'}
          </Heading>
          {step ? (
            <Body variant="caption" tone="muted">
              {t.step} {step} / {steps}
            </Body>
          ) : null}
        </Wrapper>
      </Wrapper>
    </View>
  );
}
