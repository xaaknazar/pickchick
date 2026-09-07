import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
export function HeroShade({ product }: { product?: boolean }) {
  return (
    <LinearGradient
      colors={
        product
          ? [
              'rgba(5,10,22,.68)',
              'rgba(5,10,22,.12)',
              'rgba(5,10,22,.52)',
              'rgba(5,10,22,.92)',
              'rgba(5,10,22,.98)',
            ]
          : [
              'rgba(2,20,64,.72)',
              'rgba(2,20,64,.06)',
              'rgba(2,18,58,.32)',
              'rgba(2,14,48,.92)',
              'rgba(2,12,42,.99)',
            ]
      }
      locations={product ? [0, 0.24, 0.52, 0.78, 1] : [0, 0.26, 0.54, 0.8, 1]}
      style={StyleSheet.absoluteFill}
    />
  );
}
