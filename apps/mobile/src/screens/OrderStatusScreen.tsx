import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import type { TestOrder } from '@pickchick/test-order-flow/contracts';
import type { ScreenProps } from '../model';
import { Body, Caption, Heading, Icon, NavRow, Row, Button, styles as ui } from '../components/UI';
import { MotionPressable } from '../components/Motion';
import { OrderActions } from '../components/OrderActions';
import { OrderChef } from '../components/OrderChef';
import { assets } from '../assets';
import { colors, font } from '../theme';
import { money } from '../domain';
import { restaurantLocation } from '../restaurant-location';
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
  const [more, setMore] = useState(false);
  const [details, setDetails] = useState(false);
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
    setDetails(false);
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
            : 'Жарим, собираем и следим за каждой деталью';
  const itemCount = order.snapshot.lines.reduce((sum, line) => sum + line.quantity, 0);
  const cardWidth = Math.min(380, width - (order.snapshot.lines.length > 1 ? 60 : 40));
  const lineCards = order.snapshot.lines.map((line) => {
    const product = props.model.products.find((p) => p.id === line.id);
    const description =
      'selections' in line && line.selections.length
        ? line.selections
            .map((s) => s.option_label + (s.quantity > 1 ? ` ×${s.quantity}` : ''))
            .join(' · ')
        : 'serving_label' in line
          ? line.serving_label
          : line.description;
    return (
      <View
        key={'line_id' in line ? line.line_id : line.id}
        style={[s.foodCard, { width: cardWidth }]}
      >
        <View style={s.foodMain}>
          <View style={s.foodVisual}>
            {product ? (
              <Image
                source={product.image}
                contentFit="contain"
                style={s.foodImage}
                accessibilityLabel={line.name}
              />
            ) : (
              <Icon name="restaurant-outline" size={32} color={colors.muted} />
            )}
          </View>
          <View style={s.foodCopy}>
            <Body style={s.foodName}>{line.name}</Body>
            <Row style={s.foodBottom}>
              <Text style={s.foodPrice}>{money(line.line_total_minor)}</Text>
              <Text style={s.quantity}>{line.quantity} шт.</Text>
            </Row>
          </View>
        </View>
        {description ? (
          <View style={s.foodOptions}>
            <Caption style={s.foodDetail}>{description}</Caption>
          </View>
        ) : null}
      </View>
    );
  });
  return (
    <View style={s.root} testID={`screen-${props.screenId}`}>
      <View
        style={{ flex: 1 }}
        aria-hidden={more}
        accessibilityElementsHidden={more}
        importantForAccessibility={more ? 'no-hide-descendants' : 'auto'}
      >
        <Row style={s.header}>
          <MotionPressable
            testID="order-more"
            accessibilityRole="button"
            accessibilityLabel={more ? 'Закрыть действия заказа' : 'Действия заказа'}
            accessibilityState={{ expanded: more }}
            onPress={() => setMore(!more)}
            style={s.iconButton}
          >
            <Icon name="ellipsis-horizontal" size={25} />
          </MotionPressable>
          <View style={s.location}>
            <Body style={s.locationName}>
              {location?.name ?? branch?.name ?? 'Ресторан PickChick'}
            </Body>
            <Caption style={s.mode}>
              {order.snapshot.service_mode === 'takeaway' ? 'С собой' : 'В зале'}
            </Caption>
          </View>
          <MotionPressable
            testID="order-status-close"
            accessibilityRole="button"
            accessibilityLabel="Закрыть статус заказа"
            onPress={props.goBack}
            style={s.iconButton}
          >
            <Icon name="close" size={28} />
          </MotionPressable>
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
                accessibilityLabel={`Заказ номер ${order.number}${name ? `, ${name}` : ''}`}
              >
                {order.number}
                {name ? ` · ${name}` : ''}
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
              <Caption style={s.timeText}>{orderTimeLabel(order, now)}</Caption>
            </Row>
            <View accessibilityLiveRegion="polite" style={s.statusText}>
              <Heading style={s.title} testID="connected-order-state">
                {title}
              </Heading>
              <Body style={s.subtitle}>{subtitle}</Body>
            </View>
            <View style={s.track} accessibilityLabel={`Этап заказа: ${orderStage(order)}`}>
              {['Кухня', 'Сборка', 'Выдача'].map((label, i) => (
                <View key={label} style={s.trackItem}>
                  <View
                    style={[
                      s.trackBar,
                      (ready || (active && i <= (orderStage(order) === 'На сборке' ? 1 : 0))) &&
                        s.trackActive,
                    ]}
                  />
                  <Caption style={s.trackLabel}>{label}</Caption>
                </View>
              ))}
            </View>
          </View>
          {active || details ? (
            <View style={s.itemsSection}>
              <Row style={s.itemsHeader}>
                <Heading style={s.itemsTitle}>Ваш заказ</Heading>
                <Caption style={s.itemsCount}>{itemCount} шт.</Caption>
              </Row>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.foodList}
                snapToInterval={cardWidth + 12}
                decelerationRate="fast"
                testID="order-status-items"
              >
                {lineCards}
              </ScrollView>
            </View>
          ) : (
            <View style={s.inset}>
              <NavRow
                title="Состав заказа"
                subtitle={`${order.snapshot.lines.reduce((sum, l) => sum + l.quantity, 0)} шт. · ${money(order.snapshot.total_minor)}`}
                onPress={() => setDetails(true)}
              />
            </View>
          )}
          {order.state === 'fulfilled' ? (
            <View style={s.inset}>
              <Button
                title="Оценить заказ"
                testID="order-rate"
                onPress={() => props.navigate('M35')}
              />
            </View>
          ) : null}
          {active || ready ? (
            <MotionPressable
              testID="order-play-blocks"
              accessibilityRole="button"
              accessibilityLabel={
                active ? 'Пока готовим, сыграйте в Pick Blocks' : 'Сыграть в Pick Blocks'
              }
              onPress={() => router.push('/games/pick-blocks')}
              style={s.game}
            >
              <Image
                source={assets.pickBlocksCover}
                contentFit="cover"
                style={StyleSheet.absoluteFill}
              />
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, gameShade]} />
              <View style={s.gameIntro}>
                <Icon name="game-controller-outline" size={16} color={colors.white} />
                <Caption style={s.gameIntroText}>
                  {active ? 'Пока готовим' : 'Ещё один раунд?'}
                </Caption>
              </View>
              <View style={s.gameCopy}>
                <View style={s.gameHeading}>
                  <Heading style={s.gameTitle}>Pick Blocks</Heading>
                  <Caption style={s.gameDetail}>Соберите свой рекорд</Caption>
                </View>
                <Row style={s.play}>
                  <Body style={s.playText}>Играть</Body>
                  <Icon name="arrow-forward" color={colors.orangeInk} size={18} />
                </Row>
              </View>
            </MotionPressable>
          ) : null}
          <View style={s.bottom}>
            <NavRow
              title="Официальный чек"
              subtitle="Чеки и оплата в процессе"
              testID="order-receipt"
              onPress={() => props.navigate('M21')}
            />
            <NavRow
              title="Написать в поддержку"
              subtitle="Мы видим, по какому заказу нужна помощь"
              testID="order-support"
              onPress={() => props.navigate('M31')}
            />
            {location ? (
              <View style={s.address}>
                <Icon name="location-outline" color={colors.accent} />
                <View style={ui.flex}>
                  <Body style={s.foodName}>{location.address}</Body>
                  <Caption style={s.foodDetail}>
                    {location.city} ·{' '}
                    {order.snapshot.service_mode === 'takeaway'
                      ? 'Заберите с собой'
                      : 'Ждём вас в зале'}
                  </Caption>
                </View>
              </View>
            ) : null}
          </View>
        </ScrollView>
      </View>
      <OrderActions
        visible={more}
        number={order.number}
        onClose={() => setMore(false)}
        onSupport={() => {
          setMore(false);
          props.navigate('M31');
        }}
      />
    </View>
  );
}
const gameGradient =
  'linear-gradient(180deg, rgba(2,10,30,0.06) 0%, rgba(2,10,30,0.02) 35%, rgba(2,10,30,0.65) 62%, rgba(2,10,30,0.98) 100%)';
const gameShade = (
  Platform.OS === 'web'
    ? { backgroundImage: gameGradient }
    : { experimental_backgroundImage: gameGradient }
) as ViewStyle;
const s = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  header: { paddingHorizontal: 16, paddingBottom: 12, alignItems: 'center', gap: 12 },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  itemsSection: { gap: 12 },
  itemsHeader: { paddingHorizontal: 20, justifyContent: 'space-between', gap: 12 },
  itemsTitle: { fontSize: 20, lineHeight: 26 },
  itemsCount: { fontSize: 13, color: colors.muted },
  foodList: { paddingHorizontal: 20, gap: 12, alignItems: 'flex-start' },
  foodCard: {
    padding: 12,
    borderRadius: 20,
    backgroundColor: colors.surface,
    gap: 12,
  },
  foodMain: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  foodVisual: {
    width: 92,
    height: 92,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#F6F6F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  foodImage: { width: '100%', height: '100%' },
  foodCopy: { flex: 1, gap: 12 },
  foodName: { fontFamily: font.bold, fontSize: 16, lineHeight: 22 },
  foodOptions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 10,
  },
  foodDetail: { fontSize: 13, lineHeight: 19, color: colors.muted },
  foodBottom: { flexWrap: 'wrap', gap: 10 },
  quantity: { fontFamily: font.medium, color: colors.muted, fontSize: 13 },
  foodPrice: { fontFamily: font.bold, fontSize: 16, lineHeight: 22, color: colors.text },
  game: {
    marginHorizontal: 20,
    borderRadius: 24,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    minHeight: 248,
    justifyContent: 'space-between',
    padding: 16,
    gap: 96,
  },
  gameIntro: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: '#020A1EDD',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  gameIntroText: { color: colors.white, fontSize: 12, lineHeight: 18 },
  gameCopy: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  gameHeading: { flex: 1, minWidth: 128, gap: 4 },
  gameTitle: { color: colors.white, fontSize: 24, lineHeight: 30 },
  gameDetail: { color: '#D5DDF0', fontSize: 12, lineHeight: 18 },
  play: {
    backgroundColor: colors.accent,
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 24,
    gap: 6,
  },
  playText: { fontFamily: font.bold, fontSize: 14, color: colors.orangeInk },
  bottom: { paddingHorizontal: 20, gap: 12 },
  address: { flexDirection: 'row', gap: 12, paddingVertical: 16 },
});
