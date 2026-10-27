import { localize, useLocale } from '../i18n';
import type { ReactNode } from 'react';
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
 * The glass itself (blur of what is behind, brand veil, top sheen), clipped to `radius`. Shared
 * by the round buttons and by glass shapes that are not buttons (the Kaspi handle of the cart
 * bar), so every glass control in the app looks the same.
 */
export function GlassFill({ radius, pressed = false }: { radius: number; pressed?: boolean }) {
  // Every layer carries the radius itself (QA 27.10, item 13): the parent's clip alone does not
  // shape a backdrop blur (CSS backdrop-filter ignores an ancestor's rounded overflow, and
  // UIVisualEffectView needs its own corner clip), which showed a square patch around round
  // buttons inside the cart sheet.
  const round = { borderRadius: radius };
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, s.clip, round]}>
      {surface === 'blur' ? (
        <BlurView
          tint="dark"
          intensity={glass.blurIntensity}
          style={[StyleSheet.absoluteFill, s.clip, round]}
        />
      ) : null}
      <View
        style={[
          StyleSheet.absoluteFill,
          round,
          { backgroundColor: surface === 'blur' ? glass.veil : glass.fallback },
        ]}
      />
      <View style={[StyleSheet.absoluteFill, round, sheen]} />
      {pressed ? (
        <View style={[StyleSheet.absoluteFill, round, { backgroundColor: glass.pressedVeil }]} />
      ) : null}
    </View>
  );
}

/** The light rim of every glass control. */
export const glassRim = { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: glass.rim };

/**
 * One round glass icon button for the whole app (close, back, trash, quantity, the header
 * profile). Owner 27.10.2026: translucent glass with the blur of what is behind and a soft rim.
 * `children` replaces the icon (the profile avatar); the glass stays underneath.
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
  children,
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
  /** Custom content centred on the glass in place of the icon. */
  children?: ReactNode;
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
          <GlassFill radius={side / 2} pressed={pressed && !disabled} />
          {children ?? (
            <View pointerEvents="none" style={{ width: iconSize, height: iconSize }}>
              <Ionicons
                name={name}
                size={iconSize}
                color={color ?? (tone === 'danger' ? glass.danger : glass.icon)}
                allowFontScaling={false}
                style={s.glyph}
              />
            </View>
          )}
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
    ...glassRim,
    backgroundColor: 'transparent',
    boxShadow: '0 6px 18px rgba(0, 8, 30, 0.28)',
  },
  clip: { overflow: 'hidden' },
  disabled: { opacity: 0.45 },
  pressed: { transform: [{ scale: 0.95 }] },
  glyph: { includeFontPadding: false, textAlign: 'center', textAlignVertical: 'center' },
});
