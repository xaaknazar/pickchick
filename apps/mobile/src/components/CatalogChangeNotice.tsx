import { t, localize, useLocale } from '../i18n';
import { View } from 'react-native';
import { Notice, Button, Caption } from './UI';
import { money } from '../domain';

export function CatalogChangeNotice({
  message,
  totals,
  onDismiss,
}: {
  message: string;
  totals?: { oldTotal: string; newTotal: string } | null;
  onDismiss?(): void;
}) {
  useLocale();
  return (
    <View testID="cart-prices-updated" accessibilityLiveRegion="polite">
      <Notice title={t('Меню обновилось')} warning>
        {localize(message)}
      </Notice>
      {totals && totals.oldTotal !== totals.newTotal ? (
        <Caption>
          {t('Было')}
          {localize(money(totals.oldTotal))}
          {t('. Сейчас')}
          {localize(money(totals.newTotal))}.
        </Caption>
      ) : null}
      {onDismiss ? (
        <Button title={t('Понятно')} testID="catalog-update-apply" onPress={onDismiss} />
      ) : null}
    </View>
  );
}
