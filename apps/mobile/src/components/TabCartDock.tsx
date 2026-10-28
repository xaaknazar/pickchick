import { useIsFocused, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useMobile } from '../store';
import { CartShortcut } from './CartShortcut';

/**
 * The cart bar (quick pay) of Меню, События and Заказы, drawn by the tab bar itself, right on top
 * of the tab capsule (owner 28.10.2026, TestFlight 25: «быстрая оплата иногда застревает за
 * иконками»). Each tab screen used to draw it at a computed distance from the bottom, in the
 * screen's layer, which lies under the tab bar: a taller tab bar (large text) or a screen frame
 * shifted for a moment put the tab bar over it, and its taps went to the tabs. Here the two share
 * one layer above every tab screen and are stacked, so the bar is always fully visible and
 * tappable, a fixed gap above the tabs. Its measured height tells the screens how much to keep
 * free under their content.
 *
 * While a route above the tabs is open (the cart, sign-in, an order status) the bar is not drawn,
 * as before: the sheet covers it, and its last height is kept so the content below stays put.
 */
export function TabCartDock({
  preview = false,
  onHeightChange,
}: {
  preview?: boolean;
  onHeightChange?: (height: number) => void;
}) {
  const model = useMobile(preview);
  const router = useRouter();
  const focused = useIsFocused();
  return (
    <View
      testID="tab-cart-dock"
      pointerEvents="box-none"
      onLayout={(event) => {
        if (focused) onHeightChange?.(Math.ceil(event.nativeEvent.layout.height));
      }}
    >
      {focused ? (
        <CartShortcut
          model={model}
          aboveTabBar
          // The cart (M09) never requires an account: a guest browses it and signs in to pay.
          onPress={() =>
            router.push({ pathname: '/cart', params: preview ? { preview: '1' } : {} })
          }
        />
      ) : null}
    </View>
  );
}
