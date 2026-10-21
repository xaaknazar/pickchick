import { useWindowDimensions } from 'react-native';
export const colors = {
  blue: '#0047BB',
  orange: '#FF6900',
  background: '#F6F7F9',
  ink: '#15213A',
  muted: '#5A6579',
  border: '#DDE2EA',
  light: '#EDF1F7',
  dark: '#071B45',
  error: '#AF2525',
  white: '#FFFFFF',
  success: '#187244',
  // v3 kiosk palette (design/kiosk v3, 2026-10-08)
  navy: '#04143A',
  blueBright: '#014FCE',
  night: '#061B4E',
  cream: '#FEF8F0',
  peach: '#FFF0E5',
  // Orange roles. Owner decision 2026-10-10: calls to action and active controls use the
  // design orange #FF6900 with white text (an approved exception to the WCAG AA contrast
  // check, see tests/kiosk/browser_mobbin.py). Brand `orange` stays for fills, icons, halos.
  /** CTA and active-control surface under white text: the design orange (owner decision). */
  orangeCta: '#FF6900',
  /** Orange text on white/peach (5.4/4.85:1) and surfaces under small white text. */
  orangeInk: '#B84500',
  sky: '#EAF1FF',
  soft: '#EEF2FA',
  ok: '#13804A',
  glass: 'rgba(255,255,255,.14)',
  glassLine: 'rgba(255,255,255,.18)',
  onBlueMuted: 'rgba(255,255,255,.78)',
  /** Secondary text on a glass panel over brand blue (4.97:1 on #2461C5). */
  onGlass: '#E6EDF9',
  /** Small orange-tinted accent text on brand blue (4.9:1 on #014FCE). */
  orangeOnBlue: '#FFCFA8',
};
/**
 * Kiosk redesign 2026-10-13 (docs/design/kiosk-redesign-2026-10-13/README.md): owner-approved
 * tokens for the start, menu (bento) and smart-upsell screens. Payment and order screens keep
 * the v3 palette above.
 */
export const redesign = {
  /** Screen background: radial 120% 60% at 75% 0%, #1E6BE6 → #0047BB 45% → #02297A. */
  screen: ['#1E6BE6', '#0047BB', '#02297A'] as const,
  cta: '#FF6900',
  ctaShadow: 'rgba(255,105,0,.5)',
  /** Start CTA glow: 0 16 48 rgba(255,105,0,.45). */
  saluteShadow: 'rgba(255,105,0,.45)',
  cardInk: '#15213A',
  cardMuted: '#55617A',
  cream: '#FEF8F0',
  cardShadow: 'rgba(2,10,31,.25)',
  /** Glass for every header control and the bottom panels. */
  glass: 'rgba(14,22,48,.40)',
  glassLine: 'rgba(255,255,255,.20)',
  glassHighlight: 'rgba(255,255,255,.14)',
  glassShadow: 'rgba(2,10,31,.18)',
  /** Start screen: language switch and the Kaspi QR chip over the film. */
  startGlass: 'rgba(2,10,31,0.55)',
  startGlassLine: 'rgba(255,255,255,.18)',
  startChip: 'rgba(2,10,31,.28)',
  startChipLine: 'rgba(255,255,255,.2)',
  /** «ХИТ» / «ХИТ НЕДЕЛИ» badge gradient (135deg). */
  hit: ['#FF3B1F', '#D7141A'] as const,
  newBadge: '#0047BB',
  lemonadeBadge: '#FFC21A',
  added: '#2E9E5B',
  /** Darkening above the bottom panel, 220 tall. */
  scrim: ['rgba(2,10,31,0)', 'rgba(2,10,31,.55)'] as const,
  /** Salute particles. */
  spark: ['#FFD166', '#FFFFFF', '#FF6900'] as const,
};
export const fonts = {
  body: 'GolosText_400Regular',
  medium: 'GolosText_600SemiBold',
  bold: 'GolosText_700Bold',
  heading: 'Montserrat_700Bold',
  heavy: 'Montserrat_800ExtraBold',
  black: 'Montserrat_900Black',
};
export const tones = {
  default: colors.ink,
  muted: colors.muted,
  brand: colors.blue,
  inverse: colors.white,
  accent: colors.orange,
  danger: colors.error,
  success: colors.success,
  navy: colors.navy,
  onBlue: colors.onBlueMuted,
  deep: colors.orangeInk,
};
export type Tone = keyof typeof tones;
export function useMetrics() {
  const { width, height, fontScale } = useWindowDimensions();
  const scale = Math.max(0.8, Math.min(1.08, width / 1024));
  return {
    width,
    height,
    fontScale,
    scale,
    px: (n: number) => Math.round(n * scale),
    /** v3 design unit: the v3 kiosk was drawn at 820 pt; 13-inch screens get +25%. */
    v: (n: number) => Math.round(n * 1.25 * scale),
    body: Math.max(18, Math.round(21 * scale)),
    landscape: width > height,
    compact: height < 850,
    columns: width >= 1180 ? 3 : 2,
  };
}
