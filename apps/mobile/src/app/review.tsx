import { Redirect } from 'expo-router';

/** Retired customer-facing gallery. Existing links return to the menu. */
export default function Review() {
  return <Redirect href="/(tabs)/menu" />;
}
