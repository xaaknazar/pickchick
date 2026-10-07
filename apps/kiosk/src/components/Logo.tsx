import { View } from 'react-native';
import { Image } from 'expo-image';
import { assets } from '../assets';
import { colors, useMetrics } from '../theme';
export function Logo({ size = 'regular' }: { size?: 'regular' | 'hero' }) {
  const { px } = useMetrics();
  const dim = px(size === 'hero' ? 100 : 64);
  return (
    <View
      style={{
        width: dim,
        height: dim,
        overflow: 'hidden',
        borderRadius: 16,
        backgroundColor: colors.blue,
      }}
    >
      <Image
        source={assets.logo}
        contentFit="contain"
        style={{ width: '170%', height: '170%', marginLeft: '-35%', marginTop: '-35%' }}
        accessibilityLabel="Pick Chick"
      />
    </View>
  );
}
