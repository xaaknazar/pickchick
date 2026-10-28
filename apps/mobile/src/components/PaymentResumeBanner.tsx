import { t, useLocale } from '../i18n';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MotionPressable as Pressable } from './Motion';
import { GlassFill, glassBarRim, useGlassBarStyle } from './GlassButton';
import { Icon } from './UI';
import { colors, font } from '../theme';
import { tabCartGap } from '../tab-bar-metrics';
import { showPendingPayment } from '../payment-recovery';
import { PAYMENT_RESUME_TITLE } from '../payment-resume';
import { hidePaymentResume, usePaymentResume } from './PaymentRecovery';

const RADIUS = 22;
/** Large text: the words grow up to x1.4, the banner grows with them (no clipped lines). */
const MAX_SCALE = 1.4;

/**
 * Owner 28.10.2026 (TestFlight 26): the app always opens on the menu, never on a payment screen.
 * A payment of an earlier run that the bank may still act on, and that the customer did not
 * close, is offered here instead: a small glass banner in the dock above the cart bar, on the
 * menu only. «Открыть заказ» opens its payment state (the recovery screen, /checkout) without
 * sending anything; the X hides it for good (the same «closed» as the X of the payment screen).
 */
export function PaymentResumeBanner({ cartBelow }: { cartBelow: boolean }) {
  useLocale();
  const resume = usePaymentResume();
  const router = useRouter();
  const glass = useGlassBarStyle();
  if (!resume) return null;
  const title = t(PAYMENT_RESUME_TITLE[resume.kind]);
  return (
    <View pointerEvents="box-none" style={[s.dock, !cartBelow && s.last]}>
      <View testID="payment-resume-banner" style={[s.banner, glass]}>
        <GlassFill radius={RADIUS + glassBarRim} rim={glassBarRim} place="bar" body={false} />
        <Pressable
          testID="payment-resume-open"
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityHint={t('Открыть заказ')}
          onPress={() => {
            // An explicit open: this run may show the intent's order (the recovery screen
            // restores it), but opening never sends its invoice: an unbilled order waits for
            // «Отправить счёт» (review 28.10.2026: the button says «Открыть заказ», not «Оплатить»).
            showPendingPayment(resume.key);
            router.push('/checkout');
          }}
          style={s.open}
        >
          <View style={s.mark} pointerEvents="none">
            <Icon name="receipt-outline" size={20} color={colors.accentText} />
          </View>
          <View style={s.words} pointerEvents="none">
            <Text testID="payment-resume-title" style={s.title} maxFontSizeMultiplier={MAX_SCALE}>
              {title}
            </Text>
            <Text style={s.action} maxFontSizeMultiplier={MAX_SCALE}>
              {t('Открыть заказ')}
            </Text>
          </View>
        </Pressable>
        <Pressable
          testID="payment-resume-close"
          accessibilityRole="button"
          accessibilityLabel={t('Скрыть напоминание об оплате')}
          onPress={() => void hidePaymentResume(resume)}
          style={s.close}
        >
          <Icon name="close" size={20} color={colors.white} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // The same column as the cart bar below it (CartShortcut: 24 pt sides, at most 320 pt wide).
  dock: { paddingTop: 10, paddingHorizontal: 24 },
  // Without the cart bar under it, the banner keeps the cart bar's gap to the tab capsule.
  last: { paddingBottom: tabCartGap },
  banner: {
    width: '100%',
    maxWidth: 320,
    alignSelf: 'center',
    minHeight: 56,
    borderRadius: RADIUS,
    flexDirection: 'row',
    alignItems: 'stretch',
    shadowColor: '#000000',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 14,
    elevation: 10,
  },
  open: {
    flex: 1,
    minWidth: 0,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingLeft: 10,
    borderRadius: RADIUS,
  },
  mark: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 138, 61, 0.16)',
  },
  words: { flex: 1, minWidth: 0, gap: 1 },
  title: {
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 19,
    color: colors.white,
    includeFontPadding: false,
  },
  action: {
    fontFamily: font.bold,
    fontSize: 13,
    lineHeight: 18,
    // The orange that stays readable on the dark glass (tab bar labels use it too).
    color: colors.accentText,
    includeFontPadding: false,
  },
  // A 44 pt target at the right end, as the glass X of the payment screens.
  close: {
    width: 44,
    minHeight: 44,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    borderRadius: 22,
  },
});
