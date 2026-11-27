import { themed, tc } from '../theme';
import { createContext, useContext, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

/**
 * How far a bottom sheet is open (0 closed … 1 open), shared with the screen underneath. As in iOS
 * page sheets (Mail, Music), the screen behind steps back: it shrinks a little and rounds its
 * corners, so it is clear the menu is still there under the cart.
 */
const SheetStackContext = createContext<SharedValue<number> | null>(null);

export function SheetStackProvider({ children }: { children: ReactNode }) {
  const presence = useSharedValue(0);
  return <SheetStackContext.Provider value={presence}>{children}</SheetStackContext.Provider>;
}

export const useSheetStack = () => useContext(SheetStackContext);

export function SheetStackBackground({ children }: { children: ReactNode }) {
  const presence = useSheetStack();
  const style = useAnimatedStyle(() => {
    const p = presence ? presence.value : 0;
    return {
      borderRadius: interpolate(p, [0, 0.05, 1], [0, 12, 12]),
      transform: [
        { translateY: interpolate(p, [0, 1], [0, 10]) },
        { scale: interpolate(p, [0, 1], [1, 0.93]) },
      ],
      opacity: interpolate(p, [0, 1], [1, 0.85]),
    };
  });
  return (
    <View style={s.backdrop}>
      <Animated.View style={[s.fill, style]}>{children}</Animated.View>
    </View>
  );
}

const s = themed(() =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: tc('#000') },
    fill: { flex: 1, overflow: 'hidden' },
  }),
);
