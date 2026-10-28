import { createContext, useContext } from 'react';

/** Height the floating tab bar covers from the screen bottom; 0 outside the tab layout. */
export const TabBarInsetContext = createContext(0);
export function useTabBarInset() {
  return useContext(TabBarInsetContext);
}

/**
 * Measured height of the cart bar docked on top of the tab bar (TabCartDock, owner 28.10.2026);
 * null outside the tab layout and before its first layout.
 */
export const TabCartDockContext = createContext<number | null>(null);
export function useTabCartDockHeight() {
  return useContext(TabCartDockContext);
}
