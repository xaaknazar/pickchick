import { useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Product, ScreenProps } from '../model';
import { assets } from '../assets';
import { CartShortcut } from '../components/CartShortcut';
import { colors, font } from '../theme';
import { DiningSelector, HeroVideo, LoyaltyCard } from '../components/Brand';
import {
  Body,
  BottomActions,
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
  Pill,
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
  return (
    <Page props={props} title="Наши рестораны">
      <Heading>Где ваш{`\n`}следующий пик?</Heading>
      <Body muted>Выберите ресторан, чтобы увидеть его меню.</Body>
      <View style={s.branchMap}>
        <View style={s.mapRoadA} />
        <View style={s.mapRoadB} />
        <View style={s.mapPark} />
        <View style={s.mapPin}>
          <Icon name="location" size={28} color={colors.white} />
        </View>
        <Pill>Казахстан</Pill>
        <Caption style={s.mapLabel}>
          Схема · точный адрес появится после настройки ресторана
        </Caption>
      </View>
      {props.model.connection.status === 'loading' ? <Loading title="Ищем рестораны" /> : null}
      {props.model.branches.map((branch) => (
        <Pressable
          key={branch.id}
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
                <Caption style={{ marginTop: 7 }}>
                  {branch.ordering_enabled ? 'Приём заказов доступен' : 'Заказы пока недоступны'}
                </Caption>
              </View>
              <Icon
                name={props.model.branch?.id === branch.id ? 'checkmark-circle' : 'chevron-forward'}
                color={colors.accent}
              />
            </Row>
          </Card>
        </Pressable>
      ))}
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
  const { width } = useWindowDimensions();
  const scroll = useRef<ScrollView>(null);
  const sectionY = useRef<Record<string, number>>({});
  const [category, setCategory] = useState('Комбо');
  const [collapsed, setCollapsed] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(insets.top + 64);
  const [collapsedHeaderHeight, setCollapsedHeaderHeight] = useState(insets.top + 62);
  const [categoryTop, setCategoryTop] = useState(0);
  const [categoryHeight, setCategoryHeight] = useState(62);
  const [catalogTop, setCatalogTop] = useState(0);
  const categories = [...new Set(props.model.products.map((product) => product.category))];
  function openProduct(product: Product) {
    props.model.selectProduct(product.id);
    props.navigate('M07');
  }
  const categoryBar = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.categoryList}
    >
      {categories.map((item) => (
        <Pressable
          key={item}
          testID={`category-${item}`}
          hitSlop={{ top: 4, bottom: 4 }}
          accessibilityRole="tab"
          accessibilityState={{ selected: category === item }}
          onPress={() => {
            setCategory(item);
            scroll.current?.scrollTo({
              y: Math.max(
                0,
                catalogTop + (sectionY.current[item] ?? 0) - collapsedHeaderHeight - categoryHeight,
              ),
              animated: true,
            });
          }}
          style={({ pressed }) => [
            s.category,
            category === item && s.categorySelected,
            pressed && ui.pressed,
          ]}
        >
          <Body style={s.categoryText}>{item}</Body>
        </Pressable>
      ))}
    </ScrollView>
  );
  return (
    <View testID="screen-M06" style={[ui.page, { overflow: 'hidden' }]}>
      <ScrollView
        ref={scroll}
        testID="scroll-M06"
        style={ui.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        scrollEventThrottle={32}
        onScroll={({ nativeEvent }) => {
          const y = nativeEvent.contentOffset.y;
          setCollapsed(y > 100);
          setScrollY(y);
          const visible = categories
            .filter(
              (item) =>
                catalogTop + (sectionY.current[item] ?? 0) <=
                y + headerHeight + categoryHeight + 28,
            )
            .at(-1);
          if (visible) setCategory(visible);
        }}
      >
        <View
          testID="storefront-hero"
          style={[s.hero, { height: Math.max(560, Math.min(660, (width * 660) / 402)) }]}
        >
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
            style={s.heroCaption}
          >
            <Heading style={s.heroTitle}>Комбо недели</Heading>
            <Body style={s.heroSubtitle}>подробнее</Body>
          </Pressable>
        </View>
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
          {props.model.connection.status === 'online' && props.model.connection.message ? (
            <>
              <Notice warning title="Меню обновилось">
                {props.model.connection.message}
              </Notice>
              <NavRow title="Проверить изменения корзины" onPress={() => props.navigate('M10')} />
            </>
          ) : null}
        </View>
        <View
          onLayout={(e) => setCategoryTop(e.nativeEvent.layout.y)}
          style={{ height: categoryHeight }}
        />
        <View style={s.catalogSections} onLayout={(e) => setCatalogTop(e.nativeEvent.layout.y)}>
          {categories.map((item) => {
            const compact = ['Допы', 'Напитки', 'Соусы'].includes(item);
            return (
              <View
                key={item}
                onLayout={(e) => {
                  sectionY.current[item] = e.nativeEvent.layout.y;
                }}
              >
                <Heading small style={s.sectionTitle}>
                  {item}
                </Heading>
                <View style={compact ? s.compactGrid : s.productList}>
                  {props.model.products
                    .filter((product) => product.category === item)
                    .map((product, index) => (
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
                          {index === 0 &&
                          item === 'Комбо' &&
                          props.model.catalogMode === 'design' ? (
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
      </ScrollView>
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
              <Heading style={s.brandTitle}>Pick Chick</Heading>
              <Caption style={s.branchCaption}>
                {props.model.branch?.name ?? 'Выбрать ресторан'}⌄
              </Caption>
            </Pressable>
            <IconButton
              name="notifications-outline"
              label="Уведомления"
              onPress={() => props.navigate('M34')}
              style={s.heroBell}
            />
          </Row>
        </View>
        {!collapsed ? (
          <DiningSelector value={props.model.diningMode} onChange={props.model.setDiningMode} />
        ) : null}
      </View>
      <View
        onLayout={(e) => setCategoryHeight(e.nativeEvent.layout.height)}
        style={[
          s.stickyCategories,
          { top: Math.max(headerHeight, categoryTop - scrollY), opacity: categoryTop ? 1 : 0 },
        ]}
      >
        {categoryBar}
      </View>
      {!props.inTabLayout ? (
        <CartShortcut model={props.model} onPress={() => props.navigate('M09')} safeArea />
      ) : null}
    </View>
  );
}
export function ProductDetail(props: ScreenProps) {
  const insets = useSafeAreaInsets();
  const product = props.model.selectedProduct ?? props.model.products[0];
  const [details, setDetails] = useState(false);
  const [sauce, setSauce] = useState('Фирменный');
  if (!product)
    return (
      <Page props={props} title="Блюдо">
        <Empty
          title="Блюдо не выбрано"
          detail="Вернитесь в меню и выберите, что хочется попробовать."
          action={<Button title="В меню" onPress={() => props.navigate('M06')} />}
        />
      </Page>
    );
  return (
    <View testID="screen-M07" style={ui.page}>
      <ScrollView
        testID="scroll-M07"
        style={ui.scroll}
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ aspectRatio: 1, backgroundColor: '#E9EFF6' }}>
          {product.id === 'pick-combo' ? (
            <HeroVideo shaded={false} />
          ) : (
            <Image source={product.image} style={StyleSheet.absoluteFill} contentFit="cover" />
          )}
          <IconButton
            testID="product-close"
            name="close"
            label="Закрыть блюдо"
            onPress={props.goBack}
            style={[s.productClose, { top: insets.top + 8 }]}
            color="#12151C"
          />
        </View>
        <View style={s.detailBody}>
          {props.preview ? <ReviewBadge /> : null}
          <Heading style={{ fontFamily: font.display, fontSize: 30, lineHeight: 32 }}>
            {product.name}
          </Heading>
          <Body muted style={{ fontSize: 14.5, lineHeight: 22 }}>
            {product.description}
          </Body>
          <NavRow
            title="Состав и аллергены"
            subtitle="Что внутри любимого блюда"
            icon="information-circle-outline"
            onPress={() => setDetails(!details)}
          />
          {details ? (
            <Notice>
              Подробный состав, вес и аллергены пока не опубликованы рестораном. Уточните их у
              сотрудника до покупки.
            </Notice>
          ) : null}
          {props.preview ? (
            <>
              <Heading small>Соус на выбор</Heading>
              {['Фирменный', 'Томатный'].map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: sauce === item }}
                  onPress={() => setSauce(item)}
                >
                  <Card style={sauce === item ? { borderColor: colors.action } : undefined}>
                    <Row>
                      <View style={ui.flex}>
                        <Body>{item}</Body>
                        <Caption>Входит в комбо · пример</Caption>
                      </View>
                      <Icon
                        name={sauce === item ? 'radio-button-on' : 'radio-button-off'}
                        color={colors.accent}
                      />
                    </Row>
                  </Card>
                </Pressable>
              ))}
              <Caption>Выбор показан для оценки дизайна и не изменяет состав корзины.</Caption>
            </>
          ) : null}
          <Heading small>Ещё немного хруста</Heading>
          <Row>
            {[assets.fingers, assets.wedges].map((image, index) => (
              <View key={index} style={s.extraPhoto}>
                <Image source={image} style={StyleSheet.absoluteFill} contentFit="cover" />
              </View>
            ))}
          </Row>
          <Caption>Изображения из фирменного меню Pick Chick.</Caption>
        </View>
      </ScrollView>
      <BottomActions safeArea={!props.inTabLayout}>
        <Button
          title={`Добавить · ${MinorMoney(product.priceMinor)}`}
          testID="product-add"
          onPress={() => {
            props.model.addToCart(product.id);
            props.navigate('M09');
          }}
        />
      </BottomActions>
    </View>
  );
}
export function Combo(props: ScreenProps) {
  const [selected, setSelected] = useState('Фирменный');
  return (
    <Page
      props={props}
      title="Собери свой комбо"
      footer={<Button title="Комбо скоро появятся" disabled />}
    >
      <Image source={assets.combo} style={s.comboPhoto} contentFit="cover" />
      <Heading>Твой идеальный{`\n`}Pick Combo</Heading>
      <Body muted>Хрустящие фингерсы, любимый соус и напиток.</Body>
      <Row>
        <Pill>1 · Основное</Pill>
        <Pill>2 · Соус</Pill>
        <Pill>3 · Напиток</Pill>
      </Row>
      <Heading small>Выберите соус</Heading>
      <Caption>Один соус в составе комбо</Caption>
      {['Фирменный', 'Томатный'].map((item) => (
        <Pressable
          key={item}
          disabled={!props.preview}
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === item, disabled: !props.preview }}
          onPress={() => setSelected(item)}
        >
          <Card>
            <Row>
              <Image source={assets.sauce} style={s.choiceImage} contentFit="cover" />
              <Body style={ui.flex}>{item}</Body>
              <Icon
                name={selected === item ? 'radio-button-on' : 'radio-button-off'}
                color={colors.accent}
              />
            </Row>
          </Card>
        </Pressable>
      ))}
      <Notice>
        Ресторан ещё не опубликовал состав и доступные варианты комбо. Оформление откроется после
        настройки меню.
      </Notice>
    </Page>
  );
}
export function Cart(props: ScreenProps) {
  const total = props.model.cart.reduce(
    (sum, line) => sum + BigInt(line.product.priceMinor) * BigInt(line.quantity),
    0n,
  );
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
            <SummaryRow label="Итого по меню" value={MinorMoney(total)} strong />
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
              {props.model.diningMode === 'takeaway' ? 'Заберу сам' : 'В зале'} · после
              подтверждения заказа
            </Body>
          </Row>
          {props.model.catalogMode === 'design' ? (
            <Notice warning>Это корзина из образцов дизайна. Заказ и оплата недоступны.</Notice>
          ) : null}
          {props.model.cart.map((line) => (
            <View key={line.product.id} style={s.cartLine}>
              <Image source={line.product.image} style={s.cartImage} contentFit="cover" />
              <View style={ui.flex}>
                <Heading small style={{ fontSize: 17, lineHeight: 22 }}>
                  {line.product.name}
                </Heading>
                <Caption style={{ fontSize: 12, lineHeight: 17, marginTop: 4 }}>
                  {line.product.description}
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
                      onPress={() => props.model.setQuantity(line.product.id, line.quantity - 1)}
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
                      onPress={() => props.model.setQuantity(line.product.id, line.quantity + 1)}
                    />
                  </Row>
                  <Body style={{ fontFamily: font.display, fontSize: 17 }}>
                    {MinorMoney(BigInt(line.product.priceMinor) * BigInt(line.quantity))}
                  </Body>
                </Row>
              </View>
            </View>
          ))}
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
  const total = props.model.cart.reduce(
    (sum, line) => sum + BigInt(line.product.priceMinor) * BigInt(line.quantity),
    0n,
  );
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
            <Caption>Ресторан получения</Caption>
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
  branchTitle: { flex: 1, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  brandTitle: {
    fontFamily: font.display,
    fontSize: 19,
    lineHeight: 23,
    letterSpacing: -0.19,
    textAlign: 'center',
  },
  branchCaption: { fontSize: 12, lineHeight: 17, color: '#FFFFFFBB', textAlign: 'center' },
  heroBell: { width: 44, height: 44, backgroundColor: '#FFFFFF33' },
  heroCaption: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 164,
    gap: 6,
    alignItems: 'center',
    minHeight: 54,
  },
  heroTitle: {
    fontFamily: font.display,
    fontSize: 34,
    lineHeight: 36,
    letterSpacing: -0.68,
    color: colors.white,
    textAlign: 'center',
    textShadowColor: '#04143A88',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 18,
  },
  heroSubtitle: { fontSize: 14, lineHeight: 20, color: '#FFFFFFD9', textAlign: 'center' },
  menuBody: { paddingHorizontal: 18, marginTop: -104, gap: 16 },
  stickyCategories: { position: 'absolute', left: 0, right: 0, zIndex: 9 },
  categoryList: {
    gap: 8,
    paddingTop: 18,
    paddingBottom: 10,
    paddingHorizontal: 18,
    backgroundColor: colors.background,
  },
  category: {
    minHeight: 36,
    paddingHorizontal: 15,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  categorySelected: { backgroundColor: colors.action, borderColor: colors.action },
  categoryText: { fontSize: 13.5, lineHeight: 19, fontFamily: font.medium },
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
  productInfo: { flex: 1, gap: 5 },
  productTitle: { fontFamily: font.heading, fontSize: 19, lineHeight: 22, letterSpacing: -0.19 },
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
  branchMap: {
    height: 215,
    backgroundColor: '#142D50',
    borderRadius: 24,
    overflow: 'hidden',
    padding: 18,
  },
  mapRoadA: {
    position: 'absolute',
    top: 85,
    left: -30,
    width: 460,
    height: 22,
    backgroundColor: '#244367',
    transform: [{ rotate: '-28deg' }],
  },
  mapRoadB: {
    position: 'absolute',
    top: 10,
    left: 150,
    width: 21,
    height: 400,
    backgroundColor: '#244367',
    transform: [{ rotate: '-19deg' }],
  },
  mapPark: {
    position: 'absolute',
    top: 55,
    right: 40,
    width: 72,
    height: 55,
    borderRadius: 15,
    backgroundColor: '#254F4C',
    transform: [{ rotate: '-20deg' }],
  },
  mapPin: {
    position: 'absolute',
    top: 62,
    left: '42%',
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapLabel: { position: 'absolute', bottom: 15, left: 18, right: 18, color: '#D5E0F3' },
});
