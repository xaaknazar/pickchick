import { Stack } from 'expo-router';
import { AccountGate } from '../../components/AccountGate';
import { GameAvailability } from '../../backoffice/GameAvailability';
import { MagicSortScreen } from '../../games/magic-sort/MagicSortScreen';

export default function MagicSortRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false, orientation: 'portrait' }} />
      <AccountGate destination="magic-sort">
        <GameAvailability template="magic-sort">
          <MagicSortScreen />
        </GameAvailability>
      </AccountGate>
    </>
  );
}
