import { useEffect, useMemo, useRef, useState } from 'react';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Product, ScreenProps } from '../model';
import { assets } from '../assets';
import { restaurantLocation } from '../restaurant-location';
import {
  cartLineKey,
  defaultSelections,
  cartTotal,
  lineUnitPrice,
  preparationMinutes,
  selectionDescription,
} from '../domain';
import { PaymentChoice } from '../components/PaymentChoice';
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
export function Menu(props: ScreenProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // Owner screenshot: about twice the phone width, fitting short screens too.
  const heroHeight = Math.round(Math.min(width * 2, height * 0.93, 900));
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
    () => scrollY.value > 100,
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
        animated: true,
      });
  }, [category, width]);
  function openProduct(product: Product) {
    props.model.selectProduct(product.id);
    props.navigate('M07');
  }
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
            scroll.current?.scrollTo({ y: targetY, animated: true });
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
      <Animated.ScrollView
        ref={scroll}
        testID="scroll-M06"
        style={ui.scroll}
        showsVerticalScrollIndicator={false}
        directionalLockEnabled
        contentContainerStyle={{ paddingBottom: 24 }}
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
            accessibilityLabel="Комбо недели, подробнее"
            onPress={() => {
              const combo = props.model.products.find((item) => item.category === 'Комбо');
              if (combo) openProduct(combo);
              else props.navigate('M08');
            }}
            style={[s.heroCaption, { bottom: Math.round(heroHeight * 0.27) }]}
          >
            <Heading style={s.heroTitle}>Комбо недели</Heading>
            <Body style={s.heroSubtitle}>подробнее</Body>
          </Pressable>
        </View>
        <View
          testID="storefront-category-anchor"
          onLayout={(e) => setCategoryTop(e.nativeEvent.layout.y)}
          style={{ height: categoryHeight, marginTop: -Math.round(heroHeight * 0.26) }}
        />
        <View style={s.menuBody}>
          <LoyaltyCard preview={props.preview} onPress={() => props.navigate('M23')} />
          {props.preview ? <ReviewBadge /> : null}
          {props.model.testFlow.available && props.model.testFlow.current ? (
            <NavRow
              title={`Заказ ${props.model.testFlow.current.number}`}
              subtitle="Посмотреть актуальный статус кухни"
              onPress={() => props.navigate('M20')}
            />
          ) : null}
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
                    <Pressable
                      key={product.id}
                      testID={`product-${product.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={`${product.name}, ${MinorMoney(product.priceMinor)}, выбрать`}
                      onPress={() => openProduct(product)}
                      style={({ pressed }) => [
                        s.product,
                        compact && [s.compactProduct, { width: (width - 48) / 2 }],
                        pressed && ui.pressed,
                      ]}
                    >
                      <View
                        testID={`product-photo-${product.id}`}
                        style={[s.productPhotoWrap, compact && s.compactPhoto]}
                      >
                        <Image
                          source={product.image}
                          style={StyleSheet.absoluteFill}
                          contentFit="cover"
                        />
                        {index === 0 && item === 'Комбо' && props.model.catalogMode === 'design' ? (
                          <View style={s.hit}>
                            <Caption style={s.hitText}>ХИТ</Caption>
                          </View>
                        ) : null}
                      </View>
                      <View style={s.productInfo}>
                        <Heading small style={compact ? s.compactTitle : s.productTitle}>
                          {product.name}
                        </Heading>
                        {!compact ? (
                          <Caption style={s.productDescription}>{product.description}</Caption>
                        ) : null}
                        <Row style={s.productPriceRow}>
                          <Body style={[s.productPrice, compact && { fontSize: 16 }]}>
                            {MinorMoney(product.priceMinor)}
                          </Body>
                          <View style={compact ? s.productPlus : s.productChoose}>
                            {compact ? (
                              <Icon name="add" color={colors.white} size={20} />
                            ) : (
                              <Body style={s.productChooseText}>Выбрать</Body>
                            )}
                          </View>
                        </Row>
                      </View>
                    </Pressable>
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
      <View
        testID="storefront-header"
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
        style={[s.heroHeader, { paddingTop: insets.top + 8 }, collapsed && s.heroHeaderCollapsed]}
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
                  ? `${location.opening_time}–${location.closing_time}`
                  : location?.closing_time
                    ? `до ${location.closing_time}`
                    : 'Часы уточняются'}
              </Caption>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Профиль"
              testID="storefront-profile"
              onPress={() => props.navigate('M30')}
              style={({ pressed }) => [s.heroProfile, pressed && s.heroProfilePressed]}
            >
              <Icon name="person-outline" size={26} color={colors.white} />
            </Pressable>
          </Row>
        </View>
        {!collapsed ? (
          <DiningSelector value={props.model.diningMode} onChange={props.model.setDiningMode} />
        ) : null}
      </View>
      <Animated.View
        onLayout={(e) => setCategoryHeight(e.nativeEvent.layout.height)}
        style={[s.stickyCategories, stickyStyle]}
      >
        {categoryBar}
      </Animated.View>
      {!props.inTabLayout ? (
        <CartShortcut model={props.model} onPress={() => props.navigate('M09')} safeArea />
      ) : null}
    </View>
  );
}
export {
  ProductConfiguration as ProductDetail,
  ProductConfiguration as Combo,
} from './ProductConfiguration';
export function Cart(props: ScreenProps) {
  const total = cartTotal(props.model.cart);
  return (
    <Page
      props={props}
      title="Корзина"
      header={
        <Row style={s.cartHeader}>
          <IconButton
            name="chevron-back"
            label="Назад"
            onPress={props.goBack}
            style={s.cartHeaderButton}
            color="#9DC0FF"
          />
          <Pressable
            onPress={() => props.navigate('M05')}
            accessibilityRole="button"
            accessibilityLabel="Выбрать ресторан"
            style={s.branchTitle}
          >
            <Heading style={s.brandTitle}>Pick Chick</Heading>
            <Caption style={s.branchCaption}>
              {props.model.branch?.name ?? 'Выбрать ресторан'} · корзина
            </Caption>
          </Pressable>
          <IconButton
            name="trash-outline"
            label="Очистить корзину"
            onPress={() => props.model.clearCart()}
            style={s.cartHeaderButton}
            color="#FF6B6E"
          />
        </Row>
      }
      footer={
        props.model.cart.length ? (
          <>
            <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <PaymentChoice model={props.model} />
              <View style={{ alignItems: 'flex-end' }}>
                <Caption>К оплате</Caption>
                <Heading small>{MinorMoney(total)}</Heading>
              </View>
            </Row>
            <Button
              title="К оформлению"
              onPress={() => props.navigate('M12')}
              testID="cart-checkout"
            />
          </>
        ) : null
      }
    >
      {!props.model.cart.length ? (
        <Empty
          title="Здесь пока тихо"
          detail="Добавьте любимые блюда — и станет хрустяще."
          action={<Button title="Выбрать в меню" onPress={() => props.navigate('M06')} />}
        />
      ) : (
        <>
          <Row style={s.cartFulfilment}>
            <Icon name="bag-handle-outline" size={16} color={colors.accent} />
            <Body style={{ fontSize: 13.5, fontFamily: font.medium }}>
              {props.model.diningMode === 'takeaway' ? 'Заберу сам' : 'В зале'} · Приготовим за ~
              {preparationMinutes(props.model.cart)} мин
            </Body>
          </Row>
          {props.model.catalogMode === 'design' ? (
            <Notice warning>Это корзина из образцов дизайна. Заказ и оплата недоступны.</Notice>
          ) : null}
          {props.model.cart.map((line) => (
            <View key={cartLineKey(line)} style={s.cartLine}>
              <Image source={line.product.image} style={s.cartImage} contentFit="cover" />
              <View style={ui.flex}>
                <Heading small style={{ fontSize: 17, lineHeight: 22 }}>
                  {line.product.name}
                </Heading>
                <Caption style={{ fontSize: 12, lineHeight: 17, marginTop: 4 }}>
                  {selectionDescription(line) || line.product.description}
                </Caption>
                <Row
                  style={{
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginTop: 10,
                  }}
                >
                  <Row style={s.stepper}>
                    <IconButton
                      style={{ width: 44, height: 44 }}
                      name={line.quantity === 1 ? 'trash-outline' : 'remove'}
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
                      style={{ minWidth: 16, textAlign: 'center', fontFamily: font.bold }}
                    >
                      {line.quantity}
                    </Body>
                    <IconButton
                      style={{ width: 44, height: 44 }}
                      name="add"
                      label={`Добавить ещё ${line.product.name}`}
                      testID={`cart-plus-${line.product.id}`}
                      disabled={line.quantity >= 20}
                      onPress={() => props.model.setQuantity(cartLineKey(line), line.quantity + 1)}
                    />
                  </Row>
                  <Body style={{ fontFamily: font.display, fontSize: 17 }}>
                    {MinorMoney(BigInt(lineUnitPrice(line)) * BigInt(line.quantity))}
                  </Body>
                </Row>
              </View>
            </View>
          ))}
          <View style={{ gap: 12 }}>
            <Heading small style={{ fontSize: 21, lineHeight: 28 }}>
              Всегда кстати
            </Heading>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 11, paddingBottom: 4 }}
            >
              {props.model.upsellProductIds
                .flatMap((id) => {
                  const product = props.model.products.find((p) => p.id === id);
                  return product ? [product] : [];
                })
                .map((product) => {
                  const selections = defaultSelections(product);
                  const existing = props.model.cart.find(
                    (line) => cartLineKey(line) === cartLineKey({ product, selections }),
                  );
                  const disabled = existing
                    ? existing.quantity >= 20
                    : props.model.cart.length >= 11;
                  return (
                    <Pressable
                      key={product.id}
                      testID={`upsell-${product.id}`}
                      disabled={disabled}
                      accessibilityState={{ disabled }}
                      accessibilityRole="button"
                      accessibilityLabel={`Добавить ${product.name}, ${MinorMoney(product.priceMinor)}`}
                      onPress={() => props.model.addToCart(product.id)}
                      style={({ pressed }) => [
                        s.upsell,
                        disabled && ui.disabled,
                        pressed && ui.pressed,
                      ]}
                    >
                      <Image
                        source={product.image}
                        style={{ width: '100%', aspectRatio: 1, borderRadius: 12 }}
                        contentFit="cover"
                      />
                      <Body style={{ fontSize: 13, lineHeight: 19, fontFamily: font.medium }}>
                        {product.name}
                      </Body>
                      <Row
                        style={{
                          marginTop: 'auto',
                          flexWrap: 'wrap',
                          gap: 4,
                          justifyContent: 'space-between',
                        }}
                      >
                        <Body style={{ fontFamily: font.display, fontSize: 15 }}>
                          {MinorMoney(product.priceMinor)}
                        </Body>
                        <View style={[s.productPlus, { width: 28, height: 28 }]}>
                          <Icon name="add" size={19} color={colors.white} />
                        </View>
                      </Row>
                    </Pressable>
                  );
                })}
            </ScrollView>
          </View>
          <View
            style={{ backgroundColor: colors.surface, borderRadius: 20, paddingHorizontal: 16 }}
          >
            <NavRow
              title="Промокод"
              subtitle="Скоро можно будет применить при оформлении"
              disabled
            />
            <NavRow
              title="Чики за этот заказ"
              subtitle="Начисление появится после подключения программы"
              disabled
            />
          </View>
          <Button
            title="Добавить ещё что-нибудь"
            secondary
            icon="add"
            onPress={() => props.navigate('M06')}
          />
          <Caption>Окончательную цену и доступность подтвердит ресторан при оформлении.</Caption>
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
            ? 'Тестовый приём доступен'
            : online
              ? 'Реальные заказы ещё не открыты'
              : 'Доступность пока не подтверждена'
        }
        detail={
          testAvailable
            ? 'Можно проверить заказ до тестовой кухни. Ресторан этот заказ не готовит, деньги не списываются.'
            : 'Сбой загрузки не означает отмену заказа. Ваша корзина и прежний тестовый сеанс остаются на устройстве.'
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
export function Checkout(props: ScreenProps) {
  const total = cartTotal(props.model.cart);
  const location = restaurantLocation(props.model.branch?.id);
  return (
    <Page
      props={props}
      title="Оформление"
      footer={<Button title="Оплата пока недоступна" disabled testID="checkout-pay-disabled" />}
    >
      <Heading>Всё по вашему{`\n`}вкусу</Heading>
      <Card>
        <Row>
          <Icon name="location-outline" color={colors.accent} />
          <View style={ui.flex}>
            <Heading small>{props.model.branch?.name ?? 'Pick Chick'}</Heading>
            <Caption>
              {location ? `${location.city}, ${location.address}` : 'Ресторан получения'}
            </Caption>
          </View>
        </Row>
        <DiningSelector value={props.model.diningMode} onChange={props.model.setDiningMode} />
        <Caption>Заказ на ближайшее доступное время. Доставки в приложении нет.</Caption>
      </Card>
      <NavRow
        title="Войти по номеру"
        subtitle="Чтобы сохранять ваши заказы"
        icon="person-outline"
        onPress={() => props.navigate('M02')}
      />
      <Card>
        <Row>
          <View style={s.kaspiMark}>
            <Body style={{ color: colors.white, fontFamily: font.bold }}>K</Body>
          </View>
          <View style={ui.flex}>
            <Body style={{ fontFamily: font.bold }}>Kaspi</Body>
            <Caption>Подключение в процессе</Caption>
          </View>
          <Icon name="lock-closed-outline" color={colors.muted} />
        </Row>
      </Card>
      <View>
        <SummaryRow label="Товары по меню" value={MinorMoney(total)} />
        <SummaryRow label="Итого" value={MinorMoney(total)} strong />
      </View>
      <Notice warning title="Заказы ещё не открыты">
        Вход по SMS, оплата и электронные чеки пока подключаются. Деньги не списываются, заказ на
        кухню не отправляется.
      </Notice>
      <NavRow
        title="Условия заказа"
        subtitle="Документы Pick Chick"
        onPress={() => props.navigate('M33')}
      />
    </Page>
  );
}
const s = StyleSheet.create({
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
  menuBody: { paddingHorizontal: 24, paddingTop: 0, paddingBottom: 28, gap: 16 },
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
    gap: 14,
    borderRadius: 22,
    padding: 12,
    backgroundColor: colors.surface,
  },
  productPhotoWrap: {
    width: 112,
    height: 112,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#EAF0F8',
  },
  productInfo: { flex: 1, minWidth: 0, gap: 5 },
  productTitle: { fontFamily: font.heading, fontSize: 19, lineHeight: 25, letterSpacing: -0.19 },
  productDescription: { fontSize: 12.5, lineHeight: 18 },
  productPriceRow: {
    marginTop: 'auto',
    paddingTop: 8,
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  productPrice: { fontFamily: font.display, fontSize: 19, color: colors.text },
  productChoose: {
    minHeight: 36,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: colors.action,
    justifyContent: 'center',
  },
  productChooseText: { fontFamily: font.medium, fontSize: 14, color: colors.white },
  productPlus: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.action,
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
  hitText: { color: colors.white, fontFamily: font.bold, fontSize: 10, lineHeight: 13 },
  compactGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  compactProduct: { flexDirection: 'column', padding: 10, borderRadius: 20, gap: 9 },
  compactPhoto: { width: '100%', height: 'auto', aspectRatio: 1, borderRadius: 14 },
  compactTitle: { fontFamily: font.medium, fontSize: 13.5, lineHeight: 18 },
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
  cartHeader: {
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
    marginBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cartHeaderButton: { width: 44, height: 44, backgroundColor: colors.raised },
  cartFulfilment: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  cartLine: {
    flexDirection: 'row',
    gap: 13,
    padding: 12,
    borderRadius: 22,
    backgroundColor: colors.surface,
  },
  upsell: { width: 130, borderRadius: 18, padding: 10, gap: 8, backgroundColor: colors.surface },
  cartImage: { width: 80, height: 80, borderRadius: 14 },
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
  kaspiMark: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#E63132',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
