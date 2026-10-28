import { localize, t, useLocale } from '../i18n';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CustomerCommerceOrder } from '@pickchick/contracts';
import { closePaymentCopy } from '../commerce-presentation';
import { colors } from '../theme';
import { MotionModal } from './Motion';
import { Body, Button, Heading } from './UI';

/**
 * «Закрыть оплату?» (owner 28.10.2026): asked by the glass X of a payment screen only while the
 * bank may still act on the order (checkout-resume.ts closeNeedsConfirm). Closing never cancels
 * anything at the bank; the copy says what the code guarantees (closePaymentCopy). The same card
 * as «Очистить корзину?»; reduced motion shows it without the fade (MotionModal).
 */
export function PaymentCloseConfirm({
  visible,
  phase,
  onClose,
  onStay,
}: {
  visible: boolean;
  phase?: CustomerCommerceOrder['phase'];
  onClose(): void;
  onStay(): void;
}) {
  useLocale();
  const insets = useSafeAreaInsets();
  const copy = closePaymentCopy(phase);
  return (
    <MotionModal visible={visible} transparent onRequestClose={onStay}>
      <ScrollView
        contentContainerStyle={[
          s.backdrop,
          { paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom) },
        ]}
      >
        <View
          testID="kaspi-close-dialog"
          accessibilityViewIsModal
          role="dialog"
          aria-modal
          accessibilityLabel={localize(copy.title)}
          style={s.card}
        >
          <Heading small>{localize(copy.title)}</Heading>
          <Body muted testID="kaspi-close-detail">
            {localize(copy.detail)}
          </Body>
          <Button title={t(copy.close)} testID="kaspi-close-confirm" onPress={onClose} />
          <Button title={t(copy.stay)} secondary testID="kaspi-close-stay" onPress={onStay} />
        </View>
      </ScrollView>
    </MotionModal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#00000099',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    borderRadius: 24,
    padding: 24,
    gap: 16,
    backgroundColor: colors.surface,
  },
});
