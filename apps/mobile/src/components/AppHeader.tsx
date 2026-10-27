import { createContext, useContext } from 'react';
import { Platform, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { appHeaderMetrics } from '../app-header-metrics';
import { localize, t, useLocale } from '../i18n';
import type { ScreenProps } from '../model';
import { restaurantLocation } from '../restaurant-location';
import { colors, font } from '../theme';
import { MotionPressable as Pressable } from './Motion';
import { Icon, Logo } from './UI';
import { useTapGate } from './useTapGuard';

// Owner redesign 27.10.2026 (Drinkit pattern): one top header on Меню, События and Заказы.
// Logo, restaurant point and hours on the left; the profile button at the far right.
// Notifications live inside the profile, so the header never shows an unread mark.

type HeaderScreen = Pick<ScreenProps, 'model' | 'navigate' | 'preview'>;

/** Props of the screen being rendered, so nested headers (OrdersHeader) need no prop drilling. */
export const AppHeaderContext = createContext<HeaderScreen | null>(null);

/** Text sizes stay readable at large Dynamic Type but keep the row one line high. */
export const appHeaderMaxFontScale = appHeaderMetrics.maxFontScale;

function hoursCaption(location: ReturnType<typeof restaurantLocation>) {
  if (location?.opening_time && location.closing_time)
    return `${location.opening_time}-${location.closing_time}`;
  if (location?.closing_time) return t('до {p0}', { p0: location.closing_time });
  return 'Часы уточняются';
}

const webGlass =
  Platform.OS === 'web'
    ? ({
        backdropFilter: 'saturate(160%) blur(14px)',
        WebkitBackdropFilter: 'saturate(160%) blur(14px)',
      } as unknown as ViewStyle)
    : null;

/**
 * Header row: logo, restaurant picker (M05) and the round profile button. The row carries its
 * own gutter and width cap, so the button sits at the same point on every tab.
 */
export function AppHeaderBar({ screen }: { screen?: HeaderScreen }) {
  useLocale();
  const context = useContext(AppHeaderContext);
  const current = screen ?? context;
  // A double tap opens the profile once; the second tap is ignored while the push runs.
  const profileTap = useTapGate();
  if (!current) return null;
  const location = restaurantLocation(current.model.branch?.id);
  return (
    <View testID="app-header-bar" style={s.row}>
      <Logo size={appHeaderMetrics.logoSize} />
      <Pressable
        testID="header-restaurant"
        accessibilityRole="button"
        accessibilityLabel={t('Выбрать ресторан')}
        onPress={() => current.navigate('M05')}
        style={s.branch}
      >
        <Text style={s.title} numberOfLines={1} maxFontSizeMultiplier={appHeaderMaxFontScale}>
          {localize(location?.name ?? current.model.branch?.name ?? 'Выбрать ресторан')}
        </Text>
        <Text style={s.caption} numberOfLines={1} maxFontSizeMultiplier={appHeaderMaxFontScale}>
          {localize(hoursCaption(location))}
        </Text>
      </Pressable>
      <Pressable
        testID="header-profile"
        accessibilityRole="button"
        accessibilityLabel={t('Профиль')}
        feedback="scale"
        // A guest goes through the same auth gate the profile tab used (returnTo M30).
        onPress={() => profileTap.run(() => current.navigate('M30'))}
        style={({ pressed }) => [s.profile, webGlass, pressed && s.profilePressed]}
      >
        <Icon name="person-circle" size={40} color={colors.white} />
      </Pressable>
    </View>
  );
}

/** Fixed header for the События and Заказы tabs; the menu keeps its own collapsing shell. */
export function AppHeader({ safeArea = true }: { safeArea?: boolean }) {
  useLocale();
  const insets = useSafeAreaInsets();
  return (
    <View testID="app-header" style={[s.shell, { paddingTop: (safeArea ? insets.top : 0) + 8 }]}>
      <AppHeaderBar />
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flexShrink: 0, paddingBottom: 10, backgroundColor: colors.background, zIndex: 2 },
  row: {
    width: '100%',
    maxWidth: appHeaderMetrics.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: appHeaderMetrics.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  branch: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
    minHeight: 48,
    justifyContent: 'center',
  },
  title: {
    fontFamily: font.medium,
    fontSize: 17,
    lineHeight: 23,
    textAlign: 'left',
    color: colors.white,
  },
  caption: {
    fontFamily: font.body,
    fontSize: 13,
    lineHeight: 18,
    color: '#FFFFFFDD',
    textAlign: 'left',
  },
  // Drinkit-like round avatar button: white person disc inside a navy glass ring.
  profile: {
    width: appHeaderMetrics.profileSize,
    height: appHeaderMetrics.profileSize,
    borderRadius: appHeaderMetrics.profileSize / 2,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0B2454D9',
    borderWidth: 1,
    borderColor: '#FFFFFF66',
    boxShadow: '0 4px 14px rgba(0, 8, 30, 0.24)',
  },
  profilePressed: { backgroundColor: '#23467CEB' },
});
