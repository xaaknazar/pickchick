import { useState } from 'react';
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Product, ScreenProps } from '../model';
import { assets } from '../assets';
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
  Pill,
  ReviewBadge,
  Row,
  SummaryRow,
  styles as ui,
} from '../components/UI';

export function Welcome(props: ScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <View testID="screen-M01" style={[ui.page, { paddingTop: insets.top }]}>
      <Image source={assets.blue} style={StyleSheet.absoluteFill} contentFit="cover" />
      <ScrollView
        contentContainerStyle={[s.welcome, { paddingBottom: Math.max(insets.bottom, 24) }]}
      >
        <Row>
          <Logo size={60} />
          <Heading>Pick Chick</Heading>
        </Row>
        {props.preview ? <ReviewBadge /> : null}
        <View style={s.welcomeArt}>
          <Image source={assets.combo} style={s.welcomeFood} contentFit="cover" />
          <View style={s.welcomeSticker}>
            <Icon name="sparkles" color={colors.orangeInk} size={28} />
            <Body style={s.stickerText}>PICK YOUR PEAK</Body>
          </View>
        </View>
        <Heading style={s.welcomeHeading}>Твой выбор.{`\n`}Твой пик.</Heading>
        <Body style={{ color: '#DFE9FF' }}>
          Хрустящий вкус и любимые комбо.{`\n`}Добро пожаловать в Pick Chick.
        </Body>
        <Row style={{ marginVertical: 8 }}>
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
  const [category, setCategory] = useState('Комбо');
  const categories = [...new Set(props.model.products.map((product) => product.category))];
  const currentCategory = categories.includes(category) ? category : categories[0];
  const products = props.model.products.filter((product) => product.category === currentCategory);
  const compact = ['Допы', 'Напитки', 'Соусы'].includes(currentCategory ?? '');
  const total = props.model.cart.reduce(
    (sum, line) => sum + BigInt(line.product.priceMinor) * BigInt(line.quantity),
    0n,
  );
  const count = props.model.cart.reduce((sum, line) => sum + line.quantity, 0);
  function openProduct(product: Product) {
    props.model.selectProduct(product.id);
    props.navigate('M07');
  }
  return (
    <View testID="screen-M06" style={ui.page}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: count ? 100 : 30 }}
      >
        <View style={[s.hero, { height: 620 + insets.top }]}>
          <HeroVideo />
          <View style={[s.heroHeader, { paddingTop: insets.top + 12 }]}>
            <Row>
              <Logo />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Выбрать ресторан"
                onPress={() => props.navigate('M05')}
                style={ui.flex}
              >
                <Body style={{ fontFamily: font.bold }}>Pick Chick</Body>
                <Caption style={{ color: '#E0E9FA' }}>
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
            <DiningSelector value={props.model.diningMode} onChange={props.model.setDiningMode} />
          </View>
          <View style={s.heroCaption}>
            <Heading style={{ fontSize: 35, color: colors.white }}>Твой хрустящий пик</Heading>
            <Body style={{ color: colors.white }}>Любимые комбо. Твой выбор.</Body>
          </View>
        </View>
        <View style={s.menuBody}>
          <LoyaltyCard preview={props.preview} onPress={() => props.navigate('M23')} />
          {props.preview ? <ReviewBadge /> : null}
          {props.model.testFlow.available ? (
            <Notice title="Заказ на тестовую кухню">
              Вы можете проверить весь путь до выдачи. Деньги не списываются, ресторан тестовые
              заказы не готовит.
            </Notice>
          ) : null}
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
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.categoryList}
          >
            {categories.map((item) => (
              <Pressable
                key={item}
                testID={`category-${item}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: currentCategory === item }}
                onPress={() => setCategory(item)}
                style={({ pressed }) => [
                  s.category,
                  currentCategory === item && s.categorySelected,
                  pressed && ui.pressed,
                ]}
              >
                <Body style={s.categoryText}>{item}</Body>
              </Pressable>
            ))}
          </ScrollView>
          <Heading small>{currentCategory ?? 'Меню ресторана'}</Heading>
          <View style={compact ? s.compactGrid : s.productList}>
            {products.map((product, index) => (
              <Pressable
                key={product.id}
                testID={`product-${product.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${product.name}, ${MinorMoney(product.priceMinor)}`}
                onPress={() => openProduct(product)}
                style={({ pressed }) => [
                  s.product,
                  compact && s.compactProduct,
                  pressed && ui.pressed,
                ]}
              >
                <View style={[s.productPhotoWrap, compact && s.compactPhoto]}>
                  <Image
                    source={product.image}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                  />
                  {index === 0 && props.model.catalogMode === 'design' ? (
                    <View style={s.hit}>
                      <Caption style={s.hitText}>ХИТ</Caption>
                    </View>
                  ) : null}
                </View>
                <View style={s.productInfo}>
                  <Heading small style={{ fontSize: 21 }}>
                    {product.name}
                  </Heading>
                  <Caption style={s.productDescription}>{product.description}</Caption>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Body style={s.productPrice}>{MinorMoney(product.priceMinor)}</Body>
                    <View style={s.productPlus}>
                      <Icon name="add" color={colors.accent} size={20} />
                    </View>
                  </Row>
                </View>
              </Pressable>
            ))}
          </View>
          {!products.length && props.model.connection.status !== 'loading' ? (
            <Empty
              title="Меню скоро появится"
              detail="Мы готовим каталог этого ресторана."
              action={<Button title="Обновить меню" secondary onPress={props.model.refresh} />}
            />
          ) : null}
        </View>
      </ScrollView>
      {count ? (
        <Pressable
          testID="open-cart"
          accessibilityRole="button"
          accessibilityLabel={`Корзина, ${count} позиций, ${MinorMoney(total)}`}
          onPress={() => props.navigate('M09')}
          style={s.floatingCart}
        >
          <Icon name="bag-handle-outline" />
          <Body style={{ fontFamily: font.bold }}>Корзина · {count}</Body>
          <Body style={[ui.flex, { textAlign: 'right', fontFamily: font.bold }]}>
            {MinorMoney(total)}
          </Body>
        </Pressable>
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
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ height: 360 + insets.top, backgroundColor: '#E9EFF6' }}>
          <Image source={product.image} style={StyleSheet.absoluteFill} contentFit="cover" />
          <IconButton
            testID="product-close"
            name="close"
            label="Закрыть блюдо"
            onPress={props.goBack}
            style={[s.productClose, { top: insets.top + 12 }]}
          />
        </View>
        <View style={s.detailBody}>
          {props.preview ? <ReviewBadge /> : null}
          <Heading>{product.name}</Heading>
          <Body muted>{product.description}</Body>
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
      <View
        style={[
          ui.footer,
          {
            paddingBottom: Math.max(insets.bottom, 16),
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
          },
        ]}
      >
        <Button
          title={`Добавить · ${MinorMoney(product.priceMinor)}`}
          testID="product-add"
          onPress={() => {
            props.model.addToCart(product.id);
            props.navigate('M09');
          }}
        />
      </View>
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
          <NavRow
            title={props.model.branch?.name ?? 'Выберите ресторан'}
            subtitle={props.model.diningMode === 'takeaway' ? 'Заберу сам' : 'В зале'}
            icon="location-outline"
            onPress={() => props.navigate('M05')}
          />
          {props.model.catalogMode === 'design' ? (
            <Notice warning>Это корзина из образцов дизайна. Заказ и оплата недоступны.</Notice>
          ) : null}
          {props.model.cart.map((line) => (
            <View key={line.product.id} style={s.cartLine}>
              <Image source={line.product.image} style={s.cartImage} contentFit="cover" />
              <View style={ui.flex}>
                <Heading small style={{ fontSize: 19 }}>
                  {line.product.name}
                </Heading>
                <Body style={{ marginVertical: 6 }}>
                  {MinorMoney(BigInt(line.product.priceMinor) * BigInt(line.quantity))}
                </Body>
                <Row style={s.stepper}>
                  <IconButton
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
                    style={{ minWidth: 22, textAlign: 'center', fontFamily: font.bold }}
                  >
                    {line.quantity}
                  </Body>
                  <IconButton
                    name="add"
                    label={`Добавить ещё ${line.product.name}`}
                    testID={`cart-plus-${line.product.id}`}
                    onPress={() => props.model.setQuantity(line.product.id, line.quantity + 1)}
                  />
                </Row>
              </View>
            </View>
          ))}
          <NavRow title="Промокод" subtitle="Скоро можно будет применить при оформлении" disabled />
          <NavRow
            title="Использовать Чики"
            subtitle="После входа и подключения программы"
            disabled
          />
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
  welcome: { flexGrow: 1, padding: 24, gap: 16 },
  welcomeArt: { height: 205, marginVertical: 18, alignItems: 'center', justifyContent: 'center' },
  welcomeFood: { width: 226, height: 195, borderRadius: 46, transform: [{ rotate: '-8deg' }] },
  welcomeSticker: {
    backgroundColor: colors.accent,
    borderRadius: 16,
    padding: 12,
    position: 'absolute',
    bottom: -5,
    right: 0,
    flexDirection: 'row',
    gap: 7,
    alignItems: 'center',
    transform: [{ rotate: '5deg' }],
  },
  stickerText: { fontFamily: font.display, color: colors.orangeInk, fontSize: 14 },
  welcomeHeading: { fontFamily: font.display, fontSize: 46, lineHeight: 48 },
  dotActive: { width: 24, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#7897CA' },
  hero: { backgroundColor: colors.background, overflow: 'hidden' },
  heroHeader: { paddingHorizontal: 18, gap: 22 },
  heroBell: { backgroundColor: '#FFFFFF1F' },
  heroCaption: { position: 'absolute', left: 22, right: 74, bottom: 53, gap: 7 },
  menuBody: { paddingHorizontal: 18, marginTop: -26, gap: 22 },
  categoryList: { gap: 8, paddingVertical: 4 },
  category: {
    minHeight: 48,
    paddingHorizontal: 17,
    borderRadius: 24,
    backgroundColor: '#102957',
    borderWidth: 1,
    borderColor: '#294169',
    justifyContent: 'center',
  },
  categorySelected: { backgroundColor: colors.action, borderColor: colors.action },
  categoryText: { fontSize: 14, fontFamily: font.bold },
  productList: { gap: 24 },
  product: { flexDirection: 'row', gap: 15 },
  productPhotoWrap: {
    width: 116,
    height: 116,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#EAF0F8',
  },
  productInfo: { flex: 1, gap: 5, paddingVertical: 2 },
  productDescription: { fontSize: 12, lineHeight: 18 },
  productPrice: { fontFamily: font.heading, fontSize: 20, color: colors.accent },
  productPlus: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#15315B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hit: {
    position: 'absolute',
    top: 7,
    left: 7,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 7,
    backgroundColor: colors.accent,
  },
  hitText: { color: colors.orangeInk, fontFamily: font.bold, fontSize: 10 },
  compactGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  compactProduct: { width: '47%', flexDirection: 'column' },
  compactPhoto: { width: '100%', height: 145 },
  floatingCart: {
    position: 'absolute',
    bottom: 14,
    left: 18,
    right: 18,
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: colors.action,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 5 },
    shadowRadius: 14,
    elevation: 5,
  },
  productClose: { position: 'absolute', right: 16, backgroundColor: '#04143AD9' },
  detailBody: { padding: 20, gap: 20 },
  extraPhoto: { flex: 1, height: 122, borderRadius: 20, overflow: 'hidden' },
  comboPhoto: { width: '100%', height: 242, borderRadius: 24 },
  choiceImage: { width: 54, height: 54, borderRadius: 12 },
  cartLine: {
    flexDirection: 'row',
    gap: 16,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cartImage: { width: 98, height: 98, borderRadius: 18 },
  stepper: { backgroundColor: colors.raised, borderRadius: 15, alignSelf: 'flex-start', gap: 0 },
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
