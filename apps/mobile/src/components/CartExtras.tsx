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
import { comboCardShown } from '../store-build';
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
                <View style={s.extraText}>
                  <Body style={s.extraName}>{localize(line.product.name)}</Body>
                  <Caption numberOfLines={1} style={s.extraDetail}>
                    {localize(selectionDescription(line) || line.product.servingLabel)}
                  </Caption>
                </View>
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
                  <View style={s.extraPlus}>
                    <Icon name="add" size={20} color={colors.orangeInk} />
                  </View>
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
  const progress = props.model.comboRewards?.progress ?? props.model.testFlow.comboProgress;
  // App Store build (owner 29.10.2026): the 6 + 1 card only while the server runs the programme;
  // without it and without published promotions there is no «Акции» block at all.
  const combo = comboCardShown(progress, undefined, props.preview);
  if (!combo && !content?.promos.length) return null;
  return (
    <View style={{ gap: 14 }}>
      {/* Same heading as «Всегда кстати»: one left edge and one size for cart sections. */}
      <Heading
        small
        style={[
          orderUI.section,
          { fontFamily: font.display, fontSize: 22, lineHeight: 28, marginTop: 18 },
        ]}
      >
        {t('Акции')}
      </Heading>
      {combo ? (
        <ComboRewardCard
          preview={props.preview}
          progress={progress}
          compact
          testID="cart-combo-reward"
          onMenu={() => props.navigate('M06')}
        />
      ) : null}
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
  // Owner 22.11.2026: the same card as the menu grid - photo on the light window, the name
  // under it, then the price on the left and the round orange plus on the right.
  extra: {
    width: 148,
    padding: 6,
    paddingBottom: 10,
    borderRadius: 22,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: '#FFFFFF0D',
  },
  extraPhoto: { width: '100%', height: 112, borderRadius: 16, backgroundColor: '#EEF2F8' },
  extraText: { gap: 2, paddingTop: 10, paddingHorizontal: 6 },
  extraName: { fontFamily: font.bold, fontSize: 15, lineHeight: 20, color: colors.text },
  extraDetail: { fontSize: 12, lineHeight: 17, color: colors.muted },
  extraAdd: {
    minHeight: 44,
    marginTop: 10,
    paddingLeft: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  extraPrice: {
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 20,
    fontVariant: ['tabular-nums'],
    color: colors.text,
  },
  extraPlus: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
