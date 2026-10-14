import { t, useLocale } from '../i18n';
import { Keyboard } from 'react-native';
import { Button } from './UI';

/** Finishes editing only. Payment remains a separate, explicit action. */
export function CheckoutKeyboardDone() {
  useLocale();
  return (
    <Button
      testID="checkout-comment-done"
      title={t('Готово')}
      accessibilityLabel={t('Готово, закрыть клавиатуру')}
      secondary
      style={{ minHeight: 48 }}
      onPress={Keyboard.dismiss}
    />
  );
}
