import { t, localize, useLocale } from '../i18n';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import type { ScreenProps } from '../model';
import {
  CloseButton,
  Body,
  Caption,
  Heading,
  Icon,
  Row,
  Button,
  type IconName,
} from '../components/UI';
import { MotionPressable } from '../components/Motion';
import { GlassButton } from '../components/GlassButton';
import { OrderActions } from '../components/OrderActions';
import { RepeatOrder } from '../components/RepeatOrder';
import { OrderChef } from '../components/OrderChef';
import { GameCarousel } from '../components/GameCarousel';
import { openOrderGame } from '../games/order-games';
import { useOrderGames } from '../games/useOrderGames';
import { ProductPhoto, productPhoto } from '../components/ProductPhoto';
import { colors, font } from '../theme';
import { money } from '../domain';
import { restaurantLocation } from '../restaurant-location';
import type { OrderStatusData } from '../order-status';
import { orderStage, orderTimeLabel, orderScene } from '../order-status';

export function OrderStatusScreen({
  props,
  order,
  notice,
}: {
  props: ScreenProps;
  order: TestOrder;
  notice?: React.ReactNode;
}) {
  useLocale();
  return (
    <OrderStatusView
      props={props}
      order={order}
      notice={notice}
      afterItems={
        order.state === 'fulfilled' || order.state === 'cancelled' ? (
          <>
            <RepeatOrder order={order} props={props} />
            {order.state === 'fulfilled' ? (
              <Button
                title={t('Оценить заказ')}
                testID="order-rate"
                onPress={() => props.navigate('M35')}
              />
            ) : null}
          </>
        ) : undefined
      }
      onSupport={() => props.navigate('M31')}
      receipt={{
        testID: 'order-receipt',
        hint: 'Чеки и оплата в процессе',
        onPress: () => props.navigate('M21'),
      }}
    />
  );
}

/**
 * The «Чек» tile. With `onPress` it opens the receipt screen; without it the tile only
 * states the receipt status from `caption`, so a host never has to invent an action.
 */
export type OrderReceiptTile = {
  onPress?: () => void;
  caption?: string;
  hint?: string;
  testID?: string;
};

export function OrderStatusView({
  props,
  order,
  notice,
  afterItems,
  receipt,
  onSupport,
  onBeforeGame,
}: {
  props: ScreenProps;
  order: OrderStatusData;
  notice?: React.ReactNode;
  afterItems?: React.ReactNode;
  receipt?: OrderReceiptTile;
  onSupport?: () => void;
  /** Close a React Native <Modal> host first: a native route cannot be presented above it. */
  onBeforeGame?: () => void;
}) {
  useLocale();
  const [more, setMore] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const ready = order.state === 'ready' || order.state === 'fulfilled';
  const active = order.state === 'preparing';
  const location = restaurantLocation(order.branch_id);
  const branch = props.model.branches.find((b) => b.id === order.branch_id);
  const name = props.model.nickname.trim();
  const heroSize = Math.min(300, width - 72, Math.max(184, height * 0.29));
  useEffect(() => {
    setMore(false);
  }, [order.order_id]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [active, order.order_id]);
  const title =
    order.state === 'preparing'
      ? orderStage(order) === 'На сборке'
        ? 'Собираем заказ'
        : 'Готовим для вас'
      : order.state === 'ready'
        ? 'Заказ готов!'
        : order.state === 'fulfilled'
          ? 'Приятного аппетита!'
          : orderStage(order);
  const subtitle =
    order.state === 'ready'
      ? 'Подходите к стойке и назовите номер'
      : order.state === 'fulfilled'
        ? 'Как всё прошло? Нам важно ваше мнение'
        : order.state === 'cancelled'
          ? (order.cancellation_reason ?? 'Если нужна помощь, напишите нам')
          : orderStage(order) === 'На сборке'
            ? 'Всё приготовили. Проверяем, всё ли на месте'
            : order.state === 'paid'
              ? 'Оплата подтверждена. Ждём подтверждение кухни'
              : 'Жарим, собираем и следим за каждой деталью';
  // 20 pt side fields on phones; wide screens keep one centred 680 pt column.
  const inset = Math.max(20, (width - 680) / 2);
  // Published availability is the same check the game routes use; read it only while shown.
  const games = useOrderGames(active || ready ? props.model.branch?.id : null);
  const lineRows = order.snapshot.lines.map((line) => {
    const product = props.model.products.find((p) => p.id === line.id);
    const description = line.selections?.length
      ? line.selections
          .map((s) => t(s.option_label) + (s.quantity > 1 ? ` ×${s.quantity}` : ''))
          .join(' · ')
      : 'serving_label' in line
        ? line.serving_label
        : line.description;
    return (
      <View key={line.line_id ?? line.id} style={s.line}>
        <View style={s.linePhoto}>
          {product ? (
            <ProductPhoto
              photo={productPhoto(product, 'card', 'menu')}
              contentFit="contain"
              style={s.lineImage}
              accessibilityLabel={localize(line.name)}
            />
          ) : (
            <Icon name="restaurant-outline" size={22} color={colors.muted} />
          )}
        </View>
        <View style={s.lineCopy}>
          <Text numberOfLines={2} style={s.lineName}>
            {localize(line.name)}
          </Text>
          {description ? (
            <Text numberOfLines={1} style={s.lineDetail}>
              {localize(description)}
            </Text>
          ) : null}
        </View>
        <Text
          style={s.lineQuantity}
          accessibilityLabel={localize(t('{p0} шт.', { p0: line.quantity }))}
        >
          ×{localize(line.quantity)}
        </Text>
        <Text style={s.linePrice}>{localize(money(line.line_total_minor))}</Text>
      </View>
    );
  });
  return (
    <View
      style={[s.root, !props.inSheet && { paddingTop: insets.top + 12 }]}
      testID={`screen-${props.screenId}`}
    >
      <View
        style={{ flex: 1 }}
        aria-hidden={more}
        accessibilityElementsHidden={more}
        importantForAccessibility={more ? 'no-hide-descendants' : 'auto'}
      >
        <Row style={s.header}>
          <CloseButton
            testID="order-status-close"
            label={t('Закрыть статус заказа')}
            onPress={props.goBack}
          />
          <View style={s.location}>
            <Body style={s.locationName}>
              {localize(order.restaurant ?? location?.name ?? branch?.name ?? 'Ресторан PickChick')}
            </Body>
            <Caption style={s.mode}>
              {localize(order.snapshot.service_mode === 'takeaway' ? 'С собой' : 'В зале')}
            </Caption>
          </View>
          <GlassButton
            testID="order-more"
            name="ellipsis-horizontal"
            iconSize={25}
            label={localize(more ? 'Закрыть действия заказа' : 'Действия заказа')}
            expanded={more}
            onPress={() => setMore(!more)}
          />
        </Row>
        <ScrollView
          testID="order-status-scroll"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: Math.max(24, insets.bottom + 16), gap: 20 }}
        >
          {notice ? <View style={s.inset}>{notice}</View> : null}
          <View style={s.hero}>
            <View style={[s.badge, ready && s.readyBadge]}>
              <Text
                style={s.badgeText}
                testID="connected-order-number"
                accessibilityLabel={localize(
                  `${order.number ? t('Заказ номер {p0}', { p0: order.number }) : t('Заказ принят')}${name ? `, ${t(name)}` : ''}`,
                )}
              >
                {localize(order.number ? `№ ${order.number}` : 'Заказ принят')}
                {localize(name ? ` · ${name}` : '')}
              </Text>
            </View>
            {order.state !== 'cancelled' ? (
              <OrderChef stage={orderScene(order)} size={heroSize} />
            ) : (
              <View style={{ height: 112, justifyContent: 'center' }}>
                <Icon name="close-circle-outline" size={64} color={colors.muted} />
              </View>
            )}
            <Row style={s.time}>
              <Icon name="time-outline" size={18} color={colors.accent} />
              <Caption style={s.timeText}>{localize(orderTimeLabel(order, now))}</Caption>
            </Row>
            <View accessibilityLiveRegion="polite" style={s.statusText}>
              <Heading style={s.title} testID="connected-order-state">
                {localize(title)}
              </Heading>
              <Body style={s.subtitle}>{localize(subtitle)}</Body>
            </View>
            <View
              style={s.track}
              accessibilityLabel={localize(t('Этап заказа: {p0}', { p0: t(orderStage(order)) }))}
            >
              {['Кухня', 'Сборка', 'Выдача'].map((label, i) => (
                <View key={label} style={s.trackItem}>
                  <View
                    style={[
                      s.trackBar,
                      (ready || (active && i <= (orderStage(order) === 'На сборке' ? 1 : 0))) &&
                        s.trackActive,
                    ]}
                  />
                  <Caption style={s.trackLabel}>{localize(label)}</Caption>
                </View>
              ))}
            </View>
          </View>
          <View testID="order-status-items" style={[s.orderBlock, { marginHorizontal: inset }]}>
            <Row style={s.orderHeader}>
              <Text accessibilityRole="header" style={s.orderTitle}>
                {t('Ваш заказ')}
              </Text>
              <Caption style={s.orderSummary}>
                {t('{p0} поз. · {p1}', {
                  p0: order.snapshot.lines.length,
                  p1: money(order.snapshot.total_minor),
                })}
              </Caption>
            </Row>
            {lineRows}
          </View>
          {afterItems ? (
            <View style={[s.inset, { paddingHorizontal: inset }]}>{afterItems}</View>
          ) : null}
          {active || ready ? (
            <GameCarousel
              title={localize(active ? 'Пока готовим - сыграйте' : 'Ещё один раунд?')}
              games={games}
              inset={inset}
              onOpen={(id) => openOrderGame(router, id, onBeforeGame)}
            />
          ) : null}
          {receipt || onSupport ? (
            <View style={[s.tiles, { paddingHorizontal: inset }]}>
              {receipt ? (
                <ActionTile
                  icon="receipt-outline"
                  label={t('Чек')}
                  caption={receipt.caption}
                  hint={receipt.hint}
                  testID={receipt.testID ?? 'order-receipt'}
                  onPress={receipt.onPress}
                />
              ) : null}
              {onSupport ? (
                <ActionTile
                  icon="chatbox-outline"
                  label={t('Поддержка')}
                  hint="Мы видим, по какому заказу нужна помощь"
                  testID="order-support"
                  onPress={onSupport}
                />
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </View>
      <OrderActions
        visible={more}
        number={order.number ?? '-'}
        onClose={() => setMore(false)}
        onSupport={
          onSupport
            ? () => {
                setMore(false);
                onSupport();
              }
            : undefined
        }
      />
    </View>
  );
}
/** «Чек» / «Поддержка»: an orange icon above the label; a status caption when not tappable. */
function ActionTile({
  icon,
  label,
  caption,
  hint,
  testID,
  onPress,
}: {
  icon: IconName;
  label: string;
  caption?: string;
  hint?: string;
  testID: string;
  onPress?: () => void;
}) {
  useLocale();
  const content = (
    <>
      <Icon name={icon} size={22} color={colors.accent} />
      <Text style={s.tileLabel}>{localize(label)}</Text>
      {caption ? <Text style={s.tileCaption}>{localize(caption)}</Text> : null}
    </>
  );
  if (!onPress)
    return (
      <View
        testID={testID}
        accessible
        accessibilityLabel={localize(caption ? `${label}. ${caption}` : label)}
        style={s.tile}
      >
        {content}
      </View>
    );
  return (
    <MotionPressable
      testID={testID}
      feedback="scale"
      accessibilityRole="button"
      accessibilityLabel={localize(caption ? `${label}. ${caption}` : label)}
      accessibilityHint={localize(hint)}
      onPress={onPress}
      style={s.tile}
    >
      {content}
    </MotionPressable>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  header: { paddingHorizontal: 16, paddingBottom: 12, alignItems: 'center', gap: 12 },
  location: { flex: 1, alignItems: 'center', gap: 2 },
  locationName: { fontFamily: font.medium, fontSize: 16, lineHeight: 22, textAlign: 'center' },
  mode: { fontSize: 12, color: colors.muted },
  inset: { paddingHorizontal: 20, gap: 12 },
  hero: { alignItems: 'center', paddingHorizontal: 20, gap: 10 },
  badge: {
    maxWidth: '100%',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: colors.action,
  },
  readyBadge: { backgroundColor: colors.surface },
  badgeText: {
    fontFamily: font.medium,
    fontSize: 20,
    lineHeight: 28,
    textAlign: 'center',
    color: colors.white,
  },
  time: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.surface,
    maxWidth: '100%',
    gap: 8,
  },
  timeText: { color: colors.text, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  statusText: { alignItems: 'center', gap: 6 },
  title: { fontSize: 30, lineHeight: 37, textAlign: 'center', fontFamily: font.heading },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.muted,
    textAlign: 'center',
    maxWidth: 370,
  },
  track: { flexDirection: 'row', gap: 6, width: '100%', maxWidth: 330, paddingTop: 7 },
  trackItem: { flex: 1, gap: 5 },
  trackBar: { height: 3, borderRadius: 2, backgroundColor: colors.border },
  trackActive: { backgroundColor: colors.accent },
  trackLabel: { fontSize: 11, textAlign: 'center', color: colors.muted },
  orderBlock: {
    paddingHorizontal: 16,
    paddingTop: 13,
    paddingBottom: 5,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  orderHeader: { justifyContent: 'space-between', gap: 12, paddingBottom: 4 },
  orderTitle: { fontFamily: font.bold, fontSize: 15, lineHeight: 21, color: colors.text },
  orderSummary: {
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  linePhoto: {
    width: 44,
    height: 44,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#F6F6F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineImage: { width: '100%', height: '100%' },
  lineCopy: { flex: 1, minWidth: 0, gap: 1 },
  lineName: { fontFamily: font.medium, fontSize: 14, lineHeight: 20, color: colors.text },
  lineDetail: { fontFamily: font.body, fontSize: 12.5, lineHeight: 17, color: colors.muted },
  lineQuantity: {
    fontFamily: font.medium,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.muted,
    fontVariant: ['tabular-nums'],
  },
  linePrice: {
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: {
    flex: 1,
    minHeight: 74,
    paddingHorizontal: 12,
    paddingVertical: 13,
    borderRadius: 18,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  tileLabel: { fontFamily: font.medium, fontSize: 14, lineHeight: 19, color: colors.text },
  tileCaption: {
    fontFamily: font.body,
    fontSize: 12,
    lineHeight: 17,
    color: colors.muted,
    textAlign: 'center',
  },
});
