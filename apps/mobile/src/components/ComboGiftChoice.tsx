import { View, StyleSheet } from 'react-native';
import type { ScreenProps } from '../model';
import { Body, Caption, Icon } from './UI';
import { MotionPressable } from './Motion';
import { colors, font } from '../theme';

export function ComboGiftChoice({ props }: { props: ScreenProps }) {
  const rewards = props.model.comboRewards;
  const state = rewards?.progress;
  const data = state?.commercial;
  if (props.preview || !rewards || (!data?.availableGifts && !rewards.selected)) return null;
  const product = props.model.products.find((p) => p.id === 'pick-combo');
  const available =
    state?.status === 'ready' &&
    !!data?.availableGifts &&
    !data.reconciliationRequired &&
    product?.available !== false &&
    !!product;
  return (
    <View style={s.panel} testID="cart-combo-gift">
      <MotionPressable
        testID="cart-use-combo-gift"
        accessibilityRole="checkbox"
        aria-checked={rewards.selected}
        accessibilityLabel="Использовать подарочный Pick Combo"
        accessibilityState={{
          checked: rewards.selected,
          disabled: !available && !rewards.selected,
        }}
        disabled={!available && !rewards.selected}
        onPress={() => rewards.select(!rewards.selected)}
        style={s.choice}
      >
        <Icon
          name={rewards.selected ? 'checkbox' : 'square-outline'}
          color={colors.accentText}
          size={28}
        />
        <View style={{ flex: 1, gap: 4 }}>
          <Body style={{ fontFamily: font.bold }}>Pick Combo в подарок</Body>
          <Caption>
            {rewards.selected
              ? 'Акция применена к одному комбо'
              : 'Использовать подарок в этом заказе'}
          </Caption>
        </View>
        <Icon name="gift-outline" color={colors.accentText} size={26} />
      </MotionPressable>
      <Caption>
        {available
          ? 'Базовый Pick Combo бесплатно. Платные добавки оплачиваются отдельно. Состав можно изменить в карточке комбо.'
          : 'Обновляем доступность подарка. Можно снять галочку и сохранить его на потом.'}
      </Caption>
    </View>
  );
}
const s = StyleSheet.create({
  panel: { backgroundColor: colors.surface, borderRadius: 20, padding: 16, gap: 8 },
  choice: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12 },
});
