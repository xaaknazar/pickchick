import { FlatList, Pressable, ScrollView, View } from 'react-native';
import type { KioskCartLine, KioskModel } from '../model';
import { defaultSelections, money, validSelections } from '../cart';
import { ProductArtwork } from '../components/ProductArtwork';
import { copy } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import {
  Body,
  Button,
  Footer,
  Header,
  Heading,
  Icon,
  Stepper,
  layout,
  type ScreenContext,
} from '../components/UI';
import { BluePattern, LightBackground } from '../components/PatternBackground';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
export function selectionSummary(line: KioskCartLine): string {
  return line.selections
    .map((selection) => {
      const option = line.product.modifier_groups
        .find((g) => g.id === selection.group_id)
        ?.options.find((o) => o.id === selection.option_id);
      return option
        ? `${option.label}${selection.quantity > 1 ? ` × ${selection.quantity}` : ''}`
        : '';
    })
    .filter(Boolean)
    .join(' · ');
}
export function UpsellScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const { px, columns } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(context.locale);
  const products =
    model.catalog?.products.filter((product) =>
      model.catalog?.upsell_product_ids.includes(product.id),
    ) ?? [];
  return (
    <View testID="kiosk-screen-upsell" style={layout.screen}>
      <LightBackground />
      <FlatList
        key={columns}
        data={products}
        numColumns={columns}
        keyExtractor={(product) => product.id}
        style={layout.grow}
        columnWrapperStyle={{ gap: px(22) }}
        onScrollBeginDrag={model.touch}
        contentContainerStyle={{
          paddingHorizontal: px(48),
          paddingTop: Math.max(safe.top, px(72)),
          paddingBottom: px(36),
          gap: px(22),
        }}
        ListHeaderComponent={
          <Heading size={56} style={{ marginBottom: px(14) }}>
            {t.upsellTitle}
          </Heading>
        }
        renderItem={({ item }) => {
          const added = model.cart.some((line) => line.productId === item.id);
          return (
            <Pressable
              testID={`kiosk-upsell-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`+ ${item.name}`}
              accessibilityState={{ disabled: model.busy }}
              disabled={model.busy}
              onPress={() => {
                const selections = defaultSelections(item);
                if (validSelections(item, selections)) void model.addToCart(item.id, selections);
                else model.openProduct(item.id);
              }}
              style={({ pressed }) => ({
                flex: 1,
                borderRadius: px(24),
                borderWidth: 2,
                borderColor: added ? colors.blue : colors.border,
                backgroundColor: colors.white,
                padding: px(14),
                opacity: pressed || model.busy ? 0.7 : 1,
              })}
            >
              <ProductArtwork
                imageId={item.image_id}
                crop
                style={{ height: px(240), borderRadius: px(16) }}
              />
              <View
                style={[
                  layout.row,
                  {
                    paddingTop: px(18),
                    paddingHorizontal: px(8),
                    paddingBottom: px(6),
                    gap: px(14),
                  },
                ]}
              >
                <View style={{ flex: 1, gap: px(6) }}>
                  <Heading size={27} style={{ fontFamily: fonts.heading }}>
                    {item.name}
                  </Heading>
                  <Heading size={26} style={{ fontFamily: fonts.heading }}>
                    {money(item.price_minor)}
                  </Heading>
                </View>
                <View
                  testID={`kiosk-upsell-plus-${item.id}`}
                  style={{
                    width: Math.max(48, px(76)),
                    height: Math.max(48, px(76)),
                    borderRadius: px(38),
                    backgroundColor: added ? colors.blue : colors.orange,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name={added ? 'checkmark' : 'add'} size={px(34)} color={colors.white} />
                </View>
              </View>
            </Pressable>
          );
        }}
      />
      <Footer style={{ paddingHorizontal: px(44) }}>
        <Button
          label={t.next}
          testID="kiosk-upsell-continue"
          onPress={model.openCart}
          busy={model.busy}
          style={{ minHeight: px(120), borderRadius: px(24) }}
          textStyle={{ fontSize: px(36), lineHeight: px(43) }}
        />
      </Footer>
    </View>
  );
}
function CartRow({
  line,
  model,
  context,
}: {
  line: KioskCartLine;
  model: KioskModel;
  context: ScreenContext;
}) {
  const { px, width, fontScale } = useMetrics();
  const t = copy(context.locale);
  const summary = selectionSummary(line);
  const wide = width >= 950 && fontScale < 1.3;
  const picture = (
    <ProductArtwork
      imageId={line.product.image_id}
      crop
      style={{ width: px(124), height: px(124), borderRadius: px(16), flexShrink: 0 }}
    />
  );
  const details = (
    <View style={{ flex: 1, minWidth: 0, gap: px(6) }}>
      <Heading size={28} style={{ fontFamily: fonts.heading }}>
        {line.product.name}
      </Heading>
      {summary ? (
        <Body style={{ color: colors.muted, fontSize: Math.max(16, px(18)) }}>{summary}</Body>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t.remove} ${line.product.name}`}
        disabled={model.busy}
        onPress={() => void model.updateQuantity(line.lineId, 0)}
        style={{
          minHeight: 48,
          justifyContent: 'center',
          alignSelf: 'flex-start',
          paddingRight: px(20),
        }}
      >
        <Body style={{ color: colors.error, fontSize: Math.max(16, px(18)) }}>{t.remove}</Body>
      </Pressable>
    </View>
  );
  const controls = (
    <Stepper
      quantity={line.quantity}
      prefix={`kiosk-cart-line-${line.lineId}`}
      disabled={model.busy}
      max={20}
      onMinus={() => void model.updateQuantity(line.lineId, line.quantity - 1)}
      onPlus={() => void model.updateQuantity(line.lineId, line.quantity + 1)}
    />
  );
  const total = (
    <Heading
      size={29}
      style={{
        fontFamily: fonts.heading,
        minWidth: wide ? px(150) : undefined,
        flexShrink: 0,
        textAlign: 'right',
      }}
    >
      {money(line.lineTotalMinor)}
    </Heading>
  );
  return (
    <View
      testID={`kiosk-cart-line-${line.lineId}`}
      style={{
        backgroundColor: colors.white,
        borderRadius: px(22),
        padding: px(16),
        gap: px(20),
        flexDirection: wide ? 'row' : 'column',
        alignItems: wide ? 'center' : 'stretch',
        boxShadow: '0 4px 16px rgba(14,21,36,.05)',
      }}
    >
      {wide ? (
        <>
          {picture}
          {details}
          {controls}
          {total}
        </>
      ) : (
        <>
          <View style={[layout.row, { gap: px(20), alignItems: 'flex-start' }]}>
            {picture}
            {details}
          </View>
          <View style={[layout.spread, { gap: px(20) }]}>
            {controls}
            {total}
          </View>
        </>
      )}
    </View>
  );
}
export function CartScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const { px } = useMetrics();
  const t = copy(context.locale);
  return (
    <View testID="kiosk-screen-cart" style={layout.screen}>
      <LightBackground />
      <View style={{ backgroundColor: colors.blue }}>
        <BluePattern />
        <Header {...context} transparent title={t.yourOrder} back={model.goMenu} />
      </View>
      <ScrollView
        style={layout.grow}
        onScrollBeginDrag={model.touch}
        contentContainerStyle={{ padding: px(28), gap: px(20) }}
      >
        {!model.cart.length && !model.unavailableCartLines.length ? (
          <View style={{ paddingVertical: px(100), gap: px(30), alignItems: 'center' }}>
            <Icon name="bag-outline" color={colors.blue} size={px(90)} />
            <Heading size={34} style={{ textAlign: 'center' }}>
              {t.empty}
            </Heading>
          </View>
        ) : null}
        {model.cart.map((line) => (
          <CartRow key={line.lineId} line={line} model={model} context={context} />
        ))}
        {model.unavailableCartLines.map((line) => (
          <View
            key={line.lineId}
            testID={`kiosk-unavailable-line-${line.lineId}`}
            style={{
              borderRadius: px(22),
              backgroundColor: '#FFF2EA',
              padding: px(24),
              gap: px(14),
            }}
          >
            <Heading size={25}>
              {context.locale === 'ru'
                ? 'Позиция изменилась или недоступна'
                : 'Тағам өзгерді немесе қолжетімсіз'}
            </Heading>
            <Body>
              {context.locale === 'ru'
                ? 'Удалите её и выберите блюдо заново из актуального меню.'
                : 'Оны өшіріп, мәзірден қайта таңдаңыз.'}
            </Body>
            <Button
              compact
              tone="outline"
              label={t.remove}
              busy={model.busy}
              onPress={() => void model.updateQuantity(line.lineId, 0)}
            />
          </View>
        ))}
        {model.cart.length ? (
          <View
            style={{
              borderRadius: px(24),
              backgroundColor: '#E8EFFC',
              padding: px(28),
              gap: px(10),
            }}
          >
            <Heading size={28} color={colors.blue}>
              {t.loyaltyTitle}
            </Heading>
            <Body style={{ color: colors.blue }}>{t.loyaltyBody}</Body>
          </View>
        ) : null}
      </ScrollView>
      <Footer>
        <View style={[layout.spread, { gap: px(20) }]}>
          <Body style={{ fontSize: px(24), color: colors.muted }}>{t.total}</Body>
          <Heading size={model.cartValid ? 52 : 30} color={colors.blue} style={{ flexShrink: 1 }}>
            {model.cartValid
              ? money(model.cartTotalMinor)
              : context.locale === 'ru'
                ? 'Нужна проверка корзины'
                : 'Себетті тексеру қажет'}
          </Heading>
        </View>
        <View style={[layout.row, { gap: px(20) }]}>
          <Button
            label={t.addMore}
            icon="add"
            tone="outline"
            onPress={model.goMenu}
            style={{ paddingHorizontal: px(30), maxWidth: '42%', borderColor: colors.border }}
            textStyle={{ fontSize: px(23), lineHeight: px(30) }}
          />
          <Button
            label={t.checkout}
            icon="arrow-forward"
            testID="kiosk-cart-checkout"
            disabled={!model.cart.length || !model.cartValid}
            busy={model.busy}
            onPress={model.goLoyalty}
            style={{ flex: 1 }}
          />
        </View>
      </Footer>
    </View>
  );
}
export function ReviewScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const { px } = useMetrics();
  const t = copy(context.locale);
  const estimated = model.catalog?.estimated_minutes;
  return (
    <View testID="kiosk-screen-loyalty" style={layout.screen}>
      <Header {...context} title={t.review} back={model.openCart} />
      <ScrollView style={layout.grow} contentContainerStyle={{ padding: px(44), gap: px(30) }}>
        <Heading size={52}>{t.payTitle}</Heading>
        <View
          style={{
            backgroundColor: colors.white,
            borderRadius: px(24),
            padding: px(28),
            gap: px(20),
          }}
        >
          <View style={[layout.row, { gap: px(16) }]}>
            <Icon
              name={model.mode === 'dine_in' ? 'restaurant-outline' : 'bag-handle-outline'}
              color={colors.blue}
              size={px(34)}
            />
            <Heading size={28} color={colors.blue}>
              {model.mode === 'dine_in' ? t.here : t.togo}
            </Heading>
          </View>
          {estimated ? (
            <Body style={{ color: colors.muted }}>
              {t.preparation} {estimated.min}–{estimated.max} {t.minutes}
            </Body>
          ) : null}
          {model.cart.map((line) => (
            <View
              key={line.lineId}
              style={[
                layout.spread,
                { gap: px(20), borderTopWidth: 1, borderColor: colors.border, paddingTop: px(20) },
              ]}
            >
              <View style={{ flex: 1, gap: px(7) }}>
                <Body style={{ fontFamily: fonts.medium }}>
                  {line.product.name} × {line.quantity}
                </Body>
                <Body style={{ color: colors.muted, fontSize: Math.max(16, px(18)) }}>
                  {selectionSummary(line)}
                </Body>
              </View>
              <Heading size={26}>{money(line.lineTotalMinor)}</Heading>
            </View>
          ))}
        </View>
        <Body style={{ fontFamily: fonts.bold, color: colors.muted, letterSpacing: 0.7 }}>
          {t.payChoose}
        </Body>
        <View style={{ gap: px(18) }}>
          {(['kaspi', 'card'] as const).map((method) => (
            <Pressable
              key={method}
              testID={`kiosk-payment-method-${method}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: model.paymentMethod === method }}
              aria-checked={model.paymentMethod === method}
              onPress={() => model.setPaymentMethod(method)}
              style={{
                backgroundColor: colors.white,
                borderWidth: 3,
                borderColor: model.paymentMethod === method ? colors.blue : colors.border,
                borderRadius: px(26),
                padding: px(28),
                minHeight: px(120),
                flexDirection: 'row',
                alignItems: 'center',
                gap: px(24),
              }}
            >
              <View
                style={{
                  backgroundColor: method === 'kaspi' ? '#E52A2E' : colors.blue,
                  minWidth: px(66),
                  height: px(66),
                  borderRadius: px(17),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon
                  name={method === 'kaspi' ? 'qr-code-outline' : 'card-outline'}
                  color={colors.white}
                  size={px(34)}
                />
              </View>
              <Heading size={30} style={{ flex: 1 }}>
                {method === 'kaspi' ? 'Kaspi' : t.card}
              </Heading>
              <View
                style={{
                  width: px(34),
                  height: px(34),
                  borderRadius: px(17),
                  borderWidth: 3,
                  borderColor: model.paymentMethod === method ? colors.blue : colors.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {model.paymentMethod === method ? (
                  <View
                    style={{
                      width: px(18),
                      height: px(18),
                      borderRadius: 12,
                      backgroundColor: colors.blue,
                    }}
                  />
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
        <Body style={{ color: colors.muted }}>{t.testPayment}</Body>
      </ScrollView>
      <Footer>
        <View style={layout.spread}>
          <Heading size={30}>{t.toPay}</Heading>
          <Heading size={48} color={colors.blue}>
            {model.cartValid ? money(model.cartTotalMinor) : '—'}
          </Heading>
        </View>
        <Button
          label={t.createPayment}
          icon="arrow-forward"
          testID="kiosk-review-create"
          disabled={!model.cartValid || !model.cart.length}
          busy={model.busy}
          onPress={() => void model.beginPayment(model.paymentMethod)}
          style={{ minHeight: px(126) }}
        />
      </Footer>
    </View>
  );
}
