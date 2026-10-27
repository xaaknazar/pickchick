import { useNotifications } from '../notifications/provider';
import { t, localize, useLocale } from '../i18n';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MotionPressable, ScreenTransition } from '../components/Motion';
import { Body, Button, Heading, Icon, IconButton, Row } from '../components/UI';
import { colors, font } from '../theme';

// Inbox transport is not enabled yet. Do not invent messages or unread counts.
// Owner 27.10.2026: opened from the profile row «Уведомления»; back returns to the profile.
export default function Notifications() {
  useLocale();
  const notifications = useNotifications();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'orders' | 'personal'>('orders');
  const orders = tab === 'orders';
  return (
    <ScreenTransition testID="notifications-screen" style={s.screen}>
      <Row style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconButton
          name="chevron-back"
          label={t('Назад в профиль')}
          testID="notifications-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/profile'))}
        />
        <Heading small style={s.title}>
          {t('Уведомления')}
        </Heading>
      </Row>
      <ScrollView
        contentContainerStyle={[s.content, { paddingBottom: Math.max(24, insets.bottom) }]}
      >
        <View accessibilityRole="tablist" style={s.tabs}>
          {(
            [
              { id: 'orders', title: 'Заказы' },
              { id: 'personal', title: 'Для вас' },
            ] as const
          ).map((item) => (
            <MotionPressable
              key={item.id}
              testID={`notifications-tab-${item.id}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === item.id }}
              aria-selected={tab === item.id}
              onPress={() => setTab(item.id)}
              style={[s.tab, tab === item.id && s.selectedTab]}
            >
              <Body style={[s.tabText, tab === item.id && s.selectedText]}>
                {localize(item.title)}
              </Body>
            </MotionPressable>
          ))}
        </View>
        {notifications.error ? (
          <View style={{ gap: 12, marginVertical: 16 }}>
            <Body>{t(notifications.error)}</Body>
            <Button
              title={t('Повторить')}
              secondary
              onPress={() => {
                void notifications.refresh();
              }}
            />
          </View>
        ) : null}
        {orders && notifications.items.length ? (
          notifications.items.map((item) => (
            <MotionPressable
              key={item.id}
              testID={`notification-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${item.title}. ${item.body}`}
              onPress={() => {
                void notifications.open(item);
              }}
              style={{
                padding: 18,
                marginVertical: 6,
                borderRadius: 18,
                backgroundColor: colors.raised,
                gap: 8,
              }}
            >
              <Heading small>{item.title}</Heading>
              <Body muted>{item.body}</Body>
            </MotionPressable>
          ))
        ) : (
          <View testID={`notifications-empty-${tab}`} style={s.empty}>
            <View style={s.icon}>
              <Icon
                name={orders ? 'notifications-outline' : 'gift-outline'}
                size={36}
                color={colors.accent}
              />
            </View>
            <Heading small style={s.center}>
              {localize(orders ? 'Следим за вашим заказом' : 'Хорошие новости впереди')}
            </Heading>
            <Body muted style={s.center}>
              {localize(
                orders
                  ? 'Здесь появятся сообщения о ваших заказах. Пока их статус можно посмотреть в разделе «Заказы».'
                  : 'Здесь появятся ваши предложения, подарки и новости о Чиках. А пока загляните в события.',
              )}
            </Body>
            <Button
              title={localize(orders ? 'Мои заказы' : 'Открыть события')}
              secondary
              testID="notifications-destination"
              // Back to the existing tabs (below the profile) instead of stacking a second set.
              onPress={() => router.dismissTo(orders ? '/(tabs)/orders' : '/(tabs)/events')}
              style={s.action}
            />
          </View>
        )}
      </ScrollView>
    </ScreenTransition>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 18, paddingBottom: 20, gap: 12 },
  title: { flex: 1 },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
    paddingHorizontal: 20,
  },
  tabs: {
    flexDirection: 'row',
    borderRadius: 16,
    padding: 4,
    gap: 4,
    backgroundColor: colors.raised,
  },
  tab: {
    flex: 1,
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  selectedTab: { backgroundColor: colors.action },
  tabText: { fontFamily: font.bold, color: colors.muted },
  selectedText: { color: colors.white },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 18,
    maxWidth: 380,
    alignSelf: 'center',
    width: '100%',
  },
  icon: {
    width: 88,
    height: 88,
    borderRadius: 28,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  center: { textAlign: 'center' },
  action: { alignSelf: 'stretch', marginTop: 12 },
});
