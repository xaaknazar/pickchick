import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import type { KioskMode, KioskStep } from '../model';
import { colors, fonts, useMetrics } from '../theme';
import { Wrapper } from './Wrapper';
import { fixedText } from './Body';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { Language } from './Language';
import { DiningSwitch } from './DiningSwitch';
import { usePress } from './motion';
export interface ScreenContext {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  onCancel: () => void;
  onHelp: () => void;
  /** How the current screen was reached; drives the screen entrance. */
  direction?: 'forward' | 'back';
  /** The step shown before this one (`boot` before the first screen). */
  from?: KioskStep | 'boot';
}
/** Single pilot point; the catalog carries only a branch id, not its display name. */
export const pilotBranch = 'ТЦ Abay Plaza';
/**
 * v3 header on blue/night surfaces, per design screen:
 * - dining choice (`onClose`): round close disc, logo, "PICK CHICK" over the
 *   branch, language pill (design 02, 105 high, side padding 28);
 * - menu (`onDining`, `minimal`): a small round cancel disc, the (static) logo,
 *   title over the branch, two-segment dining switch, language pill (design 03,
 *   113 high, side padding 24; owner decision 2026-10-10: the cancel is a
 *   visible disc, the logo is not a control);
 * - cart (`centered`, design 05): back pill, the title and subtitle centred, a
 *   white dining chip on the right ("В ЗАЛЕ" / "С СОБОЙ"), nothing else;
 * - other screens: back pill or logo, a white title (two lines when long) over
 *   the subtitle and the dining mode, glass help/cancel controls and a compact
 *   language switch, so the title is never cut to a letter.
 */
export function Header({
  locale,
  setLocale,
  onCancel,
  onHelp,
  back,
  backLabel,
  onClose,
  title,
  subtitle,
  mode,
  modeKind,
  dining,
  onDining,
  minimal = false,
  cancellable = true,
  centered = false,
  helpPill = false,
}: ScreenContext & {
  back?: () => void;
  /** Accessible name of the back pill or the close disc. */
  backLabel?: string;
  /** Design 02: a round close disc replaces the back pill, with the brand block. */
  onClose?: () => void;
  title?: string;
  subtitle?: string;
  /** Dining mode caption shown after the subtitle (with its own icon). */
  mode?: string;
  modeKind?: KioskMode | null;
  /** With `onDining`, the menu's in-place dining switch replaces the mode caption. */
  dining?: KioskMode | null;
  onDining?: (mode: KioskMode) => unknown;
  minimal?: boolean;
  /** `false` hides the cancel control (a screen whose own footer owns the way out). */
  cancellable?: boolean;
  /** Design 05 cart header: centred title, dining chip, no help/cancel/language. */
  centered?: boolean;
  /** Centred header (design 07): an outlined "Помощь" pill on the right. */
  helpPill?: boolean;
}) {
  const { v, px } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const backPress = usePress(0.96);
  const closePress = usePress(0.92);
  const brand = !!onClose;
  // Only the menu (design 03) carries the dining switch; cart, upsell, loyalty
  // and payment headers keep their own title/subtitle styling.
  const menu = !brand && !!onDining;
  const side = v(brand ? 28 : 24);
  const close = v(64);
  const logo = <Logo size={brand || menu ? 'regular' : 'large'} />;
  const long = (title?.length ?? 0) > 16;
  const backPill = back ? (
    <Animated.View style={{ transform: [{ scale: backPress.scale }] }}>
      <Pressable
        testID="kiosk-header-back"
        accessibilityRole="button"
        accessibilityLabel={backLabel ?? t.back}
        onPress={back}
        onPressIn={backPress.onPressIn}
        onPressOut={backPress.onPressOut}
        style={{
          minHeight: Math.max(52, v(64)),
          paddingLeft: v(14),
          paddingRight: v(22),
          borderRadius: 999,
          backgroundColor: colors.glass,
          flexDirection: 'row',
          alignItems: 'center',
          gap: v(8),
        }}
      >
        <Icon name="chevron-back" tone="inverse" />
        <Text
          {...fixedText}
          style={{ fontFamily: fonts.heavy, fontSize: v(18), color: colors.white }}
        >
          {backLabel ?? t.back}
        </Text>
      </Pressable>
    </Animated.View>
  ) : null;
  if (centered)
    return (
      <View
        style={{
          paddingTop: safe.top,
          paddingLeft: Math.max(safe.left, side),
          paddingRight: Math.max(safe.right, side),
          borderBottomWidth: 1,
          borderColor: colors.glassLine,
        }}
      >
        <View
          style={{
            minHeight: v(112),
            paddingVertical: v(10),
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: v(12),
          }}
        >
          {/* Without a way back (payment) the brand mark holds the left side. */}
          {backPill ?? <Logo size="regular" />}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: v(150),
              right: v(150),
              top: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
              gap: v(2),
            }}
          >
            <Text
              {...fixedText}
              accessibilityRole="header"
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{
                fontFamily: fonts.black,
                fontSize: v(32),
                lineHeight: v(38),
                letterSpacing: -0.4,
                color: colors.white,
                textAlign: 'center',
              }}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text
                {...fixedText}
                testID="kiosk-header-subtitle"
                numberOfLines={1}
                style={{
                  fontFamily: fonts.medium,
                  fontSize: v(16),
                  color: 'rgba(255,255,255,.75)',
                  textAlign: 'center',
                }}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
          {mode ? (
            <View
              testID="kiosk-header-mode"
              accessible
              accessibilityLabel={mode}
              style={{
                minHeight: v(56),
                paddingLeft: v(14),
                paddingRight: v(20),
                borderRadius: 999,
                backgroundColor: colors.white,
                flexDirection: 'row',
                alignItems: 'center',
                gap: v(8),
              }}
            >
              <Icon
                name={modeKind === 'dine_in' ? 'restaurant-outline' : 'bag-handle-outline'}
                size="small"
                tone="accent"
              />
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{ fontFamily: fonts.heavy, fontSize: v(16), color: colors.blue }}
              >
                {mode.toUpperCase()}
              </Text>
            </View>
          ) : helpPill ? (
            <Pressable
              testID="kiosk-header-help"
              accessibilityRole="button"
              accessibilityLabel={t.help}
              onPress={onHelp}
              style={{
                minHeight: Math.max(52, v(64)),
                paddingHorizontal: v(24),
                borderRadius: 999,
                borderWidth: 2,
                borderColor: 'rgba(255,255,255,.45)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{ fontFamily: fonts.heavy, fontSize: v(18), color: colors.white }}
              >
                {t.help}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
        </View>
      </View>
    );
  return (
    <View
      style={{
        paddingTop: safe.top,
        paddingLeft: Math.max(safe.left, side),
        paddingRight: Math.max(safe.right, side),
        borderBottomWidth: 1,
        borderColor: colors.glassLine,
      }}
    >
      <View
        style={{
          minHeight: brand ? v(104) : menu ? v(112) : undefined,
          paddingVertical: brand || menu ? v(10) : px(14),
          flexDirection: 'row',
          alignItems: 'center',
          gap: brand ? v(16) : menu ? v(12) : px(14),
        }}
      >
        {onClose ? (
          <Animated.View style={{ transform: [{ scale: closePress.scale }] }}>
            <Pressable
              testID="kiosk-header-back"
              accessibilityRole="button"
              accessibilityLabel={backLabel ?? t.back}
              onPress={onClose}
              onPressIn={closePress.onPressIn}
              onPressOut={closePress.onPressOut}
              style={{
                width: close,
                height: close,
                borderRadius: close / 2,
                backgroundColor: colors.glass,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="close" tone="inverse" />
            </Pressable>
          </Animated.View>
        ) : null}
        {menu ? <CancelDisc label={t.cancel} onPress={onCancel} /> : null}
        {back ? backPill : logo}
        {brand ? (
          <Wrapper flex={1} gap={2}>
            <Text
              {...fixedText}
              numberOfLines={1}
              style={{
                fontFamily: fonts.heavy,
                fontSize: v(13),
                letterSpacing: v(1.4),
                color: 'rgba(255,255,255,.6)',
              }}
            >
              PICK CHICK
            </Text>
            <Text
              {...fixedText}
              accessibilityRole="header"
              numberOfLines={1}
              style={{
                fontFamily: fonts.bold,
                fontSize: v(19),
                lineHeight: v(24),
                color: colors.white,
              }}
            >
              {subtitle ?? pilotBranch}
            </Text>
          </Wrapper>
        ) : (
          // The title keeps a readable minimum width; the language pill gives way first (its
          // options stop at 48 pt), so a crowded cart/upsell header no longer squeezes "Ваш
          // заказ" down to a single letter.
          <View style={{ flex: 1, gap: px(2), minWidth: v(menu ? 132 : 180) }}>
            <Text
              {...fixedText}
              accessibilityRole="header"
              numberOfLines={menu ? 1 : 2}
              style={{
                fontFamily: fonts.black,
                fontSize: v(title ? (menu ? 26 : long ? 24 : 28) : 15),
                lineHeight: v(title ? (menu ? 30 : long ? 27 : 32) : 18),
                letterSpacing: title ? -0.3 : 1.4,
                color: title ? colors.white : colors.onBlueMuted,
              }}
            >
              {title ?? 'PICK CHICK'}
            </Text>
            {subtitle || mode ? (
              <View
                style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: v(6) }}
              >
                {subtitle ? (
                  <Text
                    {...fixedText}
                    testID="kiosk-header-subtitle"
                    numberOfLines={1}
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: v(16),
                      color: menu ? 'rgba(255,255,255,.8)' : colors.onBlueMuted,
                    }}
                  >
                    {subtitle}
                  </Text>
                ) : null}
                {mode ? (
                  <View
                    testID="kiosk-header-mode"
                    accessible
                    accessibilityLabel={mode}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: v(4) }}
                  >
                    {subtitle ? (
                      <Text
                        {...fixedText}
                        style={{
                          fontFamily: fonts.medium,
                          fontSize: v(16),
                          color: colors.onBlueMuted,
                        }}
                      >
                        ·
                      </Text>
                    ) : null}
                    <Icon
                      name={modeKind === 'dine_in' ? 'restaurant-outline' : 'bag-handle-outline'}
                      size="small"
                      tone="inverse"
                    />
                    <Text
                      {...fixedText}
                      numberOfLines={1}
                      style={{ fontFamily: fonts.bold, fontSize: v(16), color: colors.white }}
                    >
                      {mode}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        )}
        {onDining ? (
          <DiningSwitch key={locale} mode={dining ?? null} locale={locale} onChange={onDining} />
        ) : null}
        {!minimal ? (
          <>
            <IconButton name="help-circle-outline" label={t.help} onPress={onHelp} tone="inverse" />
            {cancellable ? (
              <IconButton
                name="close"
                label={t.cancel}
                testID="kiosk-cancel-open"
                onPress={onCancel}
                tone="inverse"
              />
            ) : null}
          </>
        ) : null}
        <Language
          locale={locale}
          onChange={setLocale}
          tone={onDining ? 'menu' : brand ? 'default' : 'compact'}
        />
      </View>
    </View>
  );
}
/**
 * Menu cancel (owner decision 2026-10-10): a small visible glass disc with a cross; it opens
 * the cancel dialog. 46 pt on the 820-pt design, never below the 44 pt touch target.
 */
function CancelDisc({ label, onPress }: { label: string; onPress: () => void }) {
  const { v } = useMetrics();
  const press = usePress(0.92);
  const size = Math.max(44, v(46));
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <Pressable
        testID="kiosk-cancel-open"
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        hitSlop={v(6)}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.glass,
          borderWidth: 1,
          borderColor: colors.glassLine,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="close" size="small" tone="inverse" />
      </Pressable>
    </Animated.View>
  );
}
