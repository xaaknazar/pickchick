import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { productImage } from '../assets';
import { colors, useMetrics } from '../theme';
import { Icon } from './UI';
/** Two catalog drinks have no supplied photograph; a neutral icon does not substitute another SKU. */
export function ProductArtwork({
  imageId,
  crop = false,
  style,
}: {
  imageId: string;
  crop?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { px } = useMetrics();
  return (
    <View
      style={[{ overflow: 'hidden', backgroundColor: colors.light }, style]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {imageId === 'generic-drink' ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            { justifyContent: 'center', alignItems: 'center', backgroundColor: '#E6EDF8' },
          ]}
        >
          <Icon name="water-outline" size={px(80)} color={colors.blue} />
        </View>
      ) : (
        <Image
          source={productImage(imageId)}
          contentFit="cover"
          style={
            crop
              ? { width: '128%', height: '128%', marginLeft: '-14%', marginTop: '-14%' }
              : StyleSheet.absoluteFill
          }
        />
      )}
    </View>
  );
}
