import { createContext, useContext } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { appHeaderCaptionMinScale, appHeaderMetrics } from '../app-header-metrics';
import { localize, t, useLocale } from '../i18n';
import type { ScreenProps } from '../model';
import { restaurantLocation } from '../restaurant-location';
import { headerHoursCaption } from '../restaurant-hours';
import { useRestaurantHoursNow } from '../usePaymentAvailability';
import { colors, font } from '../theme';
import { useAccount } from '../useAccount';
import { GlassButton } from './GlassButton';
import { MotionPressable as Pressable } from './Motion';
import { Logo } from './UI';
import { useTapGate } from './useTapGuard';

/** The same picture as the avatar of the profile card (ProfileScreen). */
const profileAvatar = require('../../assets/profile/alex-avatar.png');

// Owner redesign 27.10.2026 (Drinkit pattern): one top header on Меню, События and Заказы.
// Logo, restaurant point and hours on the left; the profile button at the far right.
// Notifications live inside the profile, so the header never shows an unread mark.

type HeaderScreen = Pick<ScreenProps, 'model' | 'navigate' | 'preview'>;

/** Props of the screen being rendered, so nested headers (OrdersHeader) need no prop drilling. */
export const AppHeaderContext = createContext<HeaderScreen | null>(null);

/** Text sizes stay readable at large Dynamic Type but keep the row one line high. */
export const appHeaderMaxFontScale = appHeaderMetrics.maxFontScale;

/**
 * Hours under the restaurant name (owner 28.10.2026, Drinkit): today's hours while open,
 * «откроемся в 10:00» while closed. The server's published ordering hours first, otherwise the
 * restaurant directory; re-evaluated on the minute and on foreground.
 */
function HoursCaption({ model }: { model: HeaderScreen['model'] }) {
  useLocale();
  const { hours, status } = useRestaurantHoursNow(model);
  return (
    <Text
      testID="header-hours"
      style={s.caption}
      numberOfLines={1}
      maxFontSizeMultiplier={appHeaderMaxFontScale}
      // iOS: «откроемся завтра в 10:00» (KK and EN are as long) shrinks instead of truncating at
      // 320 pt with the largest text, never below its normal size.
      adjustsFontSizeToFit
      minimumFontScale={appHeaderCaptionMinScale}
    >
      {localize(headerHoursCaption(hours, status))}
    </Text>
  );
}

/**
 * Round glass profile button (owner 27.10.2026: «улучши дизайн иконки профиля»). Signed in: the
 * profile card's avatar clipped to the circle with a thin light rim. Guest, or while the account
 * is restored: a filled person glyph on the glass. Never an unread mark (notifications live in
 * the profile). The press scales slightly (GlassButton).
 */
function ProfileButton({ onPress }: { onPress(): void }) {
  useLocale();
  const account = useAccount();
  const size = appHeaderMetrics.profileSize;
  const avatar = account.ready && !!account.account;
  return (
    <GlassButton
      testID="header-profile"
      name="person"
      label={t('Профиль')}
      size={size}
      iconSize={24}
      onPress={onPress}
      style={avatar ? s.avatarRim : s.guestRim}
    >
      {avatar ? (
        <View nativeID="header-profile-avatar" pointerEvents="none" style={s.avatarClip}>
          <Image
            source={profileAvatar}
            contentFit="cover"
            accessible={false}
            style={StyleSheet.absoluteFill}
          />
        </View>
      ) : undefined}
    </GlassButton>
  );
}

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
        <HoursCaption model={current.model} />
      </Pressable>
      {/* A guest goes through the same auth gate the profile tab used (returnTo M30). */}
      <ProfileButton onPress={() => profileTap.run(() => current.navigate('M30'))} />
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
    // As tall as the profile button, so the row (and the button) sit at the same height as the
    // profile screen's top bar; still above the 44 pt target.
    minHeight: appHeaderMetrics.profileSize,
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
  // Thin light rim around the avatar; the guest glyph keeps a slightly brighter glass rim so the
  // circle reads on the bright hero video and on the dark events/orders background.
  avatarRim: { borderWidth: 1.5, borderColor: 'rgba(255, 255, 255, 0.78)' },
  guestRim: { borderColor: 'rgba(255, 255, 255, 0.4)' },
  avatarClip: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: appHeaderMetrics.profileSize / 2,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
});
