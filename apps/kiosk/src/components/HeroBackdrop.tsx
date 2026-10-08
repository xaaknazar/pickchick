import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme';
/** v3 film shade: a light navy cap, a clear middle and a deep navy base under the CTA. */
export function HeroShade() {
  return (
    <LinearGradient
      colors={[
        'rgba(4,20,58,.6)',
        'rgba(4,20,58,0)',
        'rgba(4,20,58,0)',
        'rgba(4,20,58,.82)',
        colors.navy,
        colors.navy,
      ]}
      locations={[0, 0.2, 0.44, 0.68, 0.92, 1]}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );
}
