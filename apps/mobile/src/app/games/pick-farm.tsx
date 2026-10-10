import { Redirect, Stack } from 'expo-router';
import { AccountGate } from '../../components/AccountGate';
import { PickFarmScreen } from '../../games/pick-farm/PickFarmScreen';
import { FARM_ENABLED } from '../../games/pick-farm/api';

function FarmGame() {
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: false,
          orientation: 'landscape',
          gestureEnabled: false,
          statusBarHidden: true,
          navigationBarHidden: true,
          autoHideHomeIndicator: true,
        }}
      />
      <PickFarmScreen />
    </>
  );
}
export default function PickFarmRoute() {
  // Owner decision 2026-10-10: Pick Farm is removed from the app; old links go to events.
  if (!FARM_ENABLED) return <Redirect href="/(tabs)/events" />;
  return (
    <AccountGate destination="pick-farm">
      <FarmGame />
    </AccountGate>
  );
}
