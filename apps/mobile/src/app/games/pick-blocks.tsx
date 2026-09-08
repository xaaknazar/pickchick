import { Stack } from 'expo-router';
import { AccountGate } from '../../components/AccountGate';
import { PickBlocksScreen } from '../../games/pick-blocks/PickBlocksScreen';

export default function PickBlocksRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <AccountGate destination="pick-blocks">
        <PickBlocksScreen />
      </AccountGate>
    </>
  );
}
