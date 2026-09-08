import { Stack } from 'expo-router';
import { AccountGate } from '../../components/AccountGate';
import { PickManScreen } from '../../games/pick-man/PickManScreen';
export default function PickManRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <AccountGate destination="pick-man">
        <PickManScreen />
      </AccountGate>
    </>
  );
}
