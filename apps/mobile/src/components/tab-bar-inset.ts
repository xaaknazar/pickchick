import { createContext, useContext } from 'react';

/** Height the floating tab bar covers from the screen bottom; 0 outside the tab layout. */
export const TabBarInsetContext = createContext(0);
export function useTabBarInset() {
  return useContext(TabBarInsetContext);
}
