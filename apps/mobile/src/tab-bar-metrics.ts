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

/** Owner 27.10.2026: Меню, События, Заказы. The profile moved to the top header. */
export const tabBarTabCount = 3;

/** Base label size: three tabs leave room for 12pt (11pt with four). Line height stays 16. */
export const tabLabelSize = 12;

/** iOS may shrink a label to this share of its size before truncating it. */
export const tabLabelMinFit = 0.8;

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

/**
 * The cart bar (quick pay) lives in the tab bar's own layer, laid out right on top of the tab
 * capsule (owner 28.10.2026, TestFlight 25: «быстрая оплата застревает за иконками»). Before, each
 * tab screen drew it at `bottom: inset` computed from this formula, in a layer UNDER the tab bar:
 * whenever the real tab bar came out taller than the formula, or the screen's frame was shifted
 * for a moment, the tab bar covered the cart bar and took its taps. Stacked in one layer they
 * cannot overlap; this is the gap between the two capsules.
 */
export const tabCartGap = 10;

/**
 * Height of the docked cart bar before its first layout (padding 10 + capsule 64 + rims +
 * the gap), so tab content does not jump while it is measured.
 */
export const tabCartDockEstimate = 86;

/**
 * Space the tab bar covers from the screen bottom, from the tab capsule's measured height (never
 * less than the formula, which also holds until the first layout). Screen footers and the
 * payment scenes sit above it.
 */
export function measuredTabBarInset(
  metrics: Pick<TabBarMetrics, 'bottom' | 'height'>,
  tabBarHeight?: number | null,
): number {
  return metrics.bottom + Math.max(metrics.height, Math.ceil(tabBarHeight ?? 0));
}

/**
 * Space a tab screen reserves under its content: the tab bar plus the docked cart bar's measured
 * height while the cart has lines (the estimate until it is measured with them).
 */
export function tabContentInset(
  tabBarInset: number,
  cartDockHeight: number | null | undefined,
  cartLines: number,
): number {
  return tabBarInset + (cartLines > 0 ? Math.ceil(cartDockHeight || tabCartDockEstimate) : 0);
}

/** Width of one tab: the items share the capsule evenly (flex: 1 in FloatingTabBar). */
export function tabItemWidth(
  screenWidth: number,
  metrics: Pick<TabBarMetrics, 'side' | 'maxWidth' | 'padding'>,
  count = tabBarTabCount,
): number {
  const bar = Math.min(metrics.maxWidth, screenWidth - metrics.side * 2);
  return (bar - metrics.padding * 2) / count;
}
