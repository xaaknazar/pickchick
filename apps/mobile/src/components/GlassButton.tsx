import { localize, useLocale } from '../i18n';
import type { ReactNode } from 'react';
import { BlurView } from 'expo-blur';
import { GlassView } from 'expo-glass-effect';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type Insets,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MotionPressable, useReducedMotion } from './Motion';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { IconName } from './UI';
import {
  glass,
  glassBarBody,
  glassLayers,
  glassSize,
  liquidGlassConfig,
  type GlassPlace,
} from '../glass';
import { liquidGlassCapable, useGlassSurface } from './useGlassSurface';

export { useGlassSurface } from './useGlassSurface';

const RIM = StyleSheet.hairlineWidth * 2;
// Sheen and specular edge of the fallback glass (Liquid Glass draws its own light).
const highlight = {
  ...(Platform.OS === 'web'
    ? { backgroundImage: glass.sheen }
    : { experimental_backgroundImage: glass.sheen }),
  boxShadow: glass.specular,
} as ViewStyle;

/**
 * The light rim of every glass shape (buttons, the pay handle, the bag pill). On iOS 26 Apple's
 * glass draws its own edge, so the rim keeps its width (the layout and the handle's mark centring
 * do not move) and turns transparent; GlassFill then covers it.
 */
export const glassRim = {
  borderWidth: RIM,
  borderColor: liquidGlassCapable ? 'transparent' : glass.rim,
};

/**
 * The glass itself, clipped to `radius` (the shape's outer radius). Shared by the round buttons
 * and by glass shapes that are not buttons (the pay handle, the bag pill, the cart bar capsule),
 * so every glass control in the app looks the same.
 * - iOS 26+: Apple's Liquid Glass (`GlassView`, regular, dark), laid over the shape's rim (`rim`:
 *   the parent's border width, `glassRim` unless the parent says otherwise).
 * - Elsewhere: blur (expo-blur / CSS), a thin veil, a little lift, the sheen and the specular edge;
 *   `body={false}` leaves the body to the parent (the capsule paints its own) and adds the light.
 */
export function GlassFill({
  radius,
  pressed = false,
  place = 'pill',
  body = true,
  rim = RIM,
}: {
  radius: number;
  pressed?: boolean;
  place?: GlassPlace;
  body?: boolean;
  rim?: number;
}) {
  const surface = useGlassSurface();
  if (surface === 'liquid') {
    return (
      <GlassView
        pointerEvents="none"
        {...liquidGlassConfig(place)}
        style={{
          position: 'absolute',
          top: -rim,
          right: -rim,
          bottom: -rim,
          left: -rim,
          borderRadius: radius,
        }}
      />
    );
  }
  const layers = glassLayers(surface);
  // Every layer carries the radius itself (QA 27.10, item 13): the parent's clip alone does not
  // shape a backdrop blur (CSS backdrop-filter ignores an ancestor's rounded overflow, and
  // UIVisualEffectView needs its own corner clip), which showed a square patch around round
  // buttons inside the cart sheet.
  const round = { borderRadius: radius };
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, s.clip, round]}>
      {body && layers.blur ? (
        <BlurView
          tint="dark"
          intensity={glass.blurIntensity}
          style={[StyleSheet.absoluteFill, s.clip, round]}
        />
      ) : null}
      {body && layers.fill ? (
        <View style={[StyleSheet.absoluteFill, round, { backgroundColor: layers.fill }]} />
      ) : null}
      {body && layers.lift ? (
        <View style={[StyleSheet.absoluteFill, round, { backgroundColor: glass.lift }]} />
      ) : null}
      {layers.highlights ? <View style={[StyleSheet.absoluteFill, round, highlight]} /> : null}
      {pressed && layers.pressFeedback ? (
        <View style={[StyleSheet.absoluteFill, round, { backgroundColor: glass.pressedVeil }]} />
      ) : null}
    </View>
  );
}

/** The cart bar capsule's rim width (one hairline, as before 28.10: the bar keeps its size). */
export const glassBarRim = StyleSheet.hairlineWidth;

/**
 * The cart bar capsule's own body for the current surface: transparent under Liquid Glass (no
 * rim, no shadow of ours: Apple's glass has both), a CSS blur with a thinner veil on the web, the
 * dense navy natively without Liquid Glass, opaque with reduced transparency.
 */
export function useGlassBarStyle(): ViewStyle {
  const surface = useGlassSurface();
  const body = glassBarBody(surface, Platform.OS === 'web');
  return {
    backgroundColor: body.fill,
    borderWidth: glassBarRim,
    borderColor: body.rim,
    ...(surface === 'liquid' ? { shadowOpacity: 0, elevation: 0 } : null),
    ...(body.backdrop
      ? ({ backdropFilter: body.backdrop, WebkitBackdropFilter: body.backdrop } as ViewStyle)
      : null),
  };
}

/**
 * One round glass icon button for the whole app (close, back, trash, quantity, the header
 * profile). Owner 27.10.2026: translucent glass with the blur of what is behind and a soft rim;
 * owner 28.10.2026: exactly Apple's glass, so iOS 26 draws Apple's interactive Liquid Glass.
 * `children` replaces the icon (the profile avatar); it sits inside the glass.
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
  place = 'button',
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
  /** Where the button sits (the header profile over the hero video, or anywhere else). */
  place?: Extract<GlassPlace, 'button' | 'header'>;
  style?: StyleProp<ViewStyle>;
  /** Custom content centred on the glass in place of the icon. */
  children?: ReactNode;
}) {
  useLocale();
  const reduced = useReducedMotion();
  const surface = useGlassSurface();
  const side = glassSize(size);
  const round = { width: side, height: side, borderRadius: side / 2 };
  const content = children ?? (
    <View pointerEvents="none" style={{ width: iconSize, height: iconSize }}>
      <Ionicons
        name={name}
        size={iconSize}
        color={color ?? (tone === 'danger' ? glass.danger : glass.icon)}
        allowFontScaling={false}
        style={s.glyph}
      />
    </View>
  );
  const control = {
    accessibilityRole: 'button',
    accessibilityLabel: localize(label),
    accessibilityState: { disabled, ...(expanded === undefined ? {} : { expanded }) },
    'aria-disabled': disabled,
    disabled,
    onPress,
    testID,
    hitSlop,
  } as const;
  if (surface === 'liquid') {
    // Apple's own press response (scale, shine, flex) when the glass is interactive; no dimming of
    // ours (an effect view under a translucent parent renders wrong). Disabled: the glass stays,
    // the glyph dims. Reduced motion: no native flex, the glyph dims while pressed.
    const config = liquidGlassConfig(place);
    return (
      <Pressable {...control} style={[s.button, s.liquidButton, round, style]}>
        {({ pressed }) => (
          <GlassView
            {...config}
            isInteractive={config.isInteractive && !disabled && !reduced}
            style={[s.liquid, s.center, { borderRadius: side / 2 }]}
          >
            <View
              pointerEvents="none"
              style={[s.center, disabled ? s.disabledGlyph : pressed && reduced && s.pressedGlyph]}
            >
              {content}
            </View>
          </GlassView>
        )}
      </Pressable>
    );
  }
  return (
    <MotionPressable
      {...control}
      style={({ pressed }) => [
        s.button,
        s.fallbackButton,
        round,
        { borderColor: glassLayers(surface).rim },
        disabled && s.disabled,
        style,
        pressed && !reduced && s.pressed,
      ]}
    >
      {({ pressed }) => (
        <>
          <GlassFill radius={side / 2} pressed={pressed && !disabled} place={place} />
          {content}
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
    borderWidth: RIM,
    backgroundColor: 'transparent',
  },
  fallbackButton: { boxShadow: '0 6px 18px rgba(0, 8, 30, 0.28)' },
  // Apple's glass draws its own edge and shadow; the rim keeps its width for the same layout.
  liquidButton: { borderColor: 'transparent' },
  // Over the shape's (transparent) rim, so the glass edge is the shape's edge.
  liquid: { position: 'absolute', top: -RIM, right: -RIM, bottom: -RIM, left: -RIM },
  center: { alignItems: 'center', justifyContent: 'center' },
  clip: { overflow: 'hidden' },
  disabled: { opacity: 0.45 },
  disabledGlyph: { opacity: 0.45 },
  pressedGlyph: { opacity: 0.7 },
  pressed: { transform: [{ scale: 0.95 }] },
  glyph: { includeFontPadding: false, textAlign: 'center', textAlignVertical: 'center' },
});
