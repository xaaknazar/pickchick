import { Image } from 'expo-image';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type ViewStyle,
} from 'react-native';
import { font } from '../theme';
import { Icon } from '../components/UI';
import { useGameCardHeight } from './ArcadeCard';

const gradient =
  'linear-gradient(180deg, rgba(4,20,58,0.2) 0%, rgba(4,20,58,0) 35%, rgba(2,10,30,0.86) 72%, rgba(2,10,30,0.97) 100%)';
const scrim = (
  Platform.OS === 'web' ? { backgroundImage: gradient } : { experimental_backgroundImage: gradient }
) as ViewStyle;

export function GamePosterCard({
  name,
  subtitle,
  description,
  cover,
  onPress,
  testID,
}: {
  name: string;
  subtitle: string;
  description: string;
  cover: ImageSourcePropType;
  onPress(): void;
  testID: string;
}) {
  const height = useGameCardHeight();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Играть в ${name}. ${description}`}
      onPress={onPress}
      style={({ pressed }) => [s.card, { height }, pressed && { opacity: 0.88 }]}
    >
      <Image
        source={cover}
        contentFit="cover"
        contentPosition="center"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        accessible={false}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, scrim]} />
      <View style={s.tag}>
        <Text style={s.tagText}>{subtitle}</Text>
      </View>
      <View style={s.bottom}>
        <View style={s.copy}>
          <Text testID={`${testID}-title`} style={s.title}>
            {name}
          </Text>
          <Text style={s.description}>{description}</Text>
        </View>
        <View style={s.play}>
          <Icon name="play" size={25} color="#FFFFFF" />
        </View>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    marginTop: 12,
    padding: 16,
    borderRadius: 26,
    overflow: 'hidden',
    backgroundColor: '#04143A',
    justifyContent: 'space-between',
  },
  tag: {
    alignSelf: 'flex-start',
    borderRadius: 20,
    backgroundColor: '#04143AB8',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  tagText: {
    fontFamily: font.bold,
    fontSize: 9,
    lineHeight: 14,
    letterSpacing: 0.6,
    color: '#FFFFFF',
  },
  bottom: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  copy: { flex: 1 },
  title: {
    fontFamily: font.display,
    fontSize: 26,
    lineHeight: 40,
    letterSpacing: -0.7,
    color: '#FFFFFF',
  },
  description: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
    color: '#E6EEFF',
    marginTop: 2,
  },
  play: {
    width: 52,
    height: 52,
    flexShrink: 0,
    borderRadius: 26,
    backgroundColor: '#FF7A3D',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 3,
  },
});
