import { localize, useLocale } from '../i18n';
import { requireOptionalNativeModule } from 'expo';
import { BlurView } from 'expo-blur';
import {
  Platform,
  StyleSheet,
  View,
  type Insets,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MotionPressable, useReducedMotion } from './Motion';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { IconName } from './UI';
import { glass, glassSize, glassSurface } from '../glass';

// Checked once per process: a binary built before expo-blur keeps the tinted fallback.
const surface = glassSurface(
  Platform.OS,
  Platform.OS === 'ios' && requireOptionalNativeModule('ExpoBlur') != null,
);
const sheen = (
  Platform.OS === 'web'
    ? { backgroundImage: glass.sheen }
    : { experimental_backgroundImage: glass.sheen }
) as ViewStyle;

/**
 * One round glass icon button for the whole app (close, back, trash, quantity).
 * Owner 27.10.2026: translucent glass with the blur of what is behind and a soft light rim.
 */
export function GlassButton({
  name,
  label,
  onPress,
  testID,
  disabled = false,
  tone = 'default',
  color,
  size,
  iconSize = 22,
  hitSlop,
  expanded,
  style,
}: {
  name: IconName;
  label: string;
  onPress(): void;
  testID?: string;
  disabled?: boolean;
  /** «danger»: red glyph (delete the cart), as in the owner's Drinkit reference. */
  tone?: 'default' | 'danger';
  color?: string;
  size?: number;
  iconSize?: number;
  hitSlop?: Insets;
  /** For a control that opens a menu (order actions). */
  expanded?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  useLocale();
  const reduced = useReducedMotion();
  const side = glassSize(size);
  const round = { width: side, height: side, borderRadius: side / 2 };
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={localize(label)}
      accessibilityState={{ disabled, ...(expanded === undefined ? {} : { expanded }) }}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        s.button,
        round,
        disabled && s.disabled,
        style,
        pressed && !reduced && s.pressed,
      ]}
    >
      {({ pressed }) => (
        <>
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, s.clip, { borderRadius: side / 2 }]}
          >
            {surface === 'blur' ? (
              <BlurView
                tint="dark"
                intensity={glass.blurIntensity}
                style={StyleSheet.absoluteFill}
              />
            ) : null}
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: surface === 'blur' ? glass.veil : glass.fallback },
              ]}
            />
            <View style={[StyleSheet.absoluteFill, sheen]} />
            {pressed && !disabled ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: glass.pressedVeil }]} />
            ) : null}
          </View>
          <View pointerEvents="none" style={{ width: iconSize, height: iconSize }}>
            <Ionicons
              name={name}
              size={iconSize}
              color={color ?? (tone === 'danger' ? glass.danger : glass.icon)}
              allowFontScaling={false}
              style={s.glyph}
            />
          </View>
        </>
      )}
    </MotionPressable>
  );
}

const s = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: glass.rim,
    backgroundColor: 'transparent',
    boxShadow: '0 6px 18px rgba(0, 8, 30, 0.28)',
  },
  clip: { overflow: 'hidden' },
  disabled: { opacity: 0.45 },
  pressed: { transform: [{ scale: 0.95 }] },
  glyph: { includeFontPadding: false, textAlign: 'center', textAlignVertical: 'center' },
});
