import { Pressable, View, Text } from 'react-native';
import type { KioskModifierGroup, KioskSelection } from '../model';
import { money } from '../cart';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Body, Heading, Icon, IconButton, Wrapper } from './UI';
export function ModifierOptions({
  group,
  selections,
  setSelections,
  locale,
  limit,
}: {
  group: KioskModifierGroup;
  selections: KioskSelection[];
  setSelections: (s: KioskSelection[]) => void;
  locale: Locale;
  limit?: number;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const total = selections
    .filter((s) => s.group_id === group.id)
    .reduce((n, s) => n + s.quantity, 0);
  const update = (id: string, quantity: number) => {
    const others = selections.filter(
      (s) => !(s.group_id === group.id && (group.max === 1 || s.option_id === id)),
    );
    setSelections(
      quantity > 0 ? [...others, { group_id: group.id, option_id: id, quantity }] : others,
    );
  };
  return (
    <Wrapper gap={14}>
      <Wrapper dir="row" align="center" justify="space-between" gap={16}>
        <Wrapper flex={1}>
          <Heading size="card">{group.title}</Heading>
        </Wrapper>
        <Body variant="caption" tone="muted">
          {group.min > 0 ? `${t.chosen} ${total} / ${group.max}` : t.optional}
        </Body>
      </Wrapper>
      <View
        style={{
          flexDirection: group.max === 1 ? 'row' : 'column',
          flexWrap: group.max === 1 ? 'wrap' : 'nowrap',
          gap: px(12),
        }}
      >
        {group.options.slice(0, limit).map((option) => {
          const quantity =
            selections.find((s) => s.group_id === group.id && s.option_id === option.id)
              ?.quantity ?? 0;
          const selected = quantity > 0;
          const delta =
            BigInt(option.price_delta_minor) > 0n ? '+ ' + money(option.price_delta_minor) : '';
          const appearance = {
            minHeight: Math.max(64, px(86)),
            borderRadius: 16,
            paddingVertical: px(16),
            paddingHorizontal: px(18),
            borderWidth: 2,
            borderColor: selected ? colors.blue : colors.border,
            backgroundColor: selected ? '#EEF4FF' : colors.white,
            opacity: option.available ? 1 : 0.45,
          };
          return group.max === 1 ? (
            <Pressable
              key={option.id}
              testID={`kiosk-modifier-${group.id}-${option.id}`}
              accessibilityRole="radio"
              accessibilityLabel={option.label + (delta ? ', ' + delta : '')}
              accessibilityState={{ checked: selected, disabled: !option.available }}
              aria-checked={selected}
              disabled={!option.available}
              onPress={() => update(option.id, selected && group.min === 0 ? 0 : 1)}
              style={[
                appearance,
                {
                  flexBasis: '47%',
                  flexGrow: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: px(12),
                },
              ]}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  borderWidth: 2,
                  borderColor: selected ? colors.blue : colors.muted,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: selected ? colors.blue : 'transparent',
                }}
              >
                {selected ? <Icon name="checkmark" size="small" tone="inverse" /> : null}
              </View>
              <Wrapper flex={1} gap={4}>
                <Body variant={selected ? 'label' : 'body'} tone={selected ? 'brand' : 'default'}>
                  {option.label}
                </Body>
                {delta ? (
                  <Body variant="caption" tone="muted">
                    {delta}
                  </Body>
                ) : null}
              </Wrapper>
            </Pressable>
          ) : (
            <View
              key={option.id}
              testID={`kiosk-modifier-${group.id}-${option.id}`}
              style={appearance}
            >
              <Wrapper dir="row" align="center" gap={12}>
                <Wrapper flex={1} gap={4}>
                  <Body variant="label">{option.label}</Body>
                  {delta ? (
                    <Body variant="caption" tone="muted">
                      {delta}
                    </Body>
                  ) : null}
                </Wrapper>
                <IconButton
                  name="remove"
                  label={'- ' + option.label}
                  testID={`kiosk-modifier-minus-${group.id}-${option.id}`}
                  disabled={quantity <= 0}
                  onPress={() => update(option.id, quantity - 1)}
                />
                <Text
                  testID={`kiosk-modifier-quantity-${group.id}-${option.id}`}
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: px(26),
                    minWidth: 28,
                    textAlign: 'center',
                    color: colors.ink,
                  }}
                >
                  {quantity}
                </Text>
                <IconButton
                  name="add"
                  label={'+ ' + option.label}
                  tone={selected ? 'accent' : 'neutral'}
                  testID={`kiosk-modifier-plus-${group.id}-${option.id}`}
                  disabled={
                    !option.available || quantity >= option.max_quantity || total >= group.max
                  }
                  onPress={() => update(option.id, quantity + 1)}
                />
              </Wrapper>
            </View>
          );
        })}
      </View>
    </Wrapper>
  );
}
