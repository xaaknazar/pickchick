import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
/** Fixed contrast treatment for the supplied welcome film and its poster. */
export function HeroShade() {
  return (
    <LinearGradient
      colors={[
        'rgba(2,20,64,.72)',
        'rgba(2,20,64,.06)',
        'rgba(2,18,58,.32)',
        'rgba(2,14,48,.92)',
        'rgba(2,12,42,.99)',
      ]}
      locations={[0, 0.26, 0.54, 0.8, 1]}
      style={StyleSheet.absoluteFill}
    />
  );
}
