// Floating capsule tab bar (owner request 2026-10-11: Luma pattern in PickChick colors).
// Pure geometry and palette so the screens, the bar and unit tests share one source.

export const tabBarPalette = {
  // Navy glass from the brand theme (--glass in mobile-v2): 0.92 keeps inactive labels
  // AA-readable even over a white photo, opaque surface when transparency is reduced.
  glass: 'rgba(10, 32, 80, 0.92)',
  solid: '#0A2050',
  border: 'rgba(255, 255, 255, 0.10)',
  shadow: '#000000',
  // Active tab: raised navy pill with brand orange icon and label (accentText).
  pill: '#123068',
  active: '#FF8A3D',
  inactive: '#93A6C9',
} as const;

/** Labels follow Dynamic Type up to this factor; the bar must stay compact. */
export const tabLabelMaxScale = 1.3;

export type TabBarMetrics = {
  /** Distance from the bottom edge of the screen to the bottom of the capsule. */
  bottom: number;
  /** Horizontal inset of the capsule from each screen edge (before max width centering). */
  side: number;
  maxWidth: number;
  padding: number;
  itemHeight: number;
  height: number;
  /** Space the bar occupies from the screen bottom up to its top edge. */
  inset: number;
};

export function tabBarMetrics(
  insets: { bottom: number; left?: number; right?: number },
  fontScale = 1,
): TabBarMetrics {
  const scale = Math.min(Math.max(fontScale || 1, 1), tabLabelMaxScale);
  const label = Math.ceil(16 * scale);
  const padding = 5;
  // icon 23 + gap 3 + label, 6 above and below; never under the 48pt touch target.
  const itemHeight = Math.max(52, 6 + 23 + 3 + label + 6);
  const height = itemHeight + padding * 2;
  // Above the home indicator like Luma; devices without one keep a 12pt gap.
  const bottom = insets.bottom > 0 ? Math.max(12, insets.bottom - 14) : 12;
  const side = 16 + Math.max(insets.left ?? 0, insets.right ?? 0);
  return { bottom, side, maxWidth: 440, padding, itemHeight, height, inset: bottom + height };
}
