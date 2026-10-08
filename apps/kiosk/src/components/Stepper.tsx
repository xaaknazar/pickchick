import { Animated, Text } from 'react-native';
import { fonts, colors, useMetrics } from '../theme';
import type { Locale } from '../i18n';
import { Wrapper } from './Wrapper';
import { IconButton } from './IconButton';
import { usePopIn } from './motion';
/**
 * v3 quantity stepper: soft minus, orange plus and a heavy count that pops on change
 * (prototype `.stp output.tick`: scale .3 -> 1 and fade in, 300 ms --spring).
 * `onLimit` answers a tap on + at the maximum (the caller shakes its row).
 * `onBlue` puts a white minus and a white count on the blue surface.
 * `ids` and `labels` let a caller keep its own automation ids and spoken labels.
 */
export function Stepper({
  quantity,
  locale = 'ru',
  onMinus,
  onPlus,
  min = 0,
  max = 99,
  prefix,
  ids,
  labels,
  disabled = false,
  tone = 'default',
  onLimit,
}: {
  quantity: number;
  locale?: Locale;
  onMinus: () => void;
  onPlus: () => void;
  min?: number;
  max?: number;
  prefix?: string;
  ids?: { minus: string; quantity: string; plus: string };
  labels?: { minus: string; plus: string };
  disabled?: boolean;
  tone?: 'default' | 'onBlue';
  /** + was tapped at the maximum. */
  onLimit?: () => void;
}) {
  const { v } = useMetrics();
  const pop = usePopIn(quantity, 300, 0, false);
  return (
    <Wrapper dir="row" align="center" gap={6}>
      <IconButton
        name="remove"
        tone={tone === 'onBlue' ? 'light' : 'neutral'}
        label={labels?.minus ?? (locale === 'ru' ? 'Уменьшить количество' : 'Санын азайту')}
        disabled={disabled || quantity <= min}
        onPress={onMinus}
        testID={ids?.minus ?? (prefix ? prefix + '-minus' : undefined)}
      />
      <Animated.View
        style={{ minWidth: v(36), opacity: pop.opacity, transform: [{ scale: pop.scale }] }}
      >
        <Text
          testID={ids?.quantity ?? (prefix ? prefix + '-quantity' : undefined)}
          style={{
            fontFamily: fonts.black,
            fontVariant: ['tabular-nums'],
            fontSize: Math.max(20, v(24)),
            color: tone === 'onBlue' ? colors.white : colors.navy,
            textAlign: 'center',
          }}
        >
          {quantity}
        </Text>
      </Animated.View>
      <IconButton
        name="add"
        tone="accent"
        label={labels?.plus ?? (locale === 'ru' ? 'Увеличить количество' : 'Санын көбейту')}
        disabled={disabled || quantity >= max}
        onPress={onPlus}
        onRefused={!disabled && onLimit ? onLimit : undefined}
        testID={ids?.plus ?? (prefix ? prefix + '-plus' : undefined)}
      />
    </Wrapper>
  );
}
