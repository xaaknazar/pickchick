import { useRouter } from 'expo-router';
import { GamePosterCard } from '../GamePosterCard';

export function MagicSortCard() {
  const router = useRouter();
  return (
    <GamePosterCard
      name="Magic Sort"
      subtitle="ГОЛОВОЛОМКА"
      description="Раздели цвета. Собери всё золото в центре."
      cover={require('../../../assets/games/magic-sort/cover-alex.png')}
      onPress={() => router.push('/games/magic-sort')}
      testID="magic-sort-open"
    />
  );
}
