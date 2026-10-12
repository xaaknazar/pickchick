import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useMetrics } from '../theme';
/**
 * Layout of the smart upsell content inside its scroller (kiosk redesign 2026-10-13): 16 from
 * the screen edges, 18 between the hero and the rows. It is at least as tall as the scroller,
 * and the hero and rows share any spare height in proportion to their design heights (329 / 274),
 * so taller iPads fill the screen; on a short one (or with a notice above) the content scrolls.
 * Use inside `ScrollArea fill`.
 */
export function UpsellBoard({ children }: { children?: ReactNode }) {
  const { px } = useMetrics();
  return (
    <View
      testID="kiosk-upsell-board"
      style={{
        flexGrow: 1,
        paddingHorizontal: px(16),
        paddingTop: px(24),
        paddingBottom: px(26),
        gap: px(18),
      }}
    >
      {children}
    </View>
  );
}
