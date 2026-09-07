import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { assets } from '../assets';
import { useMetrics } from '../theme';
export function LightBackground() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Image
        source={assets.blue}
        contentFit="cover"
        style={[StyleSheet.absoluteFill, { opacity: 0.055 }]}
      />
      <LinearGradient
        colors={['rgba(0,71,187,.055)', 'rgba(255,103,31,.025)']}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
export function BluePattern({ footer = false }: { footer?: boolean }) {
  const { px } = useMetrics();
  const textureWidth = px(footer ? 620 : 680);
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: '#0B4FC4',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
      ]}
    >
      <Image
        source={assets.blue}
        contentFit="cover"
        style={{ width: textureWidth, height: (textureWidth * 848) / 1100 }}
      />
      <LinearGradient
        colors={
          footer
            ? ['rgba(0,40,110,.78)', 'rgba(0,26,80,.92)']
            : ['rgba(0,40,110,.72)', 'rgba(0,26,80,.9)']
        }
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
