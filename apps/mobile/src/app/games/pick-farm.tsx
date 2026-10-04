import { Stack, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AccountGate } from '../../components/AccountGate';
import { PickFarmScreen } from '../../games/pick-farm/PickFarmScreen';
import { FARM_ENABLED } from '../../games/pick-farm/api';
import { colors, font } from '../../theme';

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
  const router = useRouter();
  if (!FARM_ENABLED)
    return (
      <View style={styles.unavailable}>
        <Text style={styles.text}>Ферма скоро откроется</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace('/(tabs)/events')}
          style={styles.button}
        >
          <Text style={styles.text}>К событиям</Text>
        </Pressable>
      </View>
    );
  return (
    <AccountGate destination="pick-farm">
      <FarmGame />
    </AccountGate>
  );
}
const styles = StyleSheet.create({
  unavailable: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    padding: 24,
  },
  text: { color: colors.text, fontFamily: font.body, fontSize: 18 },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 24,
    borderRadius: 24,
    backgroundColor: colors.surface,
  },
});
