/**
 * Hero video on the menu (owner 27.10.2026, «как у Drinkit»): it keeps playing while a sheet
 * (cart, checkout, order status, sign-in) lies over the menu, and pauses when another tab or a
 * full screen covers it, when the app is in the background or when reduced motion is on.
 *
 * Pure decision over the navigation state, so it is the same for native and web players.
 */
export type HeroNavigationState = {
  index?: number;
  routes: readonly HeroNavigationRoute[];
};
export type HeroNavigationRoute = {
  key: string;
  name: string;
  state?: HeroNavigationState;
};

/** Root stack routes presented as transparent sheets: the screen beneath stays on display. */
const SHEETS: readonly string[] = ['cart', 'checkout', 'order-status', 'auth'];

export function isSheetRoute(name: string, platform: string): boolean {
  // iOS presents the product photo page as a card sheet; the menu still shows above it.
  return SHEETS.includes(name) || (platform === 'ios' && name === 'product-photo');
}

function contains(route: HeroNavigationRoute, key: string): boolean {
  return route.key === key || !!route.state?.routes.some((child) => contains(child, key));
}

/**
 * True when the screen with `hostKey` is on display: on the focused branch of every navigator,
 * with only sheets stacked above it.
 */
export function heroHostVisible(
  state: HeroNavigationState | undefined,
  hostKey: string,
  platform: string,
): boolean {
  if (!state || !state.routes.length) return false;
  const index = state.routes.findIndex((route) => contains(route, hostKey));
  if (index < 0) return false;
  const focused = Math.min(state.index ?? state.routes.length - 1, state.routes.length - 1);
  if (index > focused) return false;
  for (const above of state.routes.slice(index + 1, focused + 1))
    if (!isSheetRoute(above.name, platform)) return false;
  const route = state.routes[index]!;
  if (route.key === hostKey) return true;
  return heroHostVisible(route.state, hostKey, platform);
}

export function heroShouldPlay({
  reducedMotion,
  appActive,
  failed,
  hostVisible,
}: {
  reducedMotion: boolean;
  appActive: boolean;
  failed: boolean;
  hostVisible: boolean;
}): boolean {
  return !reducedMotion && appActive && !failed && hostVisible;
}
