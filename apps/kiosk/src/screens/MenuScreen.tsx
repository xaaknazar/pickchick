import { useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { BluePattern, LightBackground } from '../components/PatternBackground';
import { assets } from '../assets';
import { ProductArtwork } from '../components/ProductArtwork';
import { defaultSelections, money, validSelections } from '../cart';
import type { KioskModel, KioskProduct } from '../model';
import { copy } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import {
  Body,
  Button,
  Footer,
  Header,
  Heading,
  IconButton,
  layout,
  type ScreenContext,
} from '../components/UI';
const categoryKeys = ['combo', 'duo', 'sets', 'extras'] as const;
type Category = (typeof categoryKeys)[number];
export interface MenuMemory {
  category: Category;
  offsets: Partial<Record<Category, number>>;
}
const inCategory = (product: KioskProduct, category: Category) =>
  category === 'combo'
    ? product.category === 'Комбо'
    : category === 'duo'
      ? product.category === 'На двоих'
      : category === 'sets'
        ? product.category === 'На компанию'
        : !['Комбо', 'На двоих', 'На компанию'].includes(product.category);
export function ProductCard({
  product,
  onOpen,
  onAdd,
  prefix = 'kiosk-product',
  busy = false,
}: {
  product: KioskProduct;
  onOpen: () => void;
  onAdd: () => void;
  prefix?: string;
  busy?: boolean;
}) {
  const { px } = useMetrics();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.white,
        borderRadius: px(26),
        padding: px(14),
        boxShadow: '0 5px 20px rgba(14,21,36,.05)',
        gap: px(14),
      }}
    >
      <Pressable
        testID={`${prefix}-${product.id}`}
        accessibilityRole="button"
        accessibilityLabel={product.name}
        onPress={onOpen}
        style={{ gap: px(18) }}
      >
        <View
          style={{
            height: px(280),
            borderRadius: px(20),
            overflow: 'hidden',
            backgroundColor: colors.light,
          }}
        >
          <ProductArtwork imageId={product.image_id} crop style={StyleSheet.absoluteFill} />
        </View>
        <View style={{ paddingHorizontal: px(6), gap: px(10) }}>
          <Heading size={29} style={{ fontFamily: fonts.heading }}>
            {product.name}
          </Heading>
          <Body
            style={{
              fontSize: Math.max(16, px(18)),
              lineHeight: Math.max(22, px(25)),
              color: colors.muted,
            }}
          >
            {product.description}
          </Body>
        </View>
      </Pressable>
      <View style={[layout.spread, { marginTop: 'auto', paddingLeft: px(6), gap: px(8) }]}>
        <Heading size={34} color={colors.blue} style={{ flexShrink: 1 }}>
          {money(product.price_minor)}
        </Heading>
        <IconButton
          name="add"
          label={`+ ${product.name}`}
          onPress={onAdd}
          testID={`${prefix}-plus-${product.id}`}
          size={80}
          orange
          disabled={busy}
        />
      </View>
    </View>
  );
}
export function MenuScreen({
  model,
  context,
  memory,
}: {
  model: KioskModel;
  context: ScreenContext;
  memory: MenuMemory;
}) {
  const { px, columns } = useMetrics();
  const t = copy(context.locale);
  const [category, setCategory] = useState<Category>(memory.category);
  const list = useRef<FlatList<KioskProduct>>(null);
  // Seed the native scroll view once per category. Server polling must not feed
  // a JS offset back into an in-progress native gesture.
  const initialOffset = useMemo(
    () => ({ x: 0, y: memory.offsets[category] ?? 0 }),
    [category, columns, memory],
  );
  const products = model.catalog?.products.filter((product) => inCategory(product, category)) ?? [];
  const promo = model.catalog?.products.find((p) => p.id === 'master-combo');
  const quickAdd = (product: KioskProduct) => {
    const selected = defaultSelections(product);
    if (product.modifier_groups.length || !validSelections(product, selected))
      model.openProduct(product.id);
    else void model.addToCart(product.id, selected);
  };
  return (
    <View testID="kiosk-screen-menu" style={layout.screen}>
      <LightBackground />
      <View style={{ backgroundColor: '#0B4FC4' }}>
        <BluePattern />
        <Header
          {...context}
          transparent
          back={model.goMode}
          mode={model.mode === 'dine_in' ? t.here : t.togo}
        />
        <View style={{ paddingBottom: px(24), paddingTop: px(6) }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: px(24), gap: px(12) }}
          >
            {categoryKeys.map((key) => (
              <Pressable
                key={key}
                testID={`kiosk-category-${key}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: category === key }}
                onPress={() => {
                  model.touch();
                  memory.category = key;
                  memory.offsets[key] = 0;
                  if (category === key)
                    list.current?.scrollToOffset({ offset: 0, animated: false });
                  else setCategory(key);
                }}
                style={({ pressed }) => ({
                  minHeight: Math.max(56, px(76)),
                  paddingHorizontal: px(28),
                  paddingVertical: px(20),
                  borderRadius: px(38),
                  justifyContent: 'center',
                  backgroundColor: category === key ? colors.white : 'rgba(255,255,255,.13)',
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <Heading
                  size={24}
                  color={category === key ? colors.blue : colors.white}
                  style={{ fontFamily: fonts.heading }}
                >
                  {t[key]}
                </Heading>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
      <FlatList
        ref={list}
        key={`${columns}-${category}`}
        testID="kiosk-menu-scroll"
        style={layout.grow}
        data={products}
        numColumns={columns}
        keyExtractor={(p) => p.id}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={model.touch}
        contentOffset={initialOffset}
        scrollEventThrottle={64}
        onScroll={(event) => {
          memory.offsets[category] = Math.max(0, event.nativeEvent.contentOffset.y);
        }}
        columnWrapperStyle={{ gap: px(22) }}
        contentContainerStyle={{ padding: px(24), gap: px(22), paddingBottom: px(30) }}
        ListHeaderComponent={
          category === 'combo' && promo ? (
            <View
              style={{
                backgroundColor: colors.blue,
                overflow: 'hidden',
                borderRadius: px(26),
                padding: px(28),
                marginBottom: px(4),
                flexDirection: 'row',
                alignItems: 'center',
                gap: px(18),
              }}
            >
              <Image source={assets.promo} contentFit="cover" style={StyleSheet.absoluteFill} />
              <LinearGradient
                colors={['rgba(11,79,196,.5)', 'rgba(11,79,196,.82)']}
                style={StyleSheet.absoluteFill}
              />
              <View style={{ flex: 1, gap: px(12) }}>
                <View
                  style={{
                    backgroundColor: colors.orange,
                    borderRadius: px(12),
                    paddingHorizontal: px(12),
                    paddingVertical: px(8),
                    alignSelf: 'flex-start',
                  }}
                >
                  <Heading size={17} color={colors.white}>
                    {t.promo}
                  </Heading>
                </View>
                <Heading size={42} color={colors.white}>
                  {promo.name}
                </Heading>
                <Body style={{ color: colors.white, fontSize: px(20) }}>{promo.description}</Body>
              </View>
              <View style={{ alignItems: 'flex-end', gap: px(18), maxWidth: '42%' }}>
                <Heading size={42} color={colors.orange}>
                  {money(promo.price_minor)}
                </Heading>
                <Button compact label={t.pick} onPress={() => model.openProduct(promo.id)} />
              </View>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ProductCard
            product={item}
            busy={model.busy}
            onOpen={() => model.openProduct(item.id)}
            onAdd={() => quickAdd(item)}
          />
        )}
      />
      {
        <Footer blue testID="kiosk-cart-bar">
          <View style={[layout.spread, { gap: px(24) }]}>
            <View style={{ flex: 1, minWidth: 0, gap: px(4) }}>
              <Body style={{ color: 'rgba(255,255,255,.72)', fontSize: px(19) }}>
                {t.cart}: {model.cart.reduce((sum, line) => sum + line.quantity, 0)}
              </Body>
              <Heading size={44} color={colors.white}>
                {model.cartValid
                  ? money(model.cartTotalMinor)
                  : context.locale === 'ru'
                    ? 'Проверьте корзину'
                    : 'Себетті тексеріңіз'}
              </Heading>
            </View>
            <Button
              label={t.checkout}
              icon="arrow-forward"
              onPress={model.cartValid ? model.openUpsell : model.openCart}
              testID="kiosk-menu-checkout"
              disabled={!model.cart.length && !model.unavailableCartLines.length}
              busy={model.busy}
              style={{ maxWidth: '65%', paddingHorizontal: px(42) }}
            />
          </View>
        </Footer>
      }
    </View>
  );
}
