import type { ImageContentPosition } from 'expo-image';
import type { ImageSourcePropType } from 'react-native';
import { usePublishedContent } from '../backoffice/usePublishedContent';
import { magicSortPoster } from './magic-sort/MagicSortCard';
import { pickBlocksPoster } from './pick-blocks/visuals';
import { FARM_ENABLED } from './pick-farm/api';
import { pickFarmPoster } from './pick-farm/visuals';
import { pickManPoster } from './pick-man/visuals';
import { orderGameIds, type OrderGameId } from './order-games';

export type OrderGame = {
  id: OrderGameId;
  title: string;
  description: string;
  cover: ImageSourcePropType;
  coverPosition?: ImageContentPosition;
  testID: string;
};

// The «События» copy as the catalogue holds it (two lines): the carousel translates it first and
// then puts it on one line (review 29.10.2026: the one-line text had no translation, EN showed
// «Заполняй ряды. Всё сложится.»).

// Covers and copy come from the «События» cards; the tracker uses title case as approved.
const cards: Record<OrderGameId, Omit<OrderGame, 'id'>> = {
  'pick-blocks': {
    title: 'Pick Blocks',
    description: pickBlocksPoster.description,
    cover: pickBlocksPoster.cover,
    testID: 'order-play-blocks',
  },
  'pick-man': {
    title: 'Pick Man',
    description: pickManPoster.description,
    cover: pickManPoster.cover,
    testID: 'order-play-pick-man',
  },
  'magic-sort': {
    title: magicSortPoster.name,
    description: magicSortPoster.description,
    cover: magicSortPoster.cover,
    testID: 'order-play-magic-sort',
  },
  'pick-farm': {
    title: 'Pick Farm',
    description: pickFarmPoster.description,
    cover: pickFarmPoster.cover,
    coverPosition: pickFarmPoster.coverPosition,
    testID: 'order-play-pick-farm',
  },
};

/** Games currently open to the customer, in carousel order. */
export function useOrderGames(branch: string | null | undefined): OrderGame[] {
  const published = usePublishedContent(branch);
  return orderGameIds(published.gameEnabled, FARM_ENABLED).map((id) => ({ id, ...cards[id] }));
}
