import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { LOCALES, LOCALE_LABELS, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { useTimingTo } from './motion';
type Tone = 'default' | 'inverse' | 'light' | 'menu';
/**
 * v3 language switch KZ / RU / EN. On the attract screen and the dining choice the active
 * language is a white capsule with navy text; in the menu header it is an orange capsule with
 * white text (prototype `lg.*BgO`). Switching crossfades the capsule and the label colour over
 * 200 ms, like the prototype's background/colour transition (instant under reduced motion).
 */
export function Language({
  locale,
  onChange,
  tone = 'default',
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
  /**
   * `default` sits on blue glass (dining choice, 306x60), `inverse` on photos (attract,
   * 124x60 options), `menu` in the menu header (258x52, orange active), `light` on light surfaces.
   */
  tone?: Tone;
}) {
  const { v } = useMetrics();
  const film = tone === 'inverse';
  const light = tone === 'light';
  const menu = tone === 'menu';
  return (
    <View
      style={{
        flexDirection: 'row',
        // A crowded header shrinks the options (never below a 48 pt target) instead of
        // pushing the last language past the screen edge.
        flexShrink: 1,
        minWidth: 0,
        padding: v(menu ? 4 : 5),
        borderRadius: 999,
        backgroundColor: film
          ? 'rgba(4,20,58,.42)'
          : menu
            ? 'rgba(4,20,58,.35)'
            : light
              ? colors.light
              : 'rgba(255,255,255,.12)',
        borderWidth: film || menu ? 1 : 0,
        borderColor: menu ? 'rgba(255,255,255,.2)' : colors.glassLine,
        gap: v(menu ? 2 : 4),
      }}
    >
      {LOCALES.map((value) => (
        <Option
          key={value}
          value={value}
          on={value === locale}
          tone={tone}
          onPress={() => onChange(value)}
        />
      ))}
    </View>
  );
}

function Option({
  value,
  on,
  tone,
  onPress,
}: {
  value: Locale;
  on: boolean;
  tone: Tone;
  onPress: () => void;
}) {
  const { v } = useMetrics();
  const film = tone === 'inverse';
  const menu = tone === 'menu';
  const light = tone === 'light';
  const fill = useTimingTo(on ? 1 : 0, 200, 'css');
  const { short, name } = LOCALE_LABELS[value];
  const text = { fontFamily: fonts.heavy, fontSize: v(film ? 20 : menu ? 14 : 17) };
  const size = film
    ? { width: v(124), height: v(60) }
    : menu
      ? { width: v(82), height: v(44) }
      : light
        ? { width: v(64), height: v(50) }
        : { width: v(96), height: v(50) };
  return (
    <Pressable
      testID={'kiosk-language-' + value}
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ selected: on }}
      aria-pressed={on}
      onPress={onPress}
      style={{
        width: Math.max(48, size.width),
        minWidth: 48,
        flexShrink: 1,
        minHeight: Math.max(44, size.height),
        paddingHorizontal: v(8),
        borderRadius: 999,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: 999,
            backgroundColor: menu ? colors.orange : colors.white,
            opacity: fill,
          },
        ]}
      />
      <View pointerEvents="none">
        <Animated.Text
          style={{
            ...text,
            color: light ? colors.muted : colors.white,
            opacity: fill.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          }}
        >
          {short}
        </Animated.Text>
        <Animated.Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          style={{
            ...text,
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            textAlign: 'center',
            color: menu ? colors.white : colors.navy,
            opacity: fill,
          }}
        >
          {short}
        </Animated.Text>
      </View>
    </Pressable>
  );
}
