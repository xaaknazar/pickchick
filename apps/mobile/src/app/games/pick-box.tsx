import { Stack } from 'expo-router';
import { PickBoxScreen } from '../../games/pick-box/PickBoxScreen';

/** Like the other local arcades, Pick Box is playable without an account. */
export default function PickBoxRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false, orientation: 'portrait' }} />
      <PickBoxScreen />
    </>
  );
}
