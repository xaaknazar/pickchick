import { Stack } from 'expo-router';
import { PickBlocksScreen } from '../../games/pick-blocks/PickBlocksScreen';

export default function PickBlocksRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <PickBlocksScreen />
    </>
  );
}
