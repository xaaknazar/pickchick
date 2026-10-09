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
  return (
    <View testID="cart-prices-updated" accessibilityLiveRegion="polite">
      <Notice title="Меню обновилось" warning>
        {message}
      </Notice>
      {totals && totals.oldTotal !== totals.newTotal ? (
        <Caption>
          Было {money(totals.oldTotal)}. Сейчас {money(totals.newTotal)}.
        </Caption>
      ) : null}
      {onDismiss ? (
        <Button title="Понятно" testID="catalog-update-apply" onPress={onDismiss} />
      ) : null}
    </View>
  );
}
