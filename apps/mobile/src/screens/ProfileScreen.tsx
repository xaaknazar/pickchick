import { MotionPressable as Pressable } from '../components/Motion';
import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { ComboRewardCard } from '../components/ComboRewardCard';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Icon, Loading, ReviewBadge, type IconName } from '../components/UI';
import { ProfileRestoreNotice } from '../components/ProfileRestoreNotice';
import { formatDemoPhone } from '../demo-account';
import { formatBirthDate } from '../profile-details';
import type { ScreenProps } from '../model';
import { brandColors, colors, font } from '../theme';
import { useAccount } from '../useAccount';

function ProfileRow({
  title,
  icon,
  value,
  onPress,
  testID,
  last = false,
}: {
  title: string;
  icon: IconName;
  value?: string;
  onPress?: () => void;
  testID?: string;
  last?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [s.row, !last && s.divider, pressed && s.pressed]}
    >
      <View style={s.rowIcon}>
        <Icon name={icon} size={21} color="#B8D0FF" />
      </View>
      <View style={s.flex}>
        <Text style={s.rowTitle}>{title}</Text>
        {value ? <Text style={s.rowValue}>{value}</Text> : null}
      </View>
      {onPress ? (
        <Icon name="chevron-forward" size={17} color={colors.muted} />
      ) : (
        <Text style={s.soon}>Скоро</Text>
      )}
    </Pressable>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={s.section}>
      <Text accessibilityRole="header" style={s.sectionTitle}>
        {title}
      </Text>
      <View style={s.group}>{children}</View>
    </View>
  );
}

export function Profile(props: ScreenProps) {
  const account = useAccount();
  const router = useRouter();
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const savedNickname =
    account.account?.profile.completedAt != null
      ? account.account.profile.nickname
      : account.account?.profile.nickname || props.model.nickname;
  const name = savedNickname || 'Любитель хруста';
  return (
    <View testID="screen-M30" style={s.screen}>
      <ScrollView
        testID="scroll-M30"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          s.content,
          {
            paddingTop: insets.top + 10,
            paddingBottom: Math.max(28, insets.bottom + 16, (props.cartBottomInset ?? 0) + 16),
          },
        ]}
      >
        {props.preview ? <ReviewBadge /> : null}
        <View style={s.header}>
          <Text accessibilityRole="header" style={s.title}>
            Профиль
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Настройки профиля"
            onPress={() => props.navigate('M34')}
            style={({ pressed }) => [s.settings, pressed && s.pressed]}
          >
            <Icon name="settings-outline" size={23} />
          </Pressable>
        </View>

        <View testID="profile-identity" style={s.identity}>
          {!account.ready ? (
            <Loading title="Восстанавливаем профиль…" />
          ) : (
            <>
              <View style={[s.identityRow, fontScale > 1.4 && { flexWrap: 'wrap' }]}>
                <View style={s.avatar}>
                  {account.account ? (
                    <Text style={s.initial}>{Array.from(name)[0]?.toUpperCase()}</Text>
                  ) : (
                    <Icon name="person-outline" size={28} color={colors.orangeInk} />
                  )}
                </View>
                <View style={s.flex}>
                  <Text style={s.name}>{account.account ? name : 'Добро пожаловать'}</Text>
                  <Text style={s.subtitle}>
                    {account.account
                      ? formatDemoPhone(account.account.phone)
                      : 'Без входа в аккаунт'}
                  </Text>
                  {account.account?.kind === 'local_demo' ? (
                    <Text style={s.demoLabel}>Профиль на устройстве</Text>
                  ) : null}
                </View>
                {account.account ? (
                  <Pressable
                    testID="profile-edit"
                    accessibilityRole="button"
                    accessibilityLabel="Редактировать профиль"
                    onPress={() => props.navigate('M04')}
                    style={({ pressed }) => [s.edit, pressed && s.pressed]}
                  >
                    <Icon name="create-outline" size={18} color="#BDD3FF" />
                  </Pressable>
                ) : null}
              </View>
              {!account.account ? (
                <>
                  <Text style={s.intro}>
                    Войдите, чтобы оформить заказ и сохранить свои данные.
                  </Text>
                  <Pressable
                    testID="profile-sign-in"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: account.busy }}
                    disabled={account.busy}
                    onPress={() => props.navigate('M02')}
                    style={({ pressed }) => [s.signIn, (pressed || account.busy) && s.pressed]}
                  >
                    <Text style={s.signInLabel}>Войти по номеру</Text>
                    <Icon name="arrow-forward" size={20} color={colors.orangeInk} />
                  </Pressable>
                </>
              ) : null}
            </>
          )}
          <ProfileRestoreNotice />
          {account.ready && account.error && account.mode === 'demo' ? (
            <Text style={s.error}>{account.error}</Text>
          ) : null}
        </View>

        <View style={[s.shortcuts, fontScale > 1.4 && { flexDirection: 'column' }]}>
          {(
            [
              {
                title: 'Мои заказы',
                detail: 'История и статусы',
                icon: 'receipt-outline',
                screen: 'M19',
                id: 'profile-orders',
              },
              {
                title: 'Помощь',
                detail: 'Мы рядом',
                icon: 'headset-outline',
                screen: 'M31',
                id: 'profile-help',
              },
            ] as const
          ).map((item) => (
            <Pressable
              key={item.id}
              testID={item.id}
              accessibilityRole="button"
              onPress={() => props.navigate(item.screen)}
              style={({ pressed }) => [s.shortcut, pressed && s.pressed]}
            >
              <Icon name={item.icon} size={24} color="#BDD3FF" />
              <Text style={s.shortcutTitle}>{item.title}</Text>
              <Text style={s.shortcutDetail}>{item.detail}</Text>
            </Pressable>
          ))}
        </View>

        <ComboRewardCard
          preview={props.preview}
          progress={props.model.testFlow.comboProgress}
          testID="profile-combo-reward"
          onMenu={() => props.navigate('M06')}
        />

        <Pressable
          testID="profile-loyalty"
          accessibilityRole="button"
          onPress={() => props.navigate('M23')}
          style={s.loyalty}
        >
          <View style={s.loyaltyIcon}>
            <Icon name="sparkles-outline" size={24} color={colors.accent} />
          </View>
          <View style={s.flex}>
            <Text style={s.loyaltyTitle}>Мои Чики и уровни</Text>
            <Text style={s.loyaltyCopy}>Твой путь к вершинам Алматы</Text>
          </View>
          <Icon name="chevron-forward" size={20} color={colors.muted} />
        </Pressable>

        <Group title="Программа Чиков">
          <ProfileRow
            title="Награды и миссии"
            icon="ribbon-outline"
            onPress={() => props.navigate('M25')}
          />
          <ProfileRow
            title="QR для кассы"
            value="Появится с программой Чиков"
            icon="qr-code-outline"
            onPress={() => props.navigate('M29')}
          />
          <ProfileRow title="Промокоды" icon="ticket-outline" />
          <ProfileRow title="Пригласите друга" icon="people-outline" last />
        </Group>

        <Group title="Аккаунт">
          <ProfileRow
            title="Мои данные"
            icon="person-outline"
            value={account.account ? savedNickname || 'Добавить имя' : 'Войти в аккаунт'}
            onPress={() => props.navigate(account.account ? 'M04' : 'M02')}
          />
          {account.account ? (
            <ProfileRow
              title="Дата рождения"
              icon="gift-outline"
              value={formatBirthDate(account.account.profile.birthDate) || 'Добавить'}
              testID="profile-birthday"
              onPress={() => props.navigate('M04')}
            />
          ) : null}
          <ProfileRow
            title="Уведомления"
            icon="notifications-outline"
            value="Заказы и предложения для вас"
            testID="profile-notifications"
            onPress={() => router.push('/notifications')}
          />
          <ProfileRow
            title="Язык"
            icon="globe-outline"
            value={props.model.locale === 'kk' ? 'Қазақша' : 'Русский'}
            onPress={() => props.navigate('M34')}
            last
          />
        </Group>

        <Group title="О Pick Chick">
          <ProfileRow
            title="Наши рестораны"
            icon="location-outline"
            onPress={() => props.navigate('M05')}
          />
          <ProfileRow
            title="Условия и конфиденциальность"
            icon="document-text-outline"
            onPress={() => props.navigate('M33')}
          />
          <ProfileRow
            title="Управление данными"
            icon="shield-checkmark-outline"
            onPress={() => props.navigate('M32')}
            last
          />
        </Group>

        {account.account ? (
          <Button
            title="Выйти из профиля"
            testID="demo-sign-out"
            secondary
            disabled={account.busy || !account.ready || props.preview}
            style={s.signOut}
            onPress={() => {
              if (!props.preview)
                void account.signOut().then((success) => {
                  if (success) props.model.setNickname('');
                });
            }}
          />
        ) : null}
        <Text style={s.version}>Pick Chick · приложение</Text>
        {!props.preview && props.openReview ? (
          <View style={s.group}>
            <ProfileRow
              testID="open-design-review"
              title="Все экраны дизайна"
              icon="color-palette-outline"
              onPress={props.openReview}
              last
            />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  content: { paddingHorizontal: 18, gap: 20, width: '100%', maxWidth: 680, alignSelf: 'center' },
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  title: { fontFamily: font.display, fontSize: 32, lineHeight: 42, color: colors.white },
  settings: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0B2454D9',
    borderWidth: 1,
    borderColor: '#FFFFFF40',
  },
  identity: {
    padding: 16,
    borderRadius: 24,
    backgroundColor: '#0B2454',
    borderWidth: 1,
    borderColor: '#FFFFFF14',
    gap: 16,
  },
  identityRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  avatar: {
    flexShrink: 0,
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: brandColors.brandOrange,
    borderWidth: 1,
    borderColor: brandColors.brandOrange,
  },
  initial: { fontFamily: font.display, fontSize: 30, lineHeight: 38, color: colors.orangeInk },
  name: { fontFamily: font.heading, fontSize: 22, lineHeight: 30, color: colors.white },
  subtitle: { marginTop: 4, fontFamily: font.body, fontSize: 14, lineHeight: 20, color: '#B6C4DD' },
  demoLabel: {
    marginTop: 4,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 18,
    color: '#B6C4DD',
  },
  intro: { fontFamily: font.body, fontSize: 14, lineHeight: 22, color: '#C0CDE3' },
  signIn: {
    backgroundColor: colors.accent,
    borderRadius: 16,
    minHeight: 52,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  signInLabel: {
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 22,
    color: colors.orangeInk,
    flexShrink: 1,
  },
  edit: {
    width: 48,
    flexShrink: 0,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#173666',
    paddingHorizontal: 8,
  },
  shortcuts: { flexDirection: 'row', gap: 12 },
  shortcut: {
    flex: 1,
    padding: 16,
    gap: 8,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: '#FFFFFF0D',
  },
  shortcutTitle: { fontFamily: font.bold, fontSize: 15, lineHeight: 21, color: colors.white },
  shortcutDetail: { fontFamily: font.body, fontSize: 13, lineHeight: 20, color: '#B6C4DD' },
  loyalty: {
    padding: 18,
    borderRadius: 22,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 88,
    borderWidth: 1,
    borderColor: '#FFFFFF12',
  },
  loyaltyIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#173666',
  },
  loyaltyTitle: { fontFamily: font.heading, fontSize: 18, lineHeight: 25, color: colors.white },
  loyaltyCopy: {
    fontFamily: font.body,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 4,
    color: colors.muted,
  },
  section: { gap: 10, marginTop: 6 },
  sectionTitle: {
    fontFamily: font.heading,
    fontSize: 20,
    lineHeight: 28,
    color: colors.white,
    paddingLeft: 2,
  },
  group: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: '#FFFFFF0D',
  },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', padding: 16, minHeight: 68 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#FFFFFF12' },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#7FA6F012',
  },
  rowTitle: { fontFamily: font.medium, fontSize: 15, lineHeight: 22, color: colors.white },
  rowValue: { fontFamily: font.body, fontSize: 13, lineHeight: 20, color: '#B6C4DD', marginTop: 3 },
  soon: { fontFamily: font.medium, fontSize: 11, lineHeight: 18, color: '#B6C4DD' },
  signOut: { borderRadius: 16, marginTop: 4 },
  version: {
    fontFamily: font.body,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    color: colors.muted,
  },
  error: { color: '#FFB0AB', fontFamily: font.body, fontSize: 14, lineHeight: 22 },
  pressed: { opacity: 0.78 },
});
