import { Keyboard } from 'react-native';
import { Button } from './UI';

/** Finishes editing only. Payment remains a separate, explicit action. */
export function CheckoutKeyboardDone() {
  return (
    <Button
      testID="checkout-comment-done"
      title="Готово"
      accessibilityLabel="Готово, закрыть клавиатуру"
      secondary
      style={{ minHeight: 48 }}
      onPress={Keyboard.dismiss}
    />
  );
}
