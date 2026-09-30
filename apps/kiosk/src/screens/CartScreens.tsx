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
  IconButton,
  Language,
  Logo,
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
  const { px, fontScale } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(context.locale);
  const estimated = model.catalog?.estimated_minutes;
  const total = model.cartValid ? money(model.cartTotalMinor) : '-';
  return (
    <View testID="kiosk-screen-loyalty" style={layout.screen}>
      <LightBackground />
      <View
        style={{
          paddingTop: safe.top + px(22),
          paddingLeft: Math.max(safe.left, px(24)),
          paddingRight: Math.max(safe.right, px(24)),
          paddingBottom: px(16),
          gap: px(14),
        }}
      >
        <BluePattern />
        <View style={[layout.row, { gap: px(16) }]}>
          <IconButton name="arrow-back" label={t.back} dark onPress={model.openCart} />
          <Logo />
          <View
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: fontScale >= 1.3 ? 'column' : 'row',
              alignItems: fontScale >= 1.3 ? 'stretch' : 'center',
              gap: px(16),
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: px(3) }}>
              <Body
                style={{
                  fontSize: Math.max(16, px(18)),
                  fontFamily: fonts.bold,
                  letterSpacing: px(1.8),
                  color: 'rgba(255,255,255,.66)',
                }}
              >
                {model.mode === 'dine_in' ? t.here : t.togo}
              </Body>
              <Heading size={40} color={colors.white}>
                {t.payTitle}
              </Heading>
            </View>
            <View style={{ gap: px(3), alignItems: 'flex-end', flexShrink: 0 }}>
              <Body style={{ fontSize: Math.max(16, px(18)), color: 'rgba(255,255,255,.66)' }}>
                {t.toPay}
              </Body>
              <Heading size={42} color={colors.orange}>
                {total}
              </Heading>
            </View>
          </View>
        </View>
        <View style={[layout.row, { justifyContent: 'flex-end', gap: px(16) }]}>
          <IconButton name="help-circle-outline" label={t.help} dark onPress={context.onHelp} />
          <IconButton
            name="close"
            label={t.cancel}
            testID="kiosk-cancel-open"
            dark
            onPress={context.onCancel}
          />
          <Language locale={context.locale} onChange={context.setLocale} />
        </View>
      </View>
      <ScrollView
        style={layout.grow}
        onScrollBeginDrag={model.touch}
        contentContainerStyle={{ padding: px(24), paddingTop: px(26), gap: px(26) }}
      >
        <View
          style={{
            backgroundColor: colors.white,
            borderRadius: px(26),
            paddingHorizontal: px(26),
            paddingVertical: px(8),
            boxShadow: '0 2px 4px rgba(14,21,36,.05), 0 14px 30px rgba(14,21,36,.07)',
          }}
        >
          {model.cart.map((line) => (
            <View
              key={line.lineId}
              style={[
                layout.spread,
                {
                  alignItems: 'flex-start',
                  gap: px(20),
                  borderBottomWidth: 1.5,
                  borderColor: colors.light,
                  paddingVertical: px(18),
                },
              ]}
            >
              <View style={{ flex: 1, minWidth: 0, gap: px(5) }}>
                <Body style={{ fontSize: px(24), lineHeight: px(32), fontFamily: fonts.bold }}>
                  {line.product.name} × {line.quantity}
                </Body>
                {selectionSummary(line) ? (
                  <Body style={{ color: colors.muted, fontSize: Math.max(16, px(18)) }}>
                    {selectionSummary(line)}
                  </Body>
                ) : null}
              </View>
              <Heading size={25} style={{ fontFamily: fonts.heading }}>
                {money(line.lineTotalMinor)}
              </Heading>
            </View>
          ))}
          <View style={[layout.spread, { gap: px(20), paddingVertical: px(20) }]}>
            <Body style={{ fontFamily: fonts.bold, fontSize: px(22), color: colors.muted }}>
              {t.total}
            </Body>
            <Heading size={38} color={colors.blue}>
              {total}
            </Heading>
          </View>
          {estimated ? (
            <Body style={{ color: colors.muted, paddingBottom: px(16) }}>
              {t.preparation} {estimated.min}-{estimated.max} {t.minutes}
            </Body>
          ) : null}
        </View>
        <View style={{ gap: px(14) }}>
          <Body
            style={{
              fontSize: Math.max(16, px(19)),
              fontFamily: fonts.bold,
              color: colors.muted,
              letterSpacing: px(1.9),
              paddingLeft: px(6),
            }}
          >
            {t.payChoose}
          </Body>
          {(['kaspi', 'card'] as const).map((method) => (
            <Pressable
              key={method}
              testID={`kiosk-payment-method-${method}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: model.paymentMethod === method, disabled: model.busy }}
              aria-checked={model.paymentMethod === method}
              disabled={model.busy}
              onPress={() => model.setPaymentMethod(method)}
              style={{
                backgroundColor: model.paymentMethod === method ? '#F0F5FF' : colors.white,
                borderWidth: 2.5,
                borderColor: model.paymentMethod === method ? colors.blue : colors.border,
                borderRadius: px(24),
                paddingVertical: px(22),
                paddingHorizontal: px(26),
                minHeight: px(120),
                flexDirection: 'row',
                alignItems: 'center',
                gap: px(22),
              }}
            >
              <View
                style={{
                  backgroundColor: method === 'kaspi' ? '#E52A2E' : colors.blue,
                  width: px(84),
                  height: px(84),
                  borderRadius: px(22),
                  flexShrink: 0,
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
              <View style={{ flex: 1, minWidth: 0, gap: px(5) }}>
                <Heading size={30} style={{ fontFamily: fonts.heading }}>
                  {method === 'kaspi' ? 'Kaspi' : t.card}
                </Heading>
                <Body style={{ fontSize: Math.max(16, px(19)), color: colors.muted }}>
                  {context.locale === 'ru'
                    ? method === 'kaspi'
                      ? 'Тестовый сценарий Kaspi - без QR и списания денег.'
                      : 'Тестовый сценарий карты - без терминала и списания денег.'
                    : method === 'kaspi'
                      ? 'Kaspi сынағы - QR-кодсыз, ақша алынбайды.'
                      : 'Карта сынағы - терминалсыз, ақша алынбайды.'}
                </Body>
              </View>
              <View
                style={{
                  width: px(44),
                  height: px(44),
                  borderRadius: px(22),
                  borderWidth: 2.5,
                  flexShrink: 0,
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
            {model.cartValid ? money(model.cartTotalMinor) : '-'}
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
