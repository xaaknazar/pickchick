import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Notice, Button, Caption, Icon } from './UI';
import { ConfirmSheet } from './ConfirmSheet';
import { money } from '../domain';
import { PRICES_UPDATED } from '../cart-reprice';
import { colors, font } from '../theme';

/**
 * Where the customer acknowledges the change (cart, open product card) it is presented as
 * a confirmation sheet first; closing the sheet with × leaves the inline notice.
 * Checkout (no onDismiss) keeps the inline notice only.
 */
export function CatalogChangeNotice({
  message,
  totals,
  onDismiss,
}: {
  message: string;
  totals?: { oldTotal: string; newTotal: string } | null;
  onDismiss?(): void;
}) {
  const [sheet, setSheet] = useState(Boolean(onDismiss));
  const changed = totals && totals.oldTotal !== totals.newTotal ? totals : null;
  const sentence = changed
    ? `Было ${money(changed.oldTotal)}. Сейчас ${money(changed.newTotal)}.`
    : '';
  if (onDismiss && sheet)
    return (
      <ConfirmSheet
        visible
        icon="pricetag-outline"
        title="Цены обновились"
        primaryLabel="Понятно"
        primaryTestID="catalog-update-apply"
        onPrimary={onDismiss}
        onClose={() => setSheet(false)}
      >
        <View testID="cart-prices-updated" accessibilityLiveRegion="polite" style={s.body}>
          <Text style={s.message}>
            {message === PRICES_UPDATED ? 'Проверьте итоговую сумму перед оплатой.' : message}
          </Text>
          {changed ? (
            <View style={s.totals} accessible accessibilityLabel={sentence}>
              <Text style={s.old}>{money(changed.oldTotal)}</Text>
              <Icon name="arrow-forward" size={18} color={colors.muted} />
              <Text style={s.new}>{money(changed.newTotal)}</Text>
              {/* Full sentence for screen readers on web and text search; not drawn. */}
              <Text style={s.hidden}>{sentence}</Text>
            </View>
          ) : null}
        </View>
      </ConfirmSheet>
    );
  return (
    <View testID="cart-prices-updated" accessibilityLiveRegion="polite">
      <Notice title="Меню обновилось" warning>
        {message}
      </Notice>
      {changed ? <Caption>{sentence}</Caption> : null}
      {onDismiss ? (
        <Button title="Понятно" testID="catalog-update-apply" onPress={onDismiss} />
      ) : null}
    </View>
  );
}
const s = StyleSheet.create({
  body: { gap: 12 },
  message: { color: colors.muted, fontFamily: font.body, fontSize: 15, lineHeight: 22 },
  totals: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: colors.raised,
  },
  old: {
    color: colors.muted,
    fontFamily: font.medium,
    fontSize: 16,
    lineHeight: 22,
    textDecorationLine: 'line-through',
  },
  new: { color: colors.text, fontFamily: font.bold, fontSize: 18, lineHeight: 24 },
  hidden: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
});
