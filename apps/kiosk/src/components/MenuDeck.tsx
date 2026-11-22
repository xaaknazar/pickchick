import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import { curve } from './motion';
import { useMotionPreference } from './useMotionPreference';
import { categoryKeys, type Category } from './categories';

/**
 * Owner 22.11.2026: switching «Комбо», «На двоих», «На компанию», «Допы» must open the section
 * smoothly, never with a stall. On the iPad every section stays mounted once built (and the
 * others are built in the background after the menu settles), so a switch is only a native
 * cross-fade: no cards, photos or layout are made on the tap. The web build used by the review
 * harness keeps one section at a time (its tests read a single grid).
 */
const KEEP_SECTIONS = Platform.OS !== 'web';
/** First background build after the menu opens, then one section per step. */
const WARM_START = 900;
const WARM_STEP = 260;
const SHOW = 240;
const HIDE = 140;

/** Sections the deck has built: the open one, the ones visited, then the rest in rail order. */
function useBuiltSections(category: Category) {
  const [built, setBuilt] = useState<Category[]>([category]);
  const add = (key: Category) => setBuilt((list) => (list.includes(key) ? list : [...list, key]));
  if (!built.includes(category)) add(category);
  useEffect(() => {
    if (!KEEP_SECTIONS) return;
    const timers = categoryKeys.map((key, i) =>
      setTimeout(() => add(key), WARM_START + i * WARM_STEP),
    );
    return () => timers.forEach(clearTimeout);
  }, []);
  return KEEP_SECTIONS ? built : [category];
}

/** One section of the deck: shown in place, or kept built and invisible underneath. */
function MenuLayer({ active, children }: { active: boolean; children: ReactNode }) {
  const reduced = useMotionPreference();
  // A section built while the guest looks at another one starts hidden; the first section
  // (and every web section) is already in place and plays the cards' own rise.
  const shown = useRef(new Animated.Value(active ? 1 : 0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduced) {
      shown.setValue(active ? 1 : 0);
      return;
    }
    const animation = Animated.timing(shown, {
      toValue: active ? 1 : 0,
      duration: active ? SHOW : HIDE,
      easing: curve(active ? 'ease' : 'out'),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [active, reduced, shown]);
  return (
    <Animated.View
      pointerEvents={active ? 'box-none' : 'none'}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
      style={[
        StyleSheet.absoluteFill,
        {
          opacity: shown,
          transform: [
            { translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
            { scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.992, 1] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * The grid area right of the rail: every built section stacked in one box, the open one on
 * top. `children` draws one section; `revision` rebuilds the web section on every tap.
 */
export function MenuDeck({
  category,
  revision,
  children,
}: {
  category: Category;
  revision: number;
  children: (section: Category, active: boolean) => ReactNode;
}) {
  const built = useBuiltSections(category);
  return (
    // No zIndex on the layers: with the new architecture's stacking a raised layer escaped the
    // deck and its scroll view covered «Оформить заказ» (owner 22.11.2026: the button did not
    // answer). Hidden layers pass touches through (pointerEvents none), so order is irrelevant.
    <View collapsable={false} style={{ flex: 1, minHeight: 0 }}>
      {built.map((key) => (
        <MenuLayer key={key + '-' + (KEEP_SECTIONS ? 0 : revision)} active={key === category}>
          {children(key, key === category)}
        </MenuLayer>
      ))}
    </View>
  );
}
