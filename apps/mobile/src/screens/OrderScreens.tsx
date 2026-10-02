import { OrderHistoryPreview } from './CompletedOrderPreview';
import { Image } from 'expo-image';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { assets } from '../assets';
import { PeakWallet, PeakRewards } from '../loyalty/PeakScreens';
import { restaurantLocation } from '../restaurant-location';
import type { ScreenProps } from '../model';
import { colors, font } from '../theme';
import {
  Body,
  Button,
  Caption,
  Card,
  Empty,
  Heading,
  Icon,
  Logo,
  NavRow,
  Notice,
  Page,
  Pill,
  ReviewBadge,
  Row,
  SummaryRow,
  styles as ui,
  type IconName,
} from '../components/UI';

export function OrderUnavailable(props: ScreenProps, title: string) {
  return (
    <Page props={props} title={title}>
      <Empty
        title="Здесь будут ваши заказы"
        detail="История, статусы и чеки появятся после первого заказа."
        action={<Button title="Посмотреть меню" onPress={() => props.navigate('M06')} />}
      />
    </Page>
  );
}
const paymentCopy: Record<
  string,
  { title: string; heading: string; detail: string; icon: IconName; steps: [string, string][] }
> = {
  M13: {
    title: 'Ожидаем оплату',
    heading: 'Ещё один шаг',
    detail: 'Подтвердите оплату в приложении банка. После возвращения проверим её результат.',
    icon: 'card-outline',
    steps: [
      ['Заказ', 'Сохранён'],
      ['Оплата', 'Ждём банк'],
      ['Ресторан', 'Ещё не получил заказ'],
    ],
  },
  M14: {
    title: 'Проверяем платёж',
    heading: 'Уточняем результат',
    detail:
      'Ответ банка ещё не получен. Не оплачивайте заказ повторно - сначала проверим эту попытку.',
    icon: 'hourglass-outline',
    steps: [
      ['Оплата', 'Результат неизвестен'],
      ['Повторный платёж', 'Недоступен'],
      ['Ресторан', 'Ждёт подтверждения'],
    ],
  },
  M15: {
    title: 'Оплата не завершена',
    heading: 'Не получилось оплатить',
    detail: 'Пример окончательного отказа банка. Деньги по этой попытке не подтверждены.',
    icon: 'close-circle-outline',
    steps: [
      ['Оплата', 'Окончательный отказ'],
      ['Ресторан', 'Заказ не отправлен'],
      ['Корзина', 'Сохранена'],
    ],
  },
  M16: {
    title: 'Ждём ресторан',
    heading: 'Оплачено.\nУже почти готовим',
    detail: 'Пример: банк подтвердил оплату. Ждём, когда ресторан примет заказ на кухню.',
    icon: 'checkmark-circle-outline',
    steps: [
      ['Оплата', 'Подтверждена'],
      ['Ресторан', 'Ждём принятия'],
      ['Чек', 'Ожидается'],
    ],
  },
};
export function PaymentStatus(props: ScreenProps) {
  const copy = paymentCopy[props.screenId] ?? paymentCopy.M14;
  if (!copy) return null;
  if (!props.preview)
    return (
      <Page props={props} title={copy.title}>
        <Empty
          icon="card-outline"
          title="Активного платежа нет"
          detail="Оплата через Kaspi пока подключается. Вы не создавали платёж, деньги не списываются."
          action={<Button title="В корзину" onPress={() => props.navigate('M09')} />}
        />
      </Page>
    );
  return (
    <Page props={props} title={copy.title}>
      <View style={s.paymentHero}>
        <View style={s.statusDisc}>
          <Icon
            name={copy.icon}
            size={50}
            color={props.screenId === 'M15' ? colors.danger : colors.accent}
          />
        </View>
        <Heading style={{ textAlign: 'center' }}>{copy.heading}</Heading>
        <Body muted style={{ textAlign: 'center' }}>
          {copy.detail}
        </Body>
      </View>
      <Card>
        <Row>
          <Heading small style={ui.flex}>
            Заказ №083
          </Heading>
          <Pill>Пример</Pill>
        </Row>
        {copy.steps.map(([label, value]) => (
          <SummaryRow key={label} label={label} value={value} />
        ))}
      </Card>
      {props.screenId === 'M13' || props.screenId === 'M14' ? (
        <Row style={{ justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
          <Caption>Пример ожидания серверного ответа</Caption>
        </Row>
      ) : null}
      <Notice warning>Это макет состояния. Банковская операция не выполнялась.</Notice>
      <Button title="Нужна помощь" secondary onPress={() => props.navigate('M31')} />
      {props.screenId === 'M15' ? (
        <Button title="Вернуться в корзину" onPress={() => props.navigate('M09')} />
      ) : null}
    </Page>
  );
}
export function Tracker(props: ScreenProps) {
  const { width, fontScale } = useWindowDimensions();
  const numberSize = Math.min(120, (width - 48) / (2.1 * fontScale));
  if (!props.preview) return OrderUnavailable(props, 'Ваш заказ');
  return (
    <Page props={props} title="Ваш заказ">
      <Row>
        <Body style={ui.flex}>Заказ принят</Body>
        <Pill>С собой</Pill>
      </Row>
      <Heading style={s.trackerHeading}>Готовим{`\n`}для вас</Heading>
      <Text
        accessibilityLabel="Пример, заказ номер 083"
        style={[s.trackerNumber, { fontSize: numberSize, lineHeight: numberSize * 1.16 }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        083
      </Text>
      <Body muted>Ориентировочно ещё 6-9 минут · пример</Body>
      <Row style={s.progress}>
        <View style={s.progressDone} />
        <View style={s.progressDone} />
        <View style={s.progressPending} />
      </Row>
      <View style={s.steps}>
        {[
          ['Оплата подтверждена', true],
          ['Ресторан принял заказ', true],
          ['Готовим и собираем', true],
          ['Можно забирать', false],
        ].map(([label, active]) => (
          <Row key={String(label)}>
            <Icon
              name={active ? 'checkmark-circle' : 'ellipse-outline'}
              color={active ? colors.accent : colors.muted}
            />
            <Body muted={!active} style={ui.flex}>
              {label}
            </Body>
          </Row>
        ))}
      </View>
      <Card>
        <Row>
          <Icon name="location-outline" color={colors.accent} />
          <View style={ui.flex}>
            <Heading small>{props.model.branch?.name ?? 'Ресторан PickChick'}</Heading>
            <Caption>
              {restaurantLocation(props.model.branch?.id)?.address ?? 'Ресторан получения'}
            </Caption>
          </View>
        </Row>
      </Card>
      <Button title="Состав и чек" secondary onPress={() => props.navigate('M20')} />
    </Page>
  );
}
export function Ready(props: ScreenProps) {
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const numberSize = Math.min(160, (width - 48) / (2.1 * fontScale));
  if (!props.preview) return OrderUnavailable(props, 'Выдача заказа');
  return (
    <View
      testID="screen-M18"
      style={[s.ready, { paddingTop: insets.top + 24, paddingBottom: Math.max(insets.bottom, 24) }]}
    >
      <Image
        source={assets.orange}
        style={[StyleSheet.absoluteFill, { opacity: 0.3 }]}
        contentFit="cover"
      />
      <ScrollView contentContainerStyle={s.readyContent}>
        <ReviewBadge />
        <Row>
          <View style={ui.flex}>
            <Heading style={s.readyTitle}>Готово!</Heading>
            <Body style={s.readyText}>Забирайте на кассе</Body>
          </View>
          <Logo size={48} />
        </Row>
        <Text
          accessibilityLabel="Пример, заказ номер 083"
          testID="ready-order-number"
          style={[s.readyNumber, { fontSize: numberSize, lineHeight: numberSize * 1.16 }]}
          adjustsFontSizeToFit
          numberOfLines={1}
        >
          083
        </Text>
        <Body style={[s.readyText, { textAlign: 'center', fontFamily: font.bold }]}>
          Ваш заказ ждёт на выдаче
        </Body>
        <Caption style={[s.readyText, { textAlign: 'center' }]}>
          Макет статуса · реального заказа нет
        </Caption>
        <View style={ui.flex} />
        <Button title="Состав и чек" secondary onPress={() => props.navigate('M20')} />
        <Caption style={[s.readyText, { textAlign: 'center', marginTop: 10 }]}>
          {props.model.branch?.name ?? 'Ресторан PickChick'}
        </Caption>
      </ScrollView>
    </View>
  );
}
export function History(props: ScreenProps) {
  if (!props.preview)
    return (
      <Page props={props} title="Мои заказы" noBack>
        <Empty
          icon="receipt-outline"
          title="Пока без заказов"
          detail="Здесь появятся ваши заказы. Выбирайте любимые блюда в меню."
          action={<Button title="Открыть меню" onPress={() => props.navigate('M06')} />}
        />
      </Page>
    );
  return <OrderHistoryPreview {...props} />;
}
export function OrderDetail(props: ScreenProps) {
  if (!props.preview) return OrderUnavailable(props, 'Детали заказа');
  return (
    <Page props={props} title="Заказ №083">
      <Row>
        <Heading style={ui.flex}>Ваш хрустящий{`\n`}выбор</Heading>
        <Pill>Пример</Pill>
      </Row>
      <Card>
        <SummaryRow label="Заказ" value="Готовится" />
        <SummaryRow label="Оплата" value="Подтверждена" />
        <SummaryRow label="Чек" value="Ожидается" />
        <SummaryRow label="Получение" value="С собой" />
      </Card>
      <Heading small>Состав заказа</Heading>
      <Row>
        <Image source={assets.combo} style={s.historyImage} contentFit="cover" />
        <View style={ui.flex}>
          <Body style={{ fontFamily: font.bold }}>Pick Combo</Body>
          <Caption>1 шт. · пример состава</Caption>
        </View>
        <Body>3 490 ₸</Body>
      </Row>
      <SummaryRow label="Итого" value="3 490 ₸" strong />
      <NavRow
        title="Электронный чек"
        subtitle="Статус документа"
        icon="receipt-outline"
        onPress={() => props.navigate('M21')}
      />
      <NavRow
        title="Отмена и возврат"
        subtitle="Условия и состояние обращения"
        onPress={() => props.navigate('M22')}
      />
      <NavRow
        title="Помощь с заказом"
        subtitle="Поддержка Pick Chick"
        onPress={() => props.navigate('M31')}
      />
      <Button title="Оценить пример заказа" secondary onPress={() => props.navigate('M35')} />
    </Page>
  );
}
export function Receipt(props: ScreenProps) {
  return (
    <Page props={props} title="Электронный чек">
      <View style={s.receiptPaper}>
        <Icon name="receipt-outline" color={colors.muted} size={42} />
        <Heading small style={s.receiptInk}>
          {props.preview ? 'Чек ожидается' : 'Чека пока нет'}
        </Heading>
        <View style={s.receiptRule} />
        <Body style={s.receiptInk}>
          {props.preview ? 'Заказ №083 · пример' : 'Здесь появится документ после покупки'}
        </Body>
        <Caption style={{ textAlign: 'center', color: '#56647A' }}>
          Документ, номер и QR появятся только после подтверждения ККМ.
        </Caption>
        <View style={s.receiptRule} />
        <Icon name="time-outline" color="#56647A" size={28} />
      </View>
      <Notice>
        Сервис электронных чеков подключается. Приложение не создаёт имитацию фискального документа.
      </Notice>
      <Button title="Открыть чек" disabled />
      <Button title="Помощь" secondary onPress={() => props.navigate('M31')} />
    </Page>
  );
}
export function Refund(props: ScreenProps) {
  return (
    <Page props={props} title="Отмена и возврат">
      <Heading>Поможем{`\n`}разобраться</Heading>
      <Body muted>
        Возможность отмены зависит от состояния заказа. Возврат денег и возвратный чек проверяются
        отдельно.
      </Body>
      <Card>
        {[
          ['Заказ', 'Не выбран'],
          ['Возврат денег', 'Не запрошен'],
          ['Возвратный чек', 'Нет документа'],
          ['Чики', 'Нет операции'],
        ].map(([label, value]) => (
          <SummaryRow key={label} label={label ?? ''} value={value ?? ''} />
        ))}
      </Card>
      <Button title="Запросить возврат" disabled />
      <Notice warning>
        Активного заказа и подключённого сервиса возвратов пока нет. Нажатие на экран не отменяет
        покупку.
      </Notice>
      <Button title="Связаться с поддержкой" secondary onPress={() => props.navigate('M31')} />
    </Page>
  );
}
export function Wallet(props: ScreenProps) {
  return <PeakWallet {...props} />;
}
export function Ledger(props: ScreenProps) {
  return (
    <Page props={props} title="История Чиков">
      <Heading>Каждый Чик{`\n`}на своём месте</Heading>
      {props.preview ? (
        <>
          {[
            {
              title: 'За любимый заказ',
              subtitle: 'Пример начисления',
              amount: '+120 Ч',
              icon: 'add-circle-outline',
            },
            {
              title: 'Чики в резерве',
              subtitle: 'Пример: ждём итог заказа',
              amount: '−80 Ч',
              icon: 'time-outline',
            },
            {
              title: 'Возврат Чиков',
              subtitle: 'Пример восстановления',
              amount: '+80 Ч',
              icon: 'return-down-back-outline',
            },
          ].map((entry) => (
            <Card key={entry.title}>
              <Row>
                <Icon name={entry.icon as IconName} color={colors.accent} />
                <View style={ui.flex}>
                  <Body style={{ fontFamily: font.bold }}>{entry.title}</Body>
                  <Caption>{entry.subtitle}</Caption>
                </View>
                <Body style={{ fontFamily: font.bold }}>{entry.amount}</Body>
              </Row>
            </Card>
          ))}
          <Notice>Все записи на этом экране - образцы для просмотра дизайна.</Notice>
        </>
      ) : (
        <Empty
          icon="sparkles-outline"
          title="История ещё впереди"
          detail="Начисления, обмен и возвраты будут показаны здесь после запуска Чиков."
        />
      )}
      <NavRow
        title="Как работают Чики"
        subtitle="Правила программы"
        onPress={() => props.navigate('M33')}
      />
    </Page>
  );
}
export function Rewards(props: ScreenProps) {
  return <PeakRewards {...props} />;
}
const s = StyleSheet.create({
  paymentHero: { paddingVertical: 22, gap: 22, alignItems: 'center' },
  statusDisc: {
    width: 110,
    height: 110,
    borderRadius: 38,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackerHeading: { fontSize: 48, lineHeight: 50, marginTop: 10 },
  trackerNumber: {
    fontFamily: font.display,
    fontSize: 120,
    lineHeight: 136,
    color: colors.accentText,
    letterSpacing: -5,
  },
  progress: { gap: 7 },
  progressDone: { flex: 1, height: 7, backgroundColor: colors.accent, borderRadius: 4 },
  progressPending: { flex: 1, height: 7, backgroundColor: colors.raised, borderRadius: 4 },
  steps: { gap: 21, paddingVertical: 8 },
  ready: { flex: 1, backgroundColor: colors.accent },
  readyContent: { paddingHorizontal: 24, gap: 24, flexGrow: 1 },
  readyTitle: { color: colors.orangeInk, fontSize: 46, lineHeight: 52 },
  readyText: { color: colors.orangeInk },
  readyNumber: {
    color: colors.orangeInk,
    fontFamily: font.display,
    fontSize: 185,
    letterSpacing: -9,
    textAlign: 'center',
    marginVertical: 28,
  },
  historyImage: { width: 70, height: 70, borderRadius: 16 },
  receiptPaper: {
    backgroundColor: '#F2F6FF',
    borderRadius: 20,
    padding: 30,
    gap: 23,
    alignItems: 'center',
    marginVertical: 12,
  },
  receiptInk: { color: '#24304A', textAlign: 'center' },
  receiptRule: { height: 1, width: '100%', backgroundColor: '#CBD3DF' },
});
