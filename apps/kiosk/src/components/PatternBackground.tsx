import { View, StyleSheet } from 'react-native';
import { colors } from '../theme';
export function LightBackground() {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}
    />
  );
}
export function BluePattern() {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.blue }]}
    />
  );
}
