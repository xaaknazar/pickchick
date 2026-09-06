import { Image } from 'expo-image';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { assets } from '../assets';
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
        detail="История, статусы и чеки появятся после входа. Сейчас онлайн-заказы ещё подключаются."
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
      'Ответ банка ещё не получен. Не оплачивайте заказ повторно — сначала проверим эту попытку.',
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
  if (!props.preview) return OrderUnavailable(props, 'Ваш заказ');
  return (
    <Page props={props} title="Ваш заказ">
      <Row>
        <Body style={ui.flex}>Заказ принят</Body>
        <Pill>С собой</Pill>
      </Row>
      <Heading style={s.trackerHeading}>Готовим{`\n`}для вас</Heading>
      <Text accessibilityLabel="Пример, заказ номер 083" style={s.trackerNumber}>
        083
      </Text>
      <Body muted>Ориентировочно ещё 6–9 минут · пример</Body>
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
            <Body muted={!active}>{label}</Body>
          </Row>
        ))}
      </View>
      <Card>
        <Row>
          <Icon name="location-outline" color={colors.accent} />
          <View style={ui.flex}>
            <Heading small>Тестовая точка</Heading>
            <Caption>Адрес получения · пример</Caption>
          </View>
        </Row>
      </Card>
      <Button title="Состав и чек" secondary onPress={() => props.navigate('M20')} />
    </Page>
  );
}
export function Ready(props: ScreenProps) {
  const insets = useSafeAreaInsets();
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
          style={s.readyNumber}
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
          Тестовая точка · Алматы
        </Caption>
      </ScrollView>
    </View>
  );
}
export function History(props: ScreenProps) {
  if (!props.preview)
    return (
      <Page props={props} title="Мои заказы" noBack>
        <Heading>Хорошие моменты{`\n`}стоит повторять</Heading>
        <Empty
          icon="receipt-outline"
          title="Пока без заказов"
          detail="Войдите по номеру, чтобы история и чеки были под рукой. Вход пока подключается."
          action={
            <Button title="Выбрать что-нибудь вкусное" onPress={() => props.navigate('M06')} />
          }
        />
      </Page>
    );
  return (
    <Page props={props} title="Мои заказы" noBack>
      <Heading>Ваши любимые{`\n`}моменты</Heading>
      <Caption>Демонстрационная история</Caption>
      {[
        { number: '083', state: 'Готовим', date: 'Сегодня · 14:32' },
        { number: '071', state: 'Выдан', date: 'Вчера · 18:15' },
      ].map((order) => (
        <Pressable
          key={order.number}
          accessibilityRole="button"
          onPress={() => props.navigate('M20')}
        >
          <Card>
            <Row>
              <Heading small style={ui.flex}>
                №{order.number}
              </Heading>
              <Pill>{order.state}</Pill>
            </Row>
            <Caption>{order.date} · Тестовая точка</Caption>
            <Row>
              <Image source={assets.combo} style={s.historyImage} contentFit="cover" />
              <View style={ui.flex}>
                <Body>Pick Combo</Body>
                <Caption>1 блюдо · с собой</Caption>
              </View>
              <Body style={{ fontFamily: font.bold }}>3 490 ₸</Body>
            </Row>
            <Row>
              <Caption style={ui.flex}>Пример заказа</Caption>
              <Icon name="chevron-forward" />
            </Row>
          </Card>
        </Pressable>
      ))}
    </Page>
  );
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
  const insets = useSafeAreaInsets();
  const levels = [
    { name: 'Новичок', rate: '3%', threshold: '0 ₸', width: '100%' as const },
    { name: 'Свой', rate: '5%', threshold: '25 000 ₸', width: '100%' as const },
    { name: 'Пик-мастер', rate: '7%', threshold: '75 000 ₸', width: '66%' as const },
    { name: 'Пик', rate: '10%', threshold: '200 000 ₸', width: '0%' as const },
  ];
  return (
    <View testID="screen-M23" style={[s.walletPage, { paddingTop: insets.top }]}>
      <View style={s.walletHeader}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Назад"
          onPress={props.goBack}
          style={s.walletBack}
        >
          <Icon name="chevron-back" size={21} color={colors.action} />
          <Text style={s.walletBackLabel}>Назад</Text>
        </Pressable>
      </View>
      <ScrollView
        testID="scroll-M23"
        style={ui.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          s.walletContent,
          { paddingBottom: Math.max(40, insets.bottom + 16) },
        ]}
      >
        {props.preview ? <ReviewBadge /> : null}
        <View style={s.walletCard}>
          <Image
            source={assets.mix}
            style={[StyleSheet.absoluteFill, { opacity: 0.55 }]}
            contentFit="cover"
          />
          <Text style={s.walletEyebrow}>КОШЕЛЁК ЧИКОВ</Text>
          <Row style={s.walletBalanceRow}>
            <Text style={s.walletBalance}>{props.preview ? '1 240' : '—'}</Text>
            <Text style={s.walletMoney}>
              {props.preview ? '= 1 240 ₸ · пример' : 'Баланс ещё недоступен'}
            </Text>
          </Row>
          <Row style={s.walletMetrics}>
            <View style={s.walletMetric}>
              <Text style={s.walletMetricLabel}>
                {props.preview ? 'Сгорит · пример' : 'Срок действия'}
              </Text>
              <Text style={s.walletMetricValue}>{props.preview ? '240' : '—'}</Text>
            </View>
            <View style={s.walletMetric}>
              <Text style={s.walletMetricLabel}>Заработано за 90 дней</Text>
              <Text style={s.walletMetricValue}>{props.preview ? '3 180' : '—'}</Text>
            </View>
          </Row>
          <Text style={s.walletNote}>
            {props.preview
              ? 'Пример кошелька. Начисления, курс и условия программы ещё согласуются.'
              : 'Чики появятся после входа и запуска программы лояльности.'}
          </Text>
          <View style={s.walletLogo}>
            <Logo size={44} />
          </View>
        </View>

        <Heading style={s.walletSection}>Уровни</Heading>
        <View style={s.walletLevelList}>
          {levels.map((level, index) => (
            <View
              key={level.name}
              style={[s.walletLevel, props.preview && index === 2 && s.walletLevelCurrent]}
            >
              <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <Row style={{ gap: 10 }}>
                  <Text style={s.walletLevelName}>{level.name}</Text>
                  {props.preview && index === 2 ? (
                    <Text style={s.walletLevelBadge}>ПРИМЕР УРОВНЯ</Text>
                  ) : null}
                </Row>
                <Text
                  style={[
                    s.walletLevelRate,
                    props.preview && index === 2 && { color: colors.accent },
                  ]}
                >
                  {props.preview ? level.rate : '—'}
                </Text>
              </Row>
              <Body muted style={s.walletLevelDetail}>
                {props.preview
                  ? 'Образец уровня: условия и преимущества ещё согласуются.'
                  : 'Условия и преимущества появятся к запуску программы.'}
              </Body>
              <Row style={s.walletLevelProgressRow}>
                <View style={s.walletLevelTrack}>
                  {props.preview ? (
                    <View
                      style={[
                        s.walletLevelFill,
                        {
                          width: level.width,
                          backgroundColor: index === 2 ? colors.accent : colors.muted,
                        },
                      ]}
                    />
                  ) : null}
                </View>
                <Text style={s.walletLevelThreshold}>
                  {props.preview ? level.threshold : 'Скоро'}
                </Text>
              </Row>
            </View>
          ))}
        </View>

        <Heading style={s.walletSection}>Как быстрее копить</Heading>
        <View style={s.walletInsetList}>
          {[
            {
              badge: 'Ч',
              title: 'Чики за заказы',
              detail: 'Начисление после запуска лояльности',
              target: 'M33' as const,
            },
            {
              badge: '★',
              title: 'События недели',
              detail: 'Игры и события Pick Chick',
              target: 'M26' as const,
            },
            {
              badge: '↑',
              title: 'Дорога наград',
              detail: 'Узнайте о следующих уровнях',
              target: 'M25' as const,
            },
          ].map((item) => (
            <Pressable
              key={item.title}
              accessibilityRole="button"
              onPress={() => props.navigate(item.target)}
              style={s.walletInsetRow}
            >
              <View style={s.walletEarnBadge}>
                <Text style={s.walletEarnSymbol}>{item.badge}</Text>
              </View>
              <View style={ui.flex}>
                <Body style={s.walletRowTitle}>{item.title}</Body>
                <Caption style={s.walletRowDetail}>{item.detail}</Caption>
              </View>
              <Icon name="chevron-forward" size={17} color={colors.muted} />
            </Pressable>
          ))}
        </View>

        <Heading style={s.walletSection}>История</Heading>
        <View style={s.walletInsetList}>
          <Pressable
            accessibilityRole="button"
            onPress={() => props.navigate('M24')}
            style={s.walletInsetRow}
          >
            <View style={ui.flex}>
              <Body style={s.walletRowTitle}>
                {props.preview ? 'За любимый заказ · пример' : 'Операций пока нет'}
              </Body>
              <Caption style={s.walletRowDetail}>
                {props.preview
                  ? 'Посмотреть образцы операций'
                  : 'Здесь будут начисления и списания'}
              </Caption>
            </View>
            {props.preview ? <Text style={s.walletHistoryAmount}>+120</Text> : null}
            <Icon name="chevron-forward" size={17} color={colors.muted} />
          </Pressable>
        </View>
        <View style={[s.walletInsetList, { marginTop: 22 }]}>
          {[
            { title: 'Мой QR', target: 'M29' as const },
            { title: 'Правила программы', target: 'M33' as const },
          ].map((item) => (
            <Pressable
              key={item.title}
              accessibilityRole="button"
              onPress={() => props.navigate(item.target)}
              style={s.walletInsetRow}
            >
              <Body style={[s.walletRowTitle, ui.flex]}>{item.title}</Body>
              <Icon name="chevron-forward" size={17} color={colors.muted} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
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
          <Notice>Все записи на этом экране — образцы для просмотра дизайна.</Notice>
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
  return (
    <Page props={props} title="Дорога наград">
      <Heading>Выше вкус.{`\n`}Ближе пик.</Heading>
      <Body muted>Каждый любимый момент — часть вашей истории с Pick Chick.</Body>
      <View style={s.rewardRoad}>
        {[
          { icon: 'flag-outline', title: 'Начало пути', detail: 'Добро пожаловать' },
          { icon: 'sparkles-outline', title: 'Первый пик', detail: 'Условия скоро появятся' },
          { icon: 'gift-outline', title: 'Новый вкус', detail: 'Награды готовятся' },
          { icon: 'trophy-outline', title: 'Пик-мастер', detail: 'Ваш следующий уровень' },
        ].map((item, index) => (
          <Row key={item.title} style={{ marginLeft: index % 2 ? 34 : 0 }}>
            <View style={[s.rewardNode, index === 0 && { borderColor: colors.accent }]}>
              <Icon
                name={item.icon as IconName}
                color={index === 0 ? colors.accent : colors.muted}
                size={30}
              />
            </View>
            <View style={ui.flex}>
              <Heading small>{item.title}</Heading>
              <Caption>{item.detail}</Caption>
            </View>
          </Row>
        ))}
      </View>
      <Notice>
        Условия уровней и наград ещё согласуются. Эти иллюстрации не обещают начисление бонусов.
      </Notice>
      <Button title="К моим Чикам" secondary onPress={() => props.navigate('M23')} />
    </Page>
  );
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
    color: colors.accent,
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
  walletPage: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  walletHeader: {
    paddingHorizontal: 18,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  walletBack: {
    minHeight: 44,
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  walletBackLabel: { fontFamily: font.medium, fontSize: 17, color: colors.action },
  walletContent: { paddingHorizontal: 18, paddingTop: 16 },
  walletCard: {
    padding: 22,
    backgroundColor: colors.action,
    borderRadius: 26,
    overflow: 'hidden',
  },
  walletEyebrow: { fontFamily: font.bold, fontSize: 11.5, letterSpacing: 1.38, color: '#FFFFFFB3' },
  walletBalanceRow: { marginTop: 10, gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' },
  walletBalance: {
    fontFamily: font.display,
    color: colors.white,
    fontSize: 52,
    lineHeight: 56,
    letterSpacing: -1.56,
  },
  walletMoney: { fontFamily: font.body, fontSize: 14, color: '#FFFFFFBF', paddingBottom: 6 },
  walletMetrics: { marginTop: 18, gap: 10, alignItems: 'stretch' },
  walletMetric: { flex: 1, backgroundColor: '#FFFFFF29', borderRadius: 14, padding: 12 },
  walletMetricLabel: { fontFamily: font.body, fontSize: 11.5, lineHeight: 16, color: '#FFFFFFBF' },
  walletMetricValue: {
    marginTop: 4,
    fontFamily: font.display,
    fontSize: 19,
    lineHeight: 25,
    color: '#FFFFFF',
  },
  walletNote: {
    marginTop: 14,
    paddingRight: 54,
    fontFamily: font.body,
    fontSize: 12.5,
    lineHeight: 18,
    color: '#FFFFFFB3',
  },
  walletLogo: { position: 'absolute', right: 16, bottom: 16, opacity: 0.95 },
  walletSection: {
    fontFamily: font.display,
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.2,
    marginTop: 22,
  },
  walletLevelList: { marginTop: 12, gap: 10 },
  walletLevel: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  walletLevelCurrent: { borderColor: colors.accent },
  walletLevelName: { fontFamily: font.display, fontSize: 18, lineHeight: 24, color: colors.text },
  walletLevelBadge: {
    fontFamily: font.bold,
    fontSize: 10.5,
    letterSpacing: 0.63,
    backgroundColor: colors.accent,
    color: '#FFFFFF',
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 20,
    overflow: 'hidden',
  },
  walletLevelRate: { fontFamily: font.display, fontSize: 17, lineHeight: 24, color: colors.muted },
  walletLevelDetail: { marginTop: 8, fontSize: 13, lineHeight: 20 },
  walletLevelProgressRow: { marginTop: 10, gap: 10 },
  walletLevelTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: colors.raised,
  },
  walletLevelFill: { height: 6, borderRadius: 3 },
  walletLevelThreshold: { fontFamily: font.medium, fontSize: 12, color: colors.muted },
  walletInsetList: {
    marginTop: 12,
    backgroundColor: colors.surface,
    borderRadius: 20,
    overflow: 'hidden',
  },
  walletInsetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    paddingHorizontal: 16,
    minHeight: 48,
    gap: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  walletEarnBadge: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: '#FF7A3D24',
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletEarnSymbol: { fontFamily: font.display, fontSize: 15, color: colors.accent },
  walletRowTitle: { fontFamily: font.medium, fontSize: 14.5, lineHeight: 21 },
  walletRowDetail: { marginTop: 2, fontSize: 12.5, lineHeight: 18 },
  walletHistoryAmount: { fontFamily: font.display, fontSize: 16, color: colors.success },
  rewardRoad: { gap: 35, paddingVertical: 24 },
  rewardNode: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 3,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
