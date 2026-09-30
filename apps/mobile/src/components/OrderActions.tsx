import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MotionModal, MotionPressable } from './Motion';
import { CloseButton, Body, Button, Caption, Heading, Icon, Row } from './UI';
import { colors } from '../theme';

export function OrderActions({
  visible,
  number,
  onClose,
  onSupport,
}: {
  visible: boolean;
  number: string;
  onClose(): void;
  onSupport?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <MotionModal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={[
          s.overlay,
          { paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom) },
        ]}
      >
        <MotionPressable
          accessibilityRole="button"
          accessibilityLabel="Закрыть действия заказа"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          testID="order-actions-dialog"
          role="dialog"
          aria-modal
          accessibilityViewIsModal
          accessibilityLabel="Помощь с заказом"
          style={s.dialog}
        >
          <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
            <Row style={{ justifyContent: 'space-between', gap: 12 }}>
              <CloseButton
                testID="order-actions-close"
                label="Закрыть окно помощи"
                onPress={onClose}
              />
              <Heading small style={{ flex: 1 }}>
                Заказ №{number}
              </Heading>
            </Row>
            <View style={s.symbol}>
              <Icon name="chatbubbles-outline" color={colors.accent} size={30} />
            </View>
            <Body>Нужна помощь с заказом?</Body>
            <Caption>
              {onSupport
                ? 'Напишите управляющему. Номер заказа и ресторан добавим автоматически.'
                : 'Обращения по оплате подключаются. Если нужна помощь сейчас, обратитесь к сотруднику ресторана.'}
            </Caption>
            {onSupport ? (
              <Button
                title="Написать в поддержку"
                testID="order-actions-support"
                onPress={onSupport}
              />
            ) : null}
          </ScrollView>
        </View>
      </View>
    </MotionModal>
  );
}
const s = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    backgroundColor: '#00000099',
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '100%',
    backgroundColor: colors.surface,
    borderRadius: 24,
  },
  content: { padding: 20, gap: 16 },
  symbol: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
