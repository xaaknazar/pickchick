import { menuPhotos } from '../menu-photo-assets';
import { hasPhotoPilot } from '../product-photo-selection';
import { useReducedMotion } from '../components/Motion';
import { MotionPressable as Pressable, MotionModal } from '../components/Motion';
import { usePublishedContent } from '../backoffice/usePublishedContent';
import { PromotionDialog } from '../backoffice/PromotionDialog';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Animated, {
  runOnJS,
  interpolate,
  interpolateColor,
  Extrapolation,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CartLine, Product, ScreenProps } from '../model';
import { assets } from '../assets';
import { restaurantLocation } from '../restaurant-location';
import {
  cartLineKey,
  cartTotal,
  lineUnitPrice,
  preparationMinutes,
  selectionDescription,
} from '../domain';
import { OrderHeader, OrderTotal, orderUI } from '../components/OrderPresentation';
import { CartOffers, PromoCodeEntry } from '../components/CartExtras';
import { ConfiguredProduct } from './ProductConfiguration';
import { CartShortcut } from '../components/CartShortcut';
import { colors, font } from '../theme';
import { DiningSelector, HeroVideo, LoyaltyCard } from '../components/Brand';
import {
  Body,
  Button,
  Caption,
  Card,
  Empty,
  Heading,
  Icon,
  IconButton,
  Loading,
  Logo,
  MinorMoney,
  NavRow,
  Notice,
  Page,
  ReviewBadge,
  Row,
  SummaryRow,
  styles as ui,
} from '../components/UI';

export function Welcome(props: ScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="screen-M01"
      style={[ui.page, { paddingTop: insets.top, backgroundColor: '#0047BB' }]}
    >
      <Image
        source={assets.mix}
        style={[StyleSheet.absoluteFill, { opacity: 0.65 }]}
        contentFit="cover"
      />
      <ScrollView
        contentContainerStyle={[s.welcome, { paddingBottom: Math.max(insets.bottom, 30) }]}
      >
        <Pressable
          accessibilityRole="button"
          onPress={() => props.navigate('M06')}
          style={{ alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center' }}
        >
          <Body style={{ color: '#FFFFFFAA', fontFamily: font.medium, fontSize: 15 }}>
            Пропустить
          </Body>
        </Pressable>
        <View style={{ flex: 1, justifyContent: 'center', gap: 28, paddingVertical: 30 }}>
          <Logo size={128} />
          <Heading style={s.welcomeHeading}>Куриные фингерсы для тех, кто в движении</Heading>
          <Body style={{ color: '#FFFFFFBF', lineHeight: 24 }}>
            Один продукт, доведённый до пика вкуса. Своё производство, свои соусы.
          </Body>
          {props.preview ? <ReviewBadge /> : null}
        </View>
        <Row style={{ gap: 6, marginBottom: 4 }}>
          <View style={s.dotActive} />
          <View style={s.dot} />
          <View style={s.dot} />
        </Row>
        <Button title="Открыть меню" onPress={() => props.navigate('M06')} testID="welcome-menu" />
        <Button
          title="Войти по номеру"
          secondary
          onPress={() => props.navigate('M02')}
          testID="welcome-login"
        />
      </ScrollView>
    </View>
  );
}
export function Branches(props: ScreenProps) {
  const [mapError, setMapError] = useState(false);
  return (
    <Page props={props} title="Наши рестораны">
      <Heading>Где ваш{`\n`}следующий пик?</Heading>
      <Body muted>Выберите ресторан, чтобы увидеть его меню.</Body>
      {props.model.connection.status === 'loading' ? <Loading title="Ищем рестораны" /> : null}
      {props.model.branches.map((branch) => {
        const location = restaurantLocation(branch.id);
        return (
          <View key={branch.id} style={{ gap: 12 }}>
            <Pressable
              testID={`branch-${branch.id}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: props.model.branch?.id === branch.id }}
              onPress={() => {
                props.model.setBranch(branch.id);
                props.navigate('M06');
              }}
            >
              <Card
                style={
                  props.model.branch?.id === branch.id ? { borderColor: colors.accent } : undefined
                }
              >
                <Row>
                  <View style={ui.flex}>
                    <Heading small>{branch.name}</Heading>
                    {location ? (
                      <Body style={{ marginTop: 8 }}>
                        {location.city}, {location.address}
                      </Body>
                    ) : null}
                    <Caption style={{ marginTop: 7 }}>
                      {branch.ordering_enabled
                        ? 'Приём заказов доступен'
                        : 'Заказы пока недоступны'}
                    </Caption>
                  </View>
                  <Icon
                    name={
                      props.model.branch?.id === branch.id ? 'checkmark-circle' : 'chevron-forward'
                    }
                    color={colors.accent}
                  />
                </Row>
              </Card>
            </Pressable>
            {location ? (
              <Button
                title="Открыть в 2ГИС"
                secondary
                testID={`branch-map-${branch.id}`}
                onPress={() => {
                  setMapError(false);
                  void Linking.openURL(location.map_url).catch(() => setMapError(true));
                }}
              />
            ) : null}
          </View>
        );
      })}
      {mapError ? <Notice warning>Не удалось открыть 2ГИС. Попробуйте ещё раз.</Notice> : null}
      {!props.model.branches.length && props.model.connection.status !== 'loading' ? (
        <Empty
          icon="location-outline"
          title="Не удалось получить рестораны"
          detail="Проверьте подключение и обновите список."
          action={<Button title="Обновить" onPress={props.model.refresh} />}
        />
      ) : null}
      <Notice>При смене ресторана нужно заново проверить состав и цены корзины.</Notice>
    </Page>
  );
}
const ProductMenuCard = memo(function ProductMenuCard({
  product,
  compact,
  singleColumn,
  width,
  fontScale,
  openProduct,
  hit,
}: {
  product: Product;
  compact: boolean;
  singleColumn: boolean;
  width: number;
  fontScale: number;
  openProduct(product: Product): void;
  hit: boolean;
}) {
  return (
    <Pressable
      testID={`product-${product.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${MinorMoney(product.priceMinor)}, выбрать`}
      onPress={() => openProduct(product)}
      style={({ pressed }) => [
        s.product,
        compact && [s.compactProduct, { width: singleColumn ? '100%' : (width - 48) / 2 }],
        !compact && fontScale > 1.3 && { flexDirection: 'column' },
        pressed && ui.pressed,
      ]}
    >
      <View
        testID={`product-photo-${product.id}`}
        style={[s.productPhotoWrap, compact && s.compactPhoto]}
      >
        <Image
          source={menuPhotos[product.id] ?? product.image}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
        {hit ? (
          <View style={s.hit}>
            <Caption style={s.hitText}>ХИТ</Caption>
          </View>
        ) : null}
      </View>
      <View style={s.productInfo}>
        <Heading small style={compact ? s.compactTitle : s.productTitle}>
          {product.name}
        </Heading>
        {!compact ? <Caption style={s.productDescription}>{product.description}</Caption> : null}
        <Row style={s.productPriceRow}>
          <Body style={[s.productPrice, compact && { fontSize: 16 }]}>
            {MinorMoney(product.priceMinor)}
          </Body>
          <View style={compact ? s.productPlus : s.productChoose}>
            {compact ? (
              <Icon name="add" color={colors.orangeInk} size={20} />
            ) : (
              <Body style={s.productChooseText}>Выбрать</Body>
            )}
          </View>
        </Row>
      </View>
    </Pressable>
  );
});
export function Menu(props: ScreenProps) {
  const [cartHeight, setCartHeight] = useState(100);
  const router = useRouter();
  const reduced = useReducedMotion();
  const published = usePublishedContent(props.model.branch?.id);
  const promotion = props.preview ? null : (published.content?.promos[0] ?? null);
  const [promotionOpen, setPromotionOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  // Owner update: lift the storefront; shorter phones still reveal the first dish.
  const heroHeight = Math.round(
    Math.max(260, Math.min(width * 2 - 48, height < 700 ? height * 0.55 : height * 0.93 - 48, 852)),
  );
  const location = restaurantLocation(props.model.branch?.id);
  const scroll = useRef<ScrollView>(null);
  const sectionY = useRef<Record<string, number>>({});
  const [category, setCategory] = useState('Комбо');
  const [collapsed, setCollapsed] = useState(false);
  // Scroll geometry stays on the UI thread; React only sees a category/threshold change.
  const scrollY = useSharedValue(0);
  const offsets = useSharedValue<number[]>([]);
  const requestedCategory = useSharedValue(-1);
  const requestedY = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const chips = useRef<ScrollView>(null);
  const chipLayouts = useRef<Record<string, { x: number; width: number }>>({});
  const [headerHeight, setHeaderHeight] = useState(insets.top + 64);
  const [collapsedHeaderHeight, setCollapsedHeaderHeight] = useState(insets.top + 62);
  const [categoryTop, setCategoryTop] = useState(0);
  const [categoryHeight, setCategoryHeight] = useState(62);
  const [catalogTop, setCatalogTop] = useState(0);
  const categories = useMemo(
    () => [...new Set(props.model.products.map((product) => product.category))],
    [props.model.products],
  );
  const sections = useMemo(
    () =>
      categories.map((name) => ({
        name,
        products: props.model.products.filter((p) => p.category === name),
      })),
    [categories, props.model.products],
  );
  const updateOffsets = () => {
    offsets.value = categories.map((name) => catalogTop + (sectionY.current[name] ?? 0));
  };
  useEffect(updateOffsets, [catalogTop, categories]);
  const selectVisibleCategory = (index: number) => {
    const name = categories[index];
    if (name) setCategory(name);
  };
  useAnimatedReaction(
    () => scrollY.value >= 120,
    (value, previous) => {
      if (value !== previous) runOnJS(setCollapsed)(value);
    },
  );
  useAnimatedReaction(
    () => {
      const y = scrollY.value + collapsedHeaderHeight + categoryHeight + 28;
      if (requestedCategory.value >= 0) {
        if (Math.abs(scrollY.value - requestedY.value) < 5) requestedCategory.value = -1;
        else return requestedCategory.value;
      }
      if (
        contentHeight.value > viewportHeight.value &&
        scrollY.value >= contentHeight.value - viewportHeight.value - 4
      )
        return offsets.value.length - 1;
      let visible = 0;
      for (let i = 0; i < offsets.value.length; i++)
        if ((offsets.value[i] ?? Infinity) <= y) visible = i;
      return visible;
    },
    (index, previous) => {
      if (index !== previous) runOnJS(selectVisibleCategory)(index);
    },
  );
  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
    onBeginDrag: () => {
      requestedCategory.value = -1;
    },
    onMomentumEnd: () => {
      requestedCategory.value = -1;
    },
  });
  const headerStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(scrollY.value, [0, 120], ['#04143A00', '#04143AF5']),
  }));
  const diningStyle = useAnimatedStyle(() => ({
    opacity: reduced
      ? scrollY.value >= 120
        ? 0
        : 1
      : interpolate(scrollY.value, [32, 120], [1, 0], Extrapolation.CLAMP),
    transform: [
      {
        translateY: reduced
          ? 0
          : interpolate(scrollY.value, [32, 120], [0, -10], Extrapolation.CLAMP),
      },
    ],
  }));
  const stickyStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.max(headerHeight, categoryTop - scrollY.value) }],
    opacity: categoryTop ? 1 : 0,
    backgroundColor:
      scrollY.value >= categoryTop - headerHeight ? colors.background : 'transparent',
  }));
  useEffect(() => {
    const layout = chipLayouts.current[category];
    if (layout)
      chips.current?.scrollTo({
        x: Math.max(0, layout.x - (width - layout.width) / 2),
        animated: !reduced,
      });
  }, [category, width, reduced]);
  const openProduct = useCallback(
    (product: Product) => {
      props.model.selectProduct(product.id);
      if (hasPhotoPilot(product.id))
        router.push({
          pathname: '/product-photo',
          params: { product: product.id, ...(props.preview ? { preview: '1' } : {}) },
        });
      else props.navigate('M07');
    },
    [props.model.selectProduct, props.navigate, props.preview, router],
  );
  const categoryBar = (
    <ScrollView
      ref={chips}
      horizontal
      directionalLockEnabled
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.categoryList}
    >
      {categories.map((item) => (
        <Pressable
          key={item}
          testID={`category-${item}`}
          onLayout={(e) => {
            chipLayouts.current[item] = e.nativeEvent.layout;
          }}
          hitSlop={{ top: 4, bottom: 4 }}
          accessibilityRole="tab"
          aria-selected={category === item}
          accessibilityState={{ selected: category === item }}
          onPress={() => {
            requestedCategory.value = categories.indexOf(item);
            setCategory(item);
            const targetY = Math.min(
              Math.max(0, contentHeight.value - viewportHeight.value),
              Math.max(
                0,
                catalogTop + (sectionY.current[item] ?? 0) - collapsedHeaderHeight - categoryHeight,
              ),
            );
            requestedY.value = targetY;
            // Native shared-value writes are scheduled; use the local target for this command.
            scroll.current?.scrollTo({ y: targetY, animated: !reduced });
          }}
          style={({ pressed }) => [s.category, pressed && ui.pressed]}
        >
          <Body style={[s.categoryText, category === item && s.categoryTextSelected]}>
            {item === 'Комбо'
              ? 'Комбо на одного'
              : item === 'На двоих'
                ? 'Комбо на двоих'
                : item === 'На компанию'
                  ? 'Комбо на компанию'
                  : item}
          </Body>
        </Pressable>
      ))}
    </ScrollView>
  );
  return (
    <View testID="screen-M06" style={[ui.page, { overflow: 'hidden' }]}>
      <PromotionDialog
        promotion={promotionOpen ? promotion : null}
        onClose={() => setPromotionOpen(false)}
      />
      <Animated.ScrollView
        ref={scroll}
        testID="scroll-M06"
        style={ui.scroll}
        showsVerticalScrollIndicator={false}
        directionalLockEnabled
        contentContainerStyle={{
          paddingBottom: props.model.cart.length ? (props.cartBottomInset || cartHeight) + 16 : 24,
        }}
        onContentSizeChange={(_, height) => {
          contentHeight.value = height;
        }}
        onLayout={(e) => {
          viewportHeight.value = e.nativeEvent.layout.height;
        }}
        onTouchStart={() => {
          requestedCategory.value = -1;
        }}
        scrollEventThrottle={16}
        onScroll={scrollHandler}
      >
        <View testID="storefront-hero" style={[s.hero, { height: heroHeight }]}>
          <HeroVideo />
          <Pressable
            testID="hero-promotion"
            accessibilityRole="button"
            accessibilityLabel={
              promotion ? promotion.title.ru + ', подробнее' : 'Комбо недели, подробнее'
            }
            onPress={() => {
              if (promotion) {
                setPromotionOpen(true);
                return;
              }
              const combo = props.model.products.find((item) => item.category === 'Комбо');
              if (combo) openProduct(combo);
              else props.navigate('M08');
            }}
            style={[s.heroCaption, { bottom: Math.round(heroHeight * 0.27) }]}
          >
            <Heading style={s.heroTitle}>{promotion?.title.ru ?? 'Комбо недели'}</Heading>
            <Body style={s.heroSubtitle}>подробнее</Body>
          </Pressable>
        </View>
        <View style={[s.loyaltyLead, { marginTop: -Math.round(heroHeight * 0.26) }]}>
          <LoyaltyCard preview={props.preview} onPress={() => props.navigate('M23')} />
        </View>
        <View
          testID="storefront-category-anchor"
          onLayout={(e) => setCategoryTop(e.nativeEvent.layout.y)}
          style={{ height: categoryHeight }}
        />
        <View style={s.menuBody}>
          {props.preview ? <ReviewBadge /> : null}
          {props.model.catalogMode === 'design' ? (
            <Notice title="Образцы меню">
              Блюда и цены из макета. Эта корзина подходит для проверки дизайна; оформить заказ
              нельзя.
            </Notice>
          ) : null}
          {props.model.connection.status === 'loading' && props.model.catalogMode === 'server' ? (
            <Loading />
          ) : null}
          {props.model.connection.status !== 'online' &&
          props.model.catalogMode === 'server' &&
          props.model.connection.status !== 'loading' ? (
            <>
              <Notice warning title="Нет свежего меню">
                {props.model.connection.message ?? 'Проверьте интернет и повторите загрузку.'}
              </Notice>
              <NavRow title="Проверить доступность" onPress={() => props.navigate('M11')} />
            </>
          ) : null}
        </View>
        <View style={s.catalogSections} onLayout={(e) => setCatalogTop(e.nativeEvent.layout.y)}>
          {sections.map(({ name: item, products }) => {
            const compact = ['Допы', 'Напитки', 'Соусы'].includes(item);
            const singleColumn = fontScale > 1.3;
            return (
              <View
                key={item}
                onLayout={(e) => {
                  sectionY.current[item] = e.nativeEvent.layout.y;
                  updateOffsets();
                }}
              >
                <Heading small testID={`category-heading-${item}`} style={s.sectionTitle}>
                  {item}
                </Heading>
                <View style={compact ? s.compactGrid : s.productList}>
                  {products.map((product, index) => (
                    <ProductMenuCard
                      key={product.id}
                      product={product}
                      compact={compact}
                      singleColumn={singleColumn}
                      width={width}
                      fontScale={fontScale}
                      openProduct={openProduct}
                      hit={index === 0 && item === 'Комбо' && props.model.catalogMode === 'design'}
                    />
                  ))}
                </View>
              </View>
            );
          })}
          {!props.model.products.length && props.model.connection.status !== 'loading' ? (
            <Empty
              title="Меню скоро появится"
              detail="Мы готовим каталог этого ресторана."
              action={<Button title="Обновить меню" secondary onPress={props.model.refresh} />}
            />
          ) : null}
        </View>
      </Animated.ScrollView>
      <Animated.View
        testID="storefront-header"
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
        style={[s.heroHeader, { paddingTop: insets.top + 8 }, headerStyle]}
      >
        <View
          onLayout={(e) =>
            setCollapsedHeaderHeight(
              insets.top + 18 + e.nativeEvent.layout.height + StyleSheet.hairlineWidth,
            )
          }
        >
          <Row style={{ gap: 12 }}>
            <Logo size={38} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Выбрать ресторан"
              onPress={() => props.navigate('M05')}
              style={s.branchTitle}
            >
              <Text style={s.brandTitle} numberOfLines={1}>
                {location?.name ?? props.model.branch?.name ?? 'Выбрать ресторан'}
              </Text>
              <Caption style={s.branchCaption}>
                {location?.opening_time && location.closing_time
                  ? `${location.opening_time}-${location.closing_time}`
                  : location?.closing_time
                    ? `до ${location.closing_time}`
                    : 'Часы уточняются'}
              </Caption>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Уведомления"
              testID="storefront-notifications"
              onPress={() => router.push('/notifications')}
              style={({ pressed }) => [s.heroProfile, pressed && s.heroProfilePressed]}
            >
              <Icon name="notifications-outline" size={26} color={colors.white} />
            </Pressable>
          </Row>
        </View>
        <Animated.View
          pointerEvents={collapsed ? 'none' : 'auto'}
          accessibilityElementsHidden={collapsed}
          importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
          style={[
            { position: 'absolute', top: headerHeight + 2, left: 18, right: 18 },
            diningStyle,
          ]}
        >
          <DiningSelector value={props.model.diningMode} onChange={props.model.setDiningMode} />
        </Animated.View>
      </Animated.View>
      <Animated.View
        onLayout={(e) => setCategoryHeight(e.nativeEvent.layout.height)}
        style={[s.stickyCategories, stickyStyle]}
      >
        {categoryBar}
      </Animated.View>
      {!props.inTabLayout ? (
        <CartShortcut
          model={props.model}
          onPress={() => props.navigate('M09')}
          safeArea
          floating
          onHeightChange={setCartHeight}
        />
      ) : null}
    </View>
  );
}
export {
  ProductConfiguration as ProductDetail,
  ProductConfiguration as Combo,
} from './ProductConfiguration';
export function Cart(props: ScreenProps) {
  const insets = useSafeAreaInsets();
  const [clearSnapshot, setClearSnapshot] = useState<{ id: string; quantity: number }[] | null>(
    null,
  );
  const total = cartTotal(props.model.cart);
  const [editing, setEditing] = useState<CartLine | null>(null);
  return (
    <Page
      props={props}
      title="Корзина"
      header={
        <OrderHeader
          title="Корзина"
          testID="cart-close"
          onClose={props.goBack}
          action={
            <IconButton
              name="trash-outline"
              label="Очистить корзину"
              testID="cart-clear"
              disabled={!props.model.cart.length}
              onPress={() =>
                setClearSnapshot(
                  props.model.cart.map((line) => ({
                    id: cartLineKey(line),
                    quantity: line.quantity,
                  })),
                )
              }
              color={colors.muted}
            />
          }
        />
      }
      footer={
        props.model.cart.length ? (
          <>
            <Button
              title={`Оформить заказ на ${MinorMoney(total).replace(/ /g, '\u00a0')}`}
              onPress={() => props.navigate('M12')}
              testID="cart-checkout"
              style={orderUI.action}
              textStyle={orderUI.actionText}
            />
          </>
        ) : null
      }
    >
      <MotionModal
        visible={editing !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setEditing(null)}
      >
        {editing ? (
          <ConfiguredProduct
            {...props}
            key={cartLineKey(editing)}
            product={editing.product}
            editing={editing}
            goBack={() => setEditing(null)}
            onSave={(selections, quantity) => {
              props.model.replaceCartLine(editing, selections, quantity);
              setEditing(null);
            }}
          />
        ) : null}
      </MotionModal>
      <MotionModal
        visible={clearSnapshot !== null}
        transparent
        onRequestClose={() => setClearSnapshot(null)}
      >
        <ScrollView
          contentContainerStyle={[
            s.clearBackdrop,
            { paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom) },
          ]}
        >
          <View testID="cart-clear-dialog" accessibilityViewIsModal style={s.clearCard}>
            <Heading small>Очистить корзину?</Heading>
            <Body muted>Все выбранные блюда и добавки будут удалены из корзины.</Body>
            <Button
              title="Оставить заказ"
              testID="cart-clear-cancel"
              onPress={() => setClearSnapshot(null)}
            />
            <Button
              title="Очистить корзину"
              secondary
              testID="cart-clear-confirm"
              onPress={() => {
                if (clearSnapshot) props.model.clearCart(clearSnapshot);
                setClearSnapshot(null);
              }}
            />
          </View>
        </ScrollView>
      </MotionModal>
      {!props.model.cart.length ? (
        <Empty
          title="Здесь пока тихо"
          detail="Добавьте любимые блюда - и станет хрустяще."
          action={<Button title="Выбрать в меню" onPress={() => props.navigate('M06')} />}
        />
      ) : (
        <>
          <Row style={s.cartFulfilment}>
            <Icon name="bag-handle-outline" size={16} color={colors.accent} />
            <Body style={[orderUI.detail, { fontFamily: font.medium, flexShrink: 1 }]}>
              {props.model.diningMode === 'takeaway' ? 'С собой' : 'В зале'} · Приготовим за ~
              {preparationMinutes(props.model.cart)} мин
            </Body>
          </Row>
          {props.model.catalogMode === 'design' ? (
            <Notice warning>Это корзина из образцов дизайна. Заказ и оплата недоступны.</Notice>
          ) : null}
          {props.model.cart.map((line) => (
            <View key={cartLineKey(line)} style={s.cartLine}>
              <View style={s.cartProduct}>
                <Image source={line.product.image} style={s.cartImage} contentFit="contain" />
                <View style={ui.flex}>
                  <Heading small style={[orderUI.label, { fontFamily: font.bold }]}>
                    {line.product.name}
                  </Heading>
                  <Caption style={[orderUI.detail, { marginTop: 4 }]}>
                    {selectionDescription(line) || line.product.description}
                  </Caption>
                  <Pressable
                    testID={`cart-edit-${line.product.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Изменить ${line.product.name}`}
                    onPress={() => setEditing(line)}
                    style={{ minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' }}
                  >
                    <Body
                      style={[orderUI.detail, { color: colors.accent, fontFamily: font.medium }]}
                    >
                      Изменить
                    </Body>
                  </Pressable>
                </View>
              </View>
              <Row
                style={{
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                  marginTop: 0,
                }}
              >
                <Row style={s.stepper}>
                  <IconButton
                    name="remove"
                    label={
                      line.quantity === 1
                        ? `Удалить ${line.product.name}`
                        : `Уменьшить ${line.product.name}`
                    }
                    testID={`cart-minus-${line.product.id}`}
                    onPress={() => props.model.setQuantity(cartLineKey(line), line.quantity - 1)}
                  />
                  <Body
                    testID={`cart-quantity-${line.product.id}`}
                    style={[
                      orderUI.label,
                      { minWidth: 24, textAlign: 'center', fontVariant: ['tabular-nums'] },
                    ]}
                  >
                    {line.quantity}
                  </Body>
                  <IconButton
                    name="add"
                    label={`Добавить ещё ${line.product.name}`}
                    testID={`cart-plus-${line.product.id}`}
                    disabled={line.quantity >= 20}
                    onPress={() => props.model.setQuantity(cartLineKey(line), line.quantity + 1)}
                  />
                </Row>
                <Body style={orderUI.amount}>
                  {MinorMoney(BigInt(lineUnitPrice(line)) * BigInt(line.quantity))}
                </Body>
              </Row>
            </View>
          ))}
          <CartOffers props={props} />
          <PromoCodeEntry />
          <View style={{ gap: 12, paddingVertical: 8 }}>
            <Heading small style={orderUI.section}>
              Детали
            </Heading>
            <SummaryRow
              label={`Блюда · ${props.model.cart.reduce((sum, line) => sum + line.quantity, 0)} шт.`}
              value={MinorMoney(total)}
            />
            <OrderTotal value={MinorMoney(total)} />
            <Caption style={orderUI.detail}>
              Чики за покупки появятся после подключения программы.
            </Caption>
          </View>
          <Button
            title="Добавить ещё что-нибудь"
            textStyle={orderUI.actionText}
            secondary
            icon="add"
            onPress={() => props.navigate('M06')}
          />
          <Caption style={orderUI.detail}>
            Окончательную цену и доступность подтвердит ресторан при оформлении.
          </Caption>
        </>
      )}
    </Page>
  );
}
export function ChangedCart(props: ScreenProps) {
  return (
    <Page props={props} title="Меню обновилось">
      <View style={s.largeIcon}>
        <Icon name="refresh" size={42} color={colors.accent} />
      </View>
      <Heading>Давайте проверим{`\n`}корзину</Heading>
      <Body muted>Цены и наличие могли измениться. Мы ничего не заменяем без вашего решения.</Body>
      {props.preview ? (
        <Card>
          <Caption>ПРИМЕР ИЗМЕНЕНИЯ</Caption>
          <Heading small>Pick Combo</Heading>
          <SummaryRow label="Было" value="3 490 ₸" />
          <SummaryRow label="Стало" value="3 590 ₸" />
          <Notice warning>Новая цена показана для проверки макета.</Notice>
        </Card>
      ) : (
        <Notice>
          {props.model.connection.message ??
            'Корзина сверяется с текущей версией меню. При смене версии её нужно собрать заново; новый состав и цену подтвердит сервер при оформлении.'}
        </Notice>
      )}
      <Button title="Вернуться в корзину" onPress={() => props.navigate('M09')} />
      <Button title="Посмотреть меню" secondary onPress={() => props.navigate('M06')} />
    </Page>
  );
}
export function Unavailable(props: ScreenProps) {
  const online = props.model.connection.status === 'online';
  const testAvailable = props.model.testFlow.available;
  return (
    <Page props={props} title="Доступность ресторана">
      <Empty
        icon="storefront-outline"
        title={
          testAvailable
            ? 'Можно оформить заказ'
            : online
              ? 'Приём заказов пока недоступен'
              : 'Доступность пока не подтверждена'
        }
        detail={
          testAvailable
            ? 'Заказ поступит на кухню. Оплата и чеки - в процессе подключения.'
            : 'Сбой загрузки не означает отмену заказа. Ваша корзина и прежний сеанс остаются на устройстве.'
        }
        action={<Button title="Выбрать ресторан" onPress={() => props.navigate('M05')} />}
      />
      <Card>
        <Heading small>{props.model.branch?.name ?? 'Pick Chick'}</Heading>
        <Body muted>
          {props.model.connection.message ??
            (online ? 'Состояние меню получено с сервера' : 'Проверьте связь и повторите загрузку')}
        </Body>
        {props.model.connection.status === 'loading' ? (
          <Loading title="Проверяем доступность" />
        ) : null}
        <Button title="Обновить доступность" secondary onPress={props.model.refresh} />
        <Button title="Вернуться в меню" onPress={() => props.navigate('M06')} />
      </Card>
    </Page>
  );
}
export { Checkout } from './CheckoutScreen';
const s = StyleSheet.create({
  clearBackdrop: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#00000099',
  },
  clearCard: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    borderRadius: 24,
    padding: 24,
    gap: 16,
    backgroundColor: colors.surface,
  },
  welcome: { flexGrow: 1, paddingHorizontal: 26, gap: 14 },
  welcomeHeading: {
    fontFamily: font.display,
    fontSize: 36,
    lineHeight: 39,
    letterSpacing: -0.72,
    color: colors.white,
  },
  dotActive: { width: 24, height: 4, borderRadius: 4, backgroundColor: colors.accent },
  dot: { width: 7, height: 4, borderRadius: 4, backgroundColor: '#7897CA' },
  hero: { backgroundColor: colors.background, overflow: 'hidden' },
  heroHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 18,
    paddingBottom: 10,
    gap: 12,
    zIndex: 10,
  },
  heroHeaderCollapsed: {
    backgroundColor: '#04143AF5',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  branchTitle: { flex: 1, alignItems: 'flex-start', minHeight: 48, justifyContent: 'center' },
  brandTitle: {
    fontFamily: font.medium,
    fontSize: 17,
    lineHeight: 23,
    textAlign: 'left',
    color: colors.white,
  },
  branchCaption: { fontSize: 13, lineHeight: 18, color: '#FFFFFFDD', textAlign: 'left' },
  heroProfile: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0B2454D9',
    borderWidth: 1,
    borderColor: '#FFFFFF66',
    boxShadow: '0 4px 14px rgba(0, 8, 30, 0.24)',
  },
  heroProfilePressed: {
    backgroundColor: '#23467CEB',
    transform: [{ scale: 0.96 }],
  },
  heroCaption: {
    position: 'absolute',
    left: 24,
    right: 24,
    gap: 6,
    alignItems: 'center',
    minHeight: 54,
  },
  heroTitle: {
    fontFamily: font.medium,
    fontSize: 28,
    lineHeight: 36,
    letterSpacing: -0.68,
    color: colors.white,
    textAlign: 'center',
    textShadowColor: '#04143A88',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 18,
  },
  heroSubtitle: { fontSize: 14, lineHeight: 20, color: '#FFFFFFD9', textAlign: 'center' },
  loyaltyLead: { paddingHorizontal: 24, paddingBottom: 8 },
  menuBody: { paddingHorizontal: 24, paddingTop: 0, paddingBottom: 12, gap: 16 },
  stickyCategories: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9 },
  categoryList: {
    gap: 24,
    paddingVertical: 8,
    paddingHorizontal: 24,
  },
  category: {
    minHeight: 48,
    justifyContent: 'center',
  },
  categoryText: {
    fontSize: 20,
    lineHeight: 28,
    fontFamily: font.medium,
    color: '#FFFFFFA6',
  },
  categoryTextSelected: { color: colors.white },
  catalogSections: { paddingHorizontal: 18, gap: 26 },
  sectionTitle: {
    fontFamily: font.display,
    fontSize: 24,
    lineHeight: 30,
    marginBottom: 12,
    letterSpacing: -0.36,
  },
  productList: { gap: 12 },
  product: {
    flexDirection: 'row',
    gap: 12,
    borderRadius: 24,
    padding: 12,
    borderWidth: 1,
    borderColor: '#FFFFFF12',
    backgroundColor: colors.surface,
  },
  productPhotoWrap: {
    width: 112,
    height: 132,
    flexShrink: 0,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#FFF8EE',
  },
  productInfo: { flex: 1, minWidth: 0, gap: 6 },
  productTitle: { fontFamily: font.heading, fontSize: 19, lineHeight: 25, letterSpacing: -0.19 },
  productDescription: { fontSize: 14, lineHeight: 20 },
  productPriceRow: {
    marginTop: 'auto',
    paddingTop: 8,
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  productPrice: {
    fontFamily: font.display,
    fontSize: 20,
    lineHeight: 28,
    fontVariant: ['tabular-nums'],
    color: colors.text,
  },
  productChoose: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: colors.accent,
    justifyContent: 'center',
  },
  productChooseText: {
    fontFamily: font.bold,
    fontSize: 14,
    lineHeight: 20,
    color: colors.orangeInk,
  },
  productPlus: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hit: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: colors.accent,
  },
  hitText: { color: colors.orangeInk, fontFamily: font.bold, fontSize: 12, lineHeight: 16 },
  compactGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  compactProduct: { flexDirection: 'column', padding: 10, borderRadius: 24, gap: 12 },
  compactPhoto: { width: '100%', height: 'auto', aspectRatio: 1, borderRadius: 14 },
  compactTitle: { fontFamily: font.heading, fontSize: 17, lineHeight: 24 },
  productClose: {
    position: 'absolute',
    right: 16,
    backgroundColor: '#FFFFFFE6',
    width: 44,
    height: 44,
  },
  detailBody: { paddingVertical: 20, paddingHorizontal: 18, gap: 16 },
  extraPhoto: { flex: 1, height: 122, borderRadius: 20, overflow: 'hidden' },
  comboPhoto: { width: '100%', height: 242, borderRadius: 24 },
  choiceImage: { width: 54, height: 54, borderRadius: 12 },
  cartFulfilment: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    justifyContent: 'center',
    gap: 8,
  },
  cartLine: {
    gap: 12,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cartProduct: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  upsell: { width: 130, borderRadius: 18, padding: 10, gap: 8, backgroundColor: colors.surface },
  cartImage: { width: 84, height: 84, borderRadius: 12 },
  stepper: { backgroundColor: colors.raised, borderRadius: 22, alignSelf: 'flex-start', gap: 0 },
  largeIcon: {
    width: 94,
    height: 94,
    borderRadius: 31,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
});
