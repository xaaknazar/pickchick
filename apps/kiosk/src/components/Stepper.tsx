import { Text } from 'react-native';
import { fonts, colors, useMetrics } from '../theme';
import type { Locale } from '../i18n';
import { Wrapper } from './Wrapper';
import { IconButton } from './IconButton';
export function Stepper({
  quantity,
  locale = 'ru',
  onMinus,
  onPlus,
  min = 0,
  max = 99,
  prefix,
  disabled = false,
}: {
  quantity: number;
  locale?: Locale;
  onMinus: () => void;
  onPlus: () => void;
  min?: number;
  max?: number;
  prefix: string;
  disabled?: boolean;
}) {
  const { px } = useMetrics();
  return (
    <Wrapper dir="row" align="center" gap={8}>
      <IconButton
        name="remove"
        label={locale === 'ru' ? 'Уменьшить количество' : 'Санын азайту'}
        disabled={disabled || quantity <= min}
        onPress={onMinus}
        testID={prefix + '-minus'}
      />
      <Text
        testID={prefix + '-quantity'}
        style={{
          fontFamily: fonts.medium,
          fontVariant: ['tabular-nums'],
          fontSize: px(28),
          color: colors.ink,
          minWidth: px(36),
          textAlign: 'center',
        }}
      >
        {quantity}
      </Text>
      <IconButton
        name="add"
        label={locale === 'ru' ? 'Увеличить количество' : 'Санын көбейту'}
        disabled={disabled || quantity >= max}
        onPress={onPlus}
        testID={prefix + '-plus'}
      />
    </Wrapper>
  );
}
