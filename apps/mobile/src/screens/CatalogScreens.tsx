import { t, localize, useLocale } from '../i18n';
import { ComboGiftChoice } from '../components/ComboGiftChoice';
import { unavailableCartLine } from '../availability';
import { CheckoutAction, checkoutStyle } from '../components/CheckoutPresentation';
import { CartTopBar, DiningModePill } from '../components/CartSheet';
import { CheckoutKeyboardDone } from '../components/CheckoutKeyboard';
import { ProductPhoto, productPhoto } from '../components/ProductPhoto';
import { hasPhotoPilot } from '../product-photo-selection';
import { useReducedMotion } from '../components/Motion';
import { MotionPressable as Pressable, MotionModal } from '../components/Motion';
import { usePublishedContent } from '../backoffice/usePublishedContent';
import { PromotionDialog } from '../backoffice/PromotionDialog';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Animated, {
  runOnJS,
  interpolateColor,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CartLine, Product, ScreenProps } from '../model';
import { assets } from '../assets';
import { restaurantLocation } from '../restaurant-location';
import { cartLineKey, cartTotal, lineUnitPrice, selectionDescription } from '../domain';
import { CatalogChangeNotice } from '../components/CatalogChangeNotice';
import { CartLinePrice } from '../components/CartLinePrice';
import { OrderTotal, orderUI } from '../components/OrderPresentation';
import { CartOffers, CartRecommendations } from '../components/CartExtras';
import { mergeCartLines } from '../cart-actions';
import { ConfiguredProduct } from './ProductConfiguration';
import { CartShortcut } from '../components/CartShortcut';
import { AppHeaderBar } from '../components/AppHeader';
import { GlassButton } from '../components/GlassButton';
import {
  CityButton,
  RestaurantCard,
  RestaurantMap,
  openIn2Gis,
  useMinuteClock,
} from '../components/Restaurants';
import { restaurantCountLabel, restaurantHoursStatus } from '../restaurant-hours';
import { colors, font, restaurantColors } from '../theme';
import { HeroVideo, LoyaltyCard } from '../components/Brand';
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
  Row,
  SummaryRow,
  styles as ui,
} from '../components/UI';

export function Welcome(props: ScreenProps) {
  useLocale();
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
            {t('Пропустить')}
          </Body>
        </Pressable>
        <View style={{ flex: 1, justifyContent: 'center', gap: 28, paddingVertical: 30 }}>
          <Logo size={128} />
          <Heading style={s.welcomeHeading}>
            {t('Куриные фингерсы для тех, кто в движении')}
          </Heading>
          <Body style={{ color: '#FFFFFFBF', lineHeight: 24 }}>
            {t('Один продукт, доведённый до пика вкуса. Своё производство, свои соусы.')}
          </Body>
        </View>
        <Row style={{ gap: 6, marginBottom: 4 }}>
          <View style={s.dotActive} />
          <View style={s.dot} />
          <View style={s.dot} />
        </Row>
        <Button
          title={t('Открыть меню')}
          onPress={() => props.navigate('M06')}
          testID="welcome-menu"
        />
        <Button
          title={t('Войти по номеру')}
          secondary
          onPress={() => props.navigate('M02')}
          testID="welcome-login"
        />
      </ScrollView>
    </View>
  );
}
// M05 (owner-approved redesign 2026-10-12): static map, sheet with one block per
// restaurant, menu action at the bottom. Selection and navigation are unchanged:
// choosing a restaurant still selects it and opens its menu.
export function Branches(props: ScreenProps) {
  useLocale();
  const insets = useSafeAreaInsets();
  const now = useMinuteClock();
  const [mapError, setMapError] = useState(false);
  const loading = props.model.connection.status === 'loading';
  const entries = props.model.branches.map((branch) => {
    const location = restaurantLocation(branch.id);
    return { branch, location, status: restaurantHoursStatus(location, now) };
  });
  const selected = entries.find((entry) => entry.branch.id === props.model.branch?.id);
  const closed = selected?.status?.open === false ? selected.status : null;
  const city = entries.find((entry) => entry.location)?.location?.city ?? 'Алматы';
  const controlsTop = Math.max(insets.top + 6, 18);
  return (
    <View testID="screen-M05" style={s.branchesPage}>
      <ScrollView
        testID="scroll-M05"
        style={ui.scroll}
        contentContainerStyle={s.branchesScroll}
        alwaysBounceVertical={false}
        showsVerticalScrollIndicator={false}
      >
        <RestaurantMap
          pins={entries.flatMap(({ branch, location, status }) =>
            location
              ? [
                  {
                    id: branch.id,
                    latitude: location.latitude,
                    longitude: location.longitude,
                    open: status?.open !== false,
                    selected: branch.id === props.model.branch?.id,
                  },
                ]
              : [],
          )}
        >
          <GlassButton
            testID="branches-back"
            name="chevron-back"
            iconSize={26}
            size={44}
            label={t('Назад')}
            onPress={props.goBack}
            style={[s.mapBack, { top: controlsTop }]}
          />
          <CityButton city={city} top={controlsTop} />
        </RestaurantMap>
        <View style={s.branchSheet}>
          <View style={s.branchSheetContent}>
            <View style={s.sheetHandle} />
            <Text accessibilityRole="header" style={s.branchesTitle}>
              {t('Рестораны')}
            </Text>
            <Text testID="branches-summary" style={s.branchesSummary}>
              {localize(
                entries.length ? `${city} · ${restaurantCountLabel(entries.length)}` : city,
              )}
            </Text>
            {loading ? <Loading title={t('Ищем рестораны')} /> : null}
            {entries.map(({ branch, location, status }) => (
              <RestaurantCard
                key={branch.id}
                branch={branch}
                address={location ? `${location.address}, ${location.city}` : undefined}
                status={status}
                selected={props.model.branch?.id === branch.id}
                onSelect={() => {
                  props.model.setBranch(branch.id);
                  props.navigate('M06');
                }}
                onOpenMap={
                  location
                    ? () => {
                        setMapError(false);
                        void openIn2Gis(location.map_url).catch(() => setMapError(true));
                      }
                    : undefined
                }
              />
            ))}
            {mapError ? (
              <Notice warning>{t('Не удалось открыть 2ГИС. Попробуйте ещё раз.')}</Notice>
            ) : null}
            {!entries.length && !loading ? (
              <Empty
                icon="location-outline"
                title={t('Не удалось получить рестораны')}
                detail={t('Проверьте подключение и обновите список.')}
                action={<Button title={t('Обновить')} onPress={props.model.refresh} />}
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
      {entries.length ? (
        <View
          testID="branches-footer"
          style={[s.branchesFooter, { paddingBottom: Math.max(28, insets.bottom + 8) }]}
        >
          <Caption testID="branches-caption" style={s.branchesCaption}>
            {localize(
              closed
                ? t('Заказ можно оформить с {p0}', { p0: closed.opensAt })
                : 'При смене ресторана корзина проверяется заново',
            )}
          </Caption>
          <Button
            testID="branches-menu"
            title={localize(closed ? 'Посмотреть меню' : 'Перейти в меню')}
            secondary={Boolean(closed)}
            onPress={() => props.navigate('M06')}
            style={[s.branchMenuButton, closed && s.branchMenuButtonClosed]}
            textStyle={s.branchMenuText}
          />
        </View>
      ) : null}
    </View>
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
      accessibilityLabel={localize(
        `${product.name}, ${product.available === false ? 'Нет в наличии' : MinorMoney(product.priceMinor) + ', выбрать'}`,
      )}
      accessibilityState={{ disabled: product.available === false }}
      disabled={product.available === false}
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
        <ProductPhoto
          photo={productPhoto(product, 'card', 'menu')}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
        />
        {hit ? (
          <View style={s.hit}>
            <Caption style={s.hitText}>{t('ХИТ')}</Caption>
          </View>
        ) : null}
      </View>
      <View style={s.productInfo}>
        <Heading small style={compact ? s.compactTitle : s.productTitle}>
          {localize(product.name)}
        </Heading>
        {!compact ? (
          <Caption style={s.productDescription}>{localize(product.description)}</Caption>
        ) : null}
        <Row style={s.productPriceRow}>
          <Body style={[s.productPrice, compact && { fontSize: 16 }]}>
            {localize(MinorMoney(product.priceMinor))}
          </Body>
          <View
            style={
              product.available === false
                ? { flexShrink: 1, maxWidth: 120 }
                : compact
                  ? s.productPlus
                  : s.productChoose
            }
          >
            {product.available === false ? (
              <Caption style={{ color: colors.text }}>{t('Нет в наличии')}</Caption>
            ) : compact ? (
              <Icon name="add" color={colors.orangeInk} size={20} />
            ) : (
              <Body style={s.productChooseText}>{t('Выбрать')}</Body>
            )}
          </View>
        </Row>
      </View>
    </Pressable>
  );
});
export function Menu(props: ScreenProps) {
  useLocale();
  const [cartHeight, setCartHeight] = useState(100);
  const router = useRouter();
  const { catalogVisit } = useLocalSearchParams();
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
  const scroll = useRef<ScrollView>(null);
  const sectionY = useRef<Record<string, number>>({});
  const [category, setCategory] = useState('Комбо');
  // Scroll geometry stays on the UI thread; React only sees category changes.
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
  useEffect(() => {
    if (!catalogVisit || !catalogTop) return;
    const frame = requestAnimationFrame(() => {
      const target = Math.max(0, catalogTop - collapsedHeaderHeight - categoryHeight);
      setCategory(categories[0] ?? 'Комбо');
      requestedCategory.value = -1;
      scroll.current?.scrollTo({ y: target, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [catalogVisit, catalogTop, collapsedHeaderHeight, categoryHeight, categories]);
  const selectVisibleCategory = (index: number) => {
    const name = categories[index];
    if (name) setCategory(name);
  };
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
  // Opaque once collapsed: a translucent bar let product buttons show through behind the row.
  const headerStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(scrollY.value, [0, 120], ['#04143A00', colors.background]),
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
      if (hasPhotoPilot(product))
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
            {localize(
              item === 'Комбо'
                ? 'Комбо на одного'
                : item === 'На двоих'
                  ? 'Комбо на двоих'
                  : item === 'На компанию'
                    ? 'Комбо на компанию'
                    : item,
            )}
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
          paddingBottom: Math.max(
            24,
            (props.cartBottomInset || (props.model.cart.length ? cartHeight : 0)) + 16,
          ),
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
            accessibilityLabel={localize(
              promotion ? promotion.title.ru + ', подробнее' : 'Комбо недели, подробнее',
            )}
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
            <Heading style={s.heroTitle}>{localize(promotion?.title.ru ?? 'Комбо недели')}</Heading>
            <Body style={s.heroSubtitle}>{t('подробнее')}</Body>
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
          {props.model.catalogMode === 'design' ? (
            <Notice title={t('Образцы меню')}>
              {t(
                'Блюда и цены из макета. Эта корзина подходит для проверки дизайна; оформить заказ нельзя.',
              )}
            </Notice>
          ) : null}
          {props.model.connection.status === 'loading' && props.model.catalogMode === 'server' ? (
            <Loading />
          ) : null}
          {props.model.connection.status !== 'online' &&
          props.model.catalogMode === 'server' &&
          props.model.connection.status !== 'loading' ? (
            <>
              <Notice warning title={t('Нет свежего меню')}>
                {localize(
                  props.model.connection.message ?? 'Проверьте интернет и повторите загрузку.',
                )}
              </Notice>
              <NavRow title={t('Проверить доступность')} onPress={() => props.navigate('M11')} />
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
                  {localize(item)}
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
              title={t('Меню скоро появится')}
              detail={t('Мы готовим каталог этого ресторана.')}
              action={<Button title={t('Обновить меню')} secondary onPress={props.model.refresh} />}
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
          <AppHeaderBar screen={props} />
        </View>
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
/**
 * Kaspi build: the cart is the checkout (owner 27.10.2026). The guarded Kaspi session passes
 * its notices, the order comment and the payment footer; other builds keep «Оформить заказ».
 */
export type CartCheckout = {
  restaurant?: string;
  notices?: ReactNode;
  comment?: ReactNode;
  footer(blocked: boolean): ReactNode;
};
export function Cart(props: ScreenProps & { checkout?: CartCheckout }) {
  useLocale();
  const { checkout } = props;
  const insets = useSafeAreaInsets();
  const [removed, setRemoved] = useState<CartLine[]>([]);
  useEffect(() => setRemoved([]), [props.model.branch?.id, props.model.catalogMode]);
  const [clearSnapshot, setClearSnapshot] = useState<{ id: string; quantity: number }[] | null>(
    null,
  );
  const discount = props.model.comboRewards?.discountMinor ?? '0';
  const total = (BigInt(cartTotal(props.model.cart)) - BigInt(discount)).toString();
  const [editing, setEditing] = useState<CartLine | null>(null);
  // Same rule as the old «Оформить заказ»: nothing to pay while the cart cannot be ordered.
  const blocked =
    (props.model.comboRewards?.selected &&
      (props.model.comboRewards.giftItemIndex === undefined || discount === '0')) ||
    props.model.catalogUpdatePending ||
    props.model.cart.some((line) => line.product.available === false);
  return (
    <Page
      props={props}
      title={t('Корзина')}
      contentStyle={checkoutStyle.content}
      footerStyle={checkout ? checkoutStyle.footer : checkoutStyle.cartFooter}
      keyboardFooter={checkout?.comment ? <CheckoutKeyboardDone /> : undefined}
      header={
        <CartTopBar
          restaurant={
            checkout?.restaurant ??
            restaurantLocation(props.model.branch?.id)?.name ??
            props.model.branch?.name
          }
          onClose={props.goBack}
          clearDisabled={!props.model.cart.length}
          onClear={() =>
            setClearSnapshot(
              props.model.cart.map((line) => ({
                id: cartLineKey(line),
                quantity: line.quantity,
              })),
            )
          }
        />
      }
      footer={
        props.model.cart.length ? (
          checkout ? (
            checkout.footer(!!blocked)
          ) : (
            <CheckoutAction
              title={t('Оформить заказ')}
              disabled={!!blocked}
              amount={MinorMoney(total)}
              onPress={() => props.navigate('M12')}
              testID="cart-checkout"
            />
          )
        ) : null
      }
    >
      {checkout?.notices}
      {!props.model.cart.length ? <ComboGiftChoice props={props} /> : null}
      {props.model.catalogUpdateNotice ? (
        <CatalogChangeNotice
          message={props.model.catalogUpdateNotice}
          totals={props.model.cartChanges}
          onDismiss={props.model.dismissCatalogUpdate}
        />
      ) : null}
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
            product={
              props.model.products.find((product) => product.id === editing.product.id) ?? {
                ...editing.product,
                available: false,
              }
            }
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
            <Heading small>{t('Очистить корзину?')}</Heading>
            <Body muted>{t('Все выбранные блюда и добавки будут удалены из корзины.')}</Body>
            <Button
              title={t('Оставить заказ')}
              testID="cart-clear-cancel"
              onPress={() => setClearSnapshot(null)}
            />
            <Button
              title={t('Очистить корзину')}
              secondary
              testID="cart-clear-confirm"
              onPress={() => {
                if (clearSnapshot) props.model.clearCart(clearSnapshot);
                setRemoved([]);
                setClearSnapshot(null);
              }}
            />
          </View>
        </ScrollView>
      </MotionModal>
      {removed.map((line) => {
        const canRestore = !!mergeCartLines(props.model.cart, [line], props.model.products);
        return (
          <View
            key={cartLineKey(line)}
            style={{ gap: 8, paddingVertical: 12 }}
            testID={`cart-removed-${line.product.id}`}
          >
            <Row style={{ alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Body>
                  {localize(line.product.name)}
                  {t('удалён')}
                </Body>
                <Caption>
                  {localize(
                    canRestore
                      ? 'Вернём с теми же настройками'
                      : 'Меню или лимит корзины изменились',
                  )}
                </Caption>
              </View>
              <Button
                title={t('Вернуть')}
                secondary
                disabled={!canRestore}
                testID={`cart-undo-${line.product.id}`}
                onPress={() => {
                  if (!mergeCartLines(props.model.cart, [line], props.model.products)) return;
                  if (!props.model.appendCartLines([line])) return;
                  setRemoved((previous) =>
                    previous.filter((l) => cartLineKey(l) !== cartLineKey(line)),
                  );
                }}
              />
            </Row>
          </View>
        );
      })}
      {!props.model.cart.length ? (
        <Empty
          title={t('Здесь пока тихо')}
          detail={t('Добавьте любимые блюда - и станет хрустяще.')}
          action={<Button title={t('Выбрать в меню')} onPress={() => props.navigate('M06')} />}
        />
      ) : (
        <>
          <DiningModePill value={props.model.diningMode} onChange={props.model.setDiningMode} />
          {props.model.catalogMode === 'design' ? (
            <Notice warning>
              {t('Это корзина из образцов дизайна. Заказ и оплата недоступны.')}
            </Notice>
          ) : null}
          {props.model.cart.map((line) => (
            <View key={cartLineKey(line)} style={s.cartLine}>
              <Pressable
                onPress={() => setEditing(line)}
                accessibilityRole="button"
                accessibilityLabel={localize(t('Изменить {p0}', { p0: t(line.product.name) }))}
                testID={`cart-edit-${line.product.id}`}
              >
                <ProductPhoto
                  photo={productPhoto(line.product, 'card', 'menu')}
                  style={s.cartImage}
                  contentFit="contain"
                />
              </Pressable>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Pressable
                  onPress={() => setEditing(line)}
                  accessibilityRole="button"
                  accessibilityLabel={localize(t('Настроить {p0}', { p0: t(line.product.name) }))}
                  style={{ minHeight: 48 }}
                >
                  <Heading small style={s.cartName}>
                    {localize(line.product.name)}
                  </Heading>
                  {unavailableCartLine(line) ? (
                    <Caption style={{ color: colors.warning }}>
                      {localize(unavailableCartLine(line))}
                    </Caption>
                  ) : null}
                  {selectionDescription(line) ? (
                    <Caption numberOfLines={2} style={s.cartDescription}>
                      {localize(selectionDescription(line))}
                    </Caption>
                  ) : null}
                </Pressable>
                <Row
                  style={{
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    gap: 4,
                    marginTop: 'auto',
                  }}
                >
                  <Row style={s.stepper}>
                    <IconButton
                      size={44}
                      name="remove"
                      label={localize(
                        line.quantity === 1
                          ? t('Удалить {p0}', { p0: t(line.product.name) })
                          : t('Уменьшить {p0}', { p0: t(line.product.name) }),
                      )}
                      testID={`cart-minus-${line.product.id}`}
                      onPress={() => {
                        if (line.quantity === 1)
                          setRemoved((previous) => [
                            ...previous.filter((l) => cartLineKey(l) !== cartLineKey(line)),
                            line,
                          ]);
                        props.model.setQuantity(cartLineKey(line), line.quantity - 1);
                      }}
                    />
                    <Body
                      testID={`cart-quantity-${line.product.id}`}
                      style={{
                        fontFamily: font.heading,
                        fontSize: 17,
                        minWidth: 16,
                        textAlign: 'center',
                      }}
                    >
                      {localize(line.quantity)}
                    </Body>
                    <IconButton
                      size={44}
                      name="add"
                      label={localize(t('Добавить ещё {p0}', { p0: t(line.product.name) }))}
                      testID={`cart-plus-${line.product.id}`}
                      disabled={line.quantity >= 20}
                      onPress={() => props.model.setQuantity(cartLineKey(line), line.quantity + 1)}
                    />
                  </Row>
                  <CartLinePrice
                    unitMinor={lineUnitPrice(line)}
                    previousUnitMinor={line.previousUnitPriceMinor}
                    quantity={line.quantity}
                  />
                </Row>
              </View>
            </View>
          ))}
          <ComboGiftChoice props={props} />
          <CartRecommendations props={props} />
          <CartOffers props={props} />
          {checkout ? (
            checkout.comment
          ) : (
            <View style={{ gap: 12, paddingVertical: 8 }}>
              <Heading small style={orderUI.section}>
                {t('Детали')}
              </Heading>
              <SummaryRow
                label={localize(
                  t('Блюда · {p0} шт.', {
                    p0: props.model.cart.reduce((sum, line) => sum + line.quantity, 0),
                  }),
                )}
                value={MinorMoney(total)}
              />
              <OrderTotal value={MinorMoney(total)} />
            </View>
          )}
        </>
      )}
    </Page>
  );
}
export function ChangedCart(props: ScreenProps) {
  useLocale();
  return (
    <Page props={props} title={t('Меню обновилось')}>
      <View style={s.largeIcon}>
        <Icon name="refresh" size={42} color={colors.accent} />
      </View>
      <Heading>
        {t('Давайте проверим')}
        {localize(`\n`)}
        {t('корзину')}
      </Heading>
      <Body muted>
        {t('Цены и наличие могли измениться. Мы ничего не заменяем без вашего решения.')}
      </Body>
      {props.preview ? (
        <Card>
          <Caption>{t('ПРИМЕР ИЗМЕНЕНИЯ')}</Caption>
          <Heading small>Pick Combo</Heading>
          <SummaryRow label={t('Было')} value="3 490 ₸" />
          <SummaryRow label={t('Стало')} value="3 590 ₸" />
          <Notice warning>{t('Новая цена показана для проверки макета.')}</Notice>
        </Card>
      ) : (
        <Notice>
          {localize(
            props.model.connection.message ??
              'Корзина сверяется с текущей версией меню. При смене версии её нужно собрать заново; новый состав и цену подтвердит сервер при оформлении.',
          )}
        </Notice>
      )}
      <Button title={t('Вернуться в корзину')} onPress={() => props.navigate('M09')} />
      <Button title={t('Посмотреть меню')} secondary onPress={() => props.navigate('M06')} />
    </Page>
  );
}
export function Unavailable(props: ScreenProps) {
  useLocale();
  const online = props.model.connection.status === 'online';
  const testAvailable = props.model.testFlow.available;
  return (
    <Page props={props} title={t('Доступность ресторана')}>
      <Empty
        icon="storefront-outline"
        title={localize(
          testAvailable
            ? 'Можно оформить заказ'
            : online
              ? 'Приём заказов пока недоступен'
              : 'Доступность пока не подтверждена',
        )}
        detail={localize(
          testAvailable
            ? 'Заказ поступит на кухню. Оплата и чеки - в процессе подключения.'
            : 'Сбой загрузки не означает отмену заказа. Ваша корзина и прежний сеанс остаются на устройстве.',
        )}
        action={<Button title={t('Выбрать ресторан')} onPress={() => props.navigate('M05')} />}
      />
      <Card>
        <Heading small>{localize(props.model.branch?.name ?? 'Pick Chick')}</Heading>
        <Body muted>
          {localize(
            props.model.connection.message ??
              (online
                ? 'Состояние меню получено с сервера'
                : 'Проверьте связь и повторите загрузку'),
          )}
        </Body>
        {props.model.connection.status === 'loading' ? (
          <Loading title={t('Проверяем доступность')} />
        ) : null}
        <Button title={t('Обновить доступность')} secondary onPress={props.model.refresh} />
        <Button title={t('Вернуться в меню')} onPress={() => props.navigate('M06')} />
      </Card>
    </Page>
  );
}
export { Checkout } from './CheckoutScreen';
const s = StyleSheet.create({
  branchesPage: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  branchesScroll: { flexGrow: 1 },
  // Round glass back over the map (owner 27.10.2026: every round icon button is glass).
  mapBack: { position: 'absolute', left: 16 },
  branchSheet: {
    flexGrow: 1,
    marginTop: -22,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: colors.background,
  },
  branchSheetContent: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 12,
  },
  sheetHandle: {
    width: 40,
    height: 5,
    borderRadius: 2.5,
    alignSelf: 'center',
    backgroundColor: restaurantColors.outline,
  },
  branchesTitle: {
    marginTop: 2,
    fontFamily: font.bold,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
    color: colors.text,
  },
  branchesSummary: {
    marginTop: -10,
    marginBottom: 4,
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
  },
  branchesFooter: {
    flexShrink: 0,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 9,
    backgroundColor: colors.background,
  },
  branchesCaption: { textAlign: 'center', fontSize: 12.5, lineHeight: 18 },
  branchMenuButton: { minHeight: 54, borderRadius: 14 },
  branchMenuButtonClosed: { borderColor: restaurantColors.outline },
  branchMenuText: { fontFamily: font.bold, fontSize: 16, lineHeight: 22 },
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
  // The shared header row (AppHeaderBar) carries the gutter and width cap of every tab.
  heroHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingBottom: 10,
    gap: 12,
    zIndex: 10,
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
    flexDirection: 'row',
    gap: 14,
    padding: 12,
    borderRadius: 24,
    backgroundColor: '#0B2255',
    borderWidth: 1,
    borderColor: '#FFFFFF0F',
  },
  cartName: { fontFamily: font.heading, fontSize: 18, lineHeight: 22 },
  cartDescription: {
    fontFamily: font.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
    color: '#A3B4D6',
  },
  upsell: { width: 130, borderRadius: 18, padding: 10, gap: 8, backgroundColor: colors.surface },
  cartImage: { width: 84, height: 84, borderRadius: 18, backgroundColor: '#FFF8EE' },
  // Drinkit-like separate round glass -/+ (owner 27.10.2026).
  stepper: { alignSelf: 'flex-start', gap: 6 },
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
