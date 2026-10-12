import type { ImageSourcePropType } from 'react-native';
import { useRouter } from 'expo-router';
import { GamePosterCard } from '../GamePosterCard';

/** «События» card copy and cover; the order tracker carousel reuses them. */
export const magicSortPoster = {
  name: 'Magic Sort',
  subtitle: 'ГОЛОВОЛОМКА',
  description: 'Раздели цвета. Собери всё золото в центре.',
  cover: require('../../../assets/games/magic-sort/cover-alex.png') as ImageSourcePropType,
};
export function MagicSortCard() {
  const router = useRouter();
  return (
    <GamePosterCard
      {...magicSortPoster}
      onPress={() => router.push('/games/magic-sort')}
      testID="magic-sort-open"
    />
  );
}
