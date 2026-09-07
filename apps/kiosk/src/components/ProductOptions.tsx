import { Pressable, View } from 'react-native';
import type { KioskModifierGroup, KioskSelection } from '../model';
import { money } from '../cart';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Body, Heading, Icon, layout } from './UI';
export function ModifierOptions({
  group,
  selections,
  setSelections,
  locale,
  dark = false,
  limit,
}: {
  group: KioskModifierGroup;
  selections: KioskSelection[];
  setSelections: (selections: KioskSelection[]) => void;
  locale: Locale;
  dark?: boolean;
  limit?: number;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const ink = dark ? colors.white : colors.ink;
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
    <View style={{ gap: px(16) }}>
      <View style={[layout.spread, { gap: px(16) }]}>
        <Body style={{ color: ink, fontFamily: fonts.medium, flex: 1, letterSpacing: 0.6 }}>
          {group.title.toLocaleUpperCase('ru')}
        </Body>
        <Body
          style={{
            color: ink,
            fontSize: Math.max(16, px(18)),
            backgroundColor: dark ? 'rgba(255,255,255,.1)' : colors.light,
            borderRadius: px(14),
            paddingVertical: px(8),
            paddingHorizontal: px(12),
          }}
        >
          {group.min > 0 ? `${t.chosen} ${total} / ${group.max}` : t.optional}
        </Body>
      </View>
      <View
        style={{
          flexDirection: group.max === 1 ? 'row' : 'column',
          flexWrap: group.max === 1 ? 'wrap' : 'nowrap',
          alignItems: 'stretch',
          gap: px(12),
        }}
      >
        {group.options.slice(0, limit).map((option) => {
          const quantity =
            selections.find((s) => s.group_id === group.id && s.option_id === option.id)
              ?.quantity ?? 0;
          const selected = quantity > 0;
          const minusDisabled = quantity <= 0;
          const plusDisabled =
            !option.available || quantity >= option.max_quantity || total >= group.max;
          const optionStyle = {
            minHeight: Math.max(64, px(82)),
            borderRadius: px(22),
            paddingVertical: px(15),
            paddingHorizontal: px(18),
            borderWidth: 2,
            borderColor: selected
              ? group.max === 1
                ? colors.white
                : colors.orange
              : dark
                ? 'rgba(255,255,255,.15)'
                : colors.border,
            backgroundColor: selected
              ? group.max === 1
                ? colors.white
                : dark
                  ? 'rgba(255,103,31,.18)'
                  : '#FFF2EA'
              : dark
                ? 'rgba(255,255,255,.07)'
                : colors.white,
            opacity: option.available ? 1 : 0.4,
          };
          const delta =
            BigInt(option.price_delta_minor) > 0n ? `+ ${money(option.price_delta_minor)}` : '';
          return group.max === 1 ? (
            <Pressable
              key={option.id}
              testID={`kiosk-modifier-${group.id}-${option.id}`}
              accessibilityRole="radio"
              accessibilityLabel={`${option.label}${delta ? `, ${delta}` : ''}`}
              accessibilityState={{ selected, disabled: !option.available }}
              disabled={!option.available}
              onPress={() => update(option.id, selected && group.min === 0 ? 0 : 1)}
              style={[
                optionStyle,
                { width: '48.6%', flexDirection: 'row', alignItems: 'center', gap: px(12) },
              ]}
            >
              <View
                style={{
                  width: px(28),
                  height: px(28),
                  borderRadius: px(14),
                  borderWidth: 2,
                  borderColor: selected ? colors.blue : dark ? '#CCD0DA' : '#8791A4',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {selected ? (
                  <View
                    style={{
                      width: px(14),
                      height: px(14),
                      borderRadius: 9,
                      backgroundColor: colors.blue,
                    }}
                  />
                ) : null}
              </View>
              <View style={{ flex: 1, gap: px(6) }}>
                <Body
                  style={{
                    color: selected ? colors.blue : ink,
                    fontFamily: selected ? fonts.medium : fonts.body,
                  }}
                >
                  {option.label}
                </Body>
                {delta ? (
                  <Body
                    style={{
                      color: selected ? colors.blue : dark ? '#BEC5D4' : colors.muted,
                      fontSize: Math.max(16, px(17)),
                    }}
                  >
                    {delta}
                  </Body>
                ) : null}
              </View>
            </Pressable>
          ) : (
            <View
              key={option.id}
              testID={`kiosk-modifier-${group.id}-${option.id}`}
              style={[optionStyle, layout.spread, { width: '100%', gap: px(20) }]}
            >
              <View style={{ flex: 1, gap: px(6) }}>
                <Body style={{ color: ink }}>{option.label}</Body>
                {delta ? (
                  <Body
                    style={{
                      color: dark ? '#BEC5D4' : colors.muted,
                      fontSize: Math.max(16, px(17)),
                    }}
                  >
                    {delta}
                  </Body>
                ) : null}
              </View>
              <View style={[layout.row, { gap: px(12) }]}>
                <Pressable
                  testID={`kiosk-modifier-minus-${group.id}-${option.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`− ${option.label}`}
                  disabled={minusDisabled}
                  accessibilityState={{ disabled: minusDisabled }}
                  onPress={() => update(option.id, quantity - 1)}
                  style={{
                    width: Math.max(48, px(62)),
                    height: Math.max(48, px(62)),
                    borderRadius: px(17),
                    justifyContent: 'center',
                    alignItems: 'center',
                    backgroundColor: dark ? 'rgba(255,255,255,.12)' : colors.light,
                    opacity: minusDisabled ? 0.3 : 1,
                  }}
                >
                  <Icon name="remove" color={ink} size={px(28)} />
                </Pressable>
                <Heading
                  testID={`kiosk-modifier-quantity-${group.id}-${option.id}`}
                  size={26}
                  color={ink}
                  style={{ minWidth: px(35), textAlign: 'center' }}
                >
                  {quantity}
                </Heading>
                <Pressable
                  testID={`kiosk-modifier-plus-${group.id}-${option.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`+ ${option.label}`}
                  disabled={plusDisabled}
                  accessibilityState={{ disabled: plusDisabled }}
                  onPress={() => update(option.id, quantity + 1)}
                  style={{
                    width: Math.max(48, px(62)),
                    height: Math.max(48, px(62)),
                    borderRadius: px(17),
                    justifyContent: 'center',
                    alignItems: 'center',
                    backgroundColor: selected
                      ? colors.orange
                      : dark
                        ? 'rgba(255,255,255,.12)'
                        : colors.light,
                    opacity: plusDisabled ? 0.3 : 1,
                  }}
                >
                  <Icon name="add" color={selected ? colors.white : ink} size={px(28)} />
                </Pressable>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
