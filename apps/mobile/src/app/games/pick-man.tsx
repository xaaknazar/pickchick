import { GameAvailability } from '../../backoffice/GameAvailability';
import { Stack } from 'expo-router';
import { AccountGate } from '../../components/AccountGate';
import { PickManScreen } from '../../games/pick-man/PickManScreen';
export default function PickManRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <AccountGate destination="pick-man">
        <GameAvailability template="pick-man">
          <PickManScreen />
        </GameAvailability>
      </AccountGate>
    </>
  );
}
