import { t, localize, useLocale } from '../i18n';
import { UpcomingPayments, checkoutStyle } from './CheckoutPresentation';
import { PaymentMark } from './PaymentChoice';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { MotionPressable } from './Motion';
import { Body, Caption, Heading, Icon } from './UI';
import { ComboRewardCard } from './ComboRewardCard';
import { usePublishedContent } from '../backoffice/usePublishedContent';
import { PromotionDialog } from '../backoffice/PromotionDialog';
import type { PublishedContent } from '../backoffice/content-model';
import type { ScreenProps } from '../model';
import { orderUI } from './OrderPresentation';
import { cartRecommendations } from '../cart-actions';
import { lineUnitPrice, money, selectionDescription } from '../domain';
import { ProductPhoto, productPhoto } from './ProductPhoto';
import { colors, font } from '../theme';

export function CartRecommendations({ props }: { props: ScreenProps }) {
  useLocale();
  const recommendations = cartRecommendations(props.model.cart, props.model.products);
  const [added, setAdded] = useState('');
  return (
    <View style={{ gap: 12 }}>
      {recommendations.length ? (
        <>
          <Heading
            small
            style={[
              orderUI.section,
              {
                fontFamily: font.display,
                fontSize: 22,
                lineHeight: 28,
                marginTop: 18,
                marginLeft: 8,
              },
            ]}
          >
            {t('Всегда кстати')}
          </Heading>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 12 }}
            testID="cart-recommendations"
          >
            {recommendations.map((line) => (
              <View key={line.product.id} style={s.extra}>
                <ProductPhoto
                  photo={productPhoto(line.product, 'card', 'extra')}
                  contentFit="contain"
                  style={s.extraPhoto}
                  accessible={false}
                />
                <Body style={s.extraName}>{localize(line.product.name)}</Body>
                <Caption numberOfLines={1} style={s.extraDetail}>
                  {localize(selectionDescription(line) || line.product.servingLabel)}
                </Caption>
                <View style={{ flex: 1 }} />
                <MotionPressable
                  style={s.extraAdd}
                  accessibilityRole="button"
                  testID={`cart-recommend-${line.product.id}`}
                  accessibilityLabel={localize(
                    t('Добавить {p0}, {p1}', {
                      p0: t(line.product.name),
                      p1: money(lineUnitPrice(line)),
                    }),
                  )}
                  onPress={() => {
                    setAdded(
                      props.model.appendCartLines([line])
                        ? t('{p0} добавлен в корзину', { p0: t(line.product.name) })
                        : 'Меню или корзина изменились. Попробуйте ещё раз.',
                    );
                  }}
                >
                  <Body style={s.extraPrice}>{localize(money(lineUnitPrice(line)))}</Body>
                  <Icon name="add" size={19} color={colors.accent} />
                </MotionPressable>
              </View>
            ))}
          </ScrollView>
        </>
      ) : null}
      {added ? (
        <Caption accessibilityLiveRegion="polite" testID="cart-recommend-added">
          {localize(added)}
        </Caption>
      ) : null}
    </View>
  );
}

export function CartOffers({ props }: { props: ScreenProps }) {
  useLocale();
  const { content } = usePublishedContent(props.preview ? null : props.model.branch?.id);
  const [selected, setSelected] = useState<PublishedContent['promos'][number] | null>(null);
  return (
    <View style={{ gap: 14 }}>
      <Heading small style={orderUI.section}>
        {t('Акции')}
      </Heading>
      <ComboRewardCard
        preview={props.preview}
        progress={props.model.comboRewards?.progress ?? props.model.testFlow.comboProgress}
        compact
        testID="cart-combo-reward"
        onMenu={() => props.navigate('M06')}
      />
      {content?.promos.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 12 }}
        >
          {content.promos.map((promo) => (
            <MotionPressable
              key={promo.id}
              accessibilityRole="button"
              accessibilityLabel={localize(t('{p0}, условия акции', { p0: t(promo.title.ru) }))}
              onPress={() => setSelected(promo)}
              style={s.promotion}
            >
              <Icon name="pricetag-outline" color={colors.accent} />
              <Body style={{ fontFamily: font.bold }}>{localize(promo.title.ru)}</Body>
              <Caption numberOfLines={3}>{localize(promo.body.ru)}</Caption>
              <Body style={{ color: colors.accentText }}>{t('Условия акции')}</Body>
            </MotionPressable>
          ))}
        </ScrollView>
      ) : null}
      <PromotionDialog promotion={selected} onClose={() => setSelected(null)} />
    </View>
  );
}

/** Provider enrollment is still pending. No card details are collected. */
export function CheckoutPayments() {
  useLocale();
  return (
    <View style={{ gap: 10 }}>
      <View style={checkoutStyle.paymentPanel}>
        <View
          style={s.method}
          accessible
          accessibilityLabel={t('Kaspi, подключается')}
          accessibilityState={{ disabled: true }}
        >
          <PaymentMark method="kaspi" size={36} />
          <View style={{ flex: 1 }}>
            <Body style={orderUI.label}>Kaspi.kz</Body>
            <Caption>{t('Подключается')}</Caption>
          </View>
        </View>
        <UpcomingPayments />
      </View>
      <Caption style={orderUI.detail}>{t('Оплата и чеки - в процессе подключения.')}</Caption>
    </View>
  );
}
const s = StyleSheet.create({
  extra: {
    width: 136,
    padding: 12,
    paddingTop: 0,
    gap: 3,
    borderRadius: 22,
    backgroundColor: '#0B2255',
    borderWidth: 1,
    borderColor: '#FFFFFF0F',
  },
  extraPhoto: { width: 110, height: 96, borderRadius: 16, backgroundColor: '#FFFFFF' },
  extraName: { fontFamily: font.heading, fontSize: 15, lineHeight: 19, marginTop: 6 },
  extraDetail: { fontSize: 12, lineHeight: 17, color: '#A3B4D6' },
  extraAdd: {
    minHeight: 48,
    paddingHorizontal: 10,
    marginTop: 8,
    borderRadius: 24,
    backgroundColor: '#14306B',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
  },
  extraPrice: { fontFamily: font.heading, fontSize: 15, lineHeight: 20 },
  promotion: {
    width: 260,
    padding: 18,
    gap: 12,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  methods: { gap: 8 },
  method: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 80,
    padding: 16,
    gap: 12,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  methodIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.raised,
  },
  methodText: { flex: 1, minWidth: 0, gap: 2 },
});
