/**
 * Games offered on the order tracker while the kitchen works. Presentation only:
 * availability mirrors the «События» tab and each game route keeps its own gate.
 */
export type OrderGameId = 'pick-blocks' | 'pick-man' | 'magic-sort' | 'pick-farm';
export type PublishedGameTemplate = 'pick-blocks' | 'pick-man';

/** Owner-approved carousel order. Pick Farm joins only while its build flag is on. */
export function orderGameIds(
  gameEnabled: (template: PublishedGameTemplate) => boolean,
  farmEnabled: boolean,
): OrderGameId[] {
  const ids: OrderGameId[] = [];
  if (gameEnabled('pick-blocks')) ids.push('pick-blocks');
  if (gameEnabled('pick-man')) ids.push('pick-man');
  ids.push('magic-sort');
  if (farmEnabled) ids.push('pick-farm');
  return ids;
}

export type OrderGameHref = { pathname: `/games/${OrderGameId}`; params: { from: 'order' } };

/**
 * The single way the tracker opens a game. `onBeforeGame` lets a host that presents the
 * tracker inside a React Native <Modal> close it first; `from: 'order'` tells the game
 * where the player returns to.
 */
export function openOrderGame(
  router: { push(href: OrderGameHref): void },
  id: OrderGameId,
  onBeforeGame?: () => void,
) {
  onBeforeGame?.();
  router.push({ pathname: `/games/${id}`, params: { from: 'order' } });
}

/** Card index under the left edge, clamped; the scroll end always marks the last card. */
export function carouselIndex(
  offset: number,
  interval: number,
  count: number,
  maxOffset: number,
): number {
  if (count <= 1 || interval <= 0) return 0;
  if (maxOffset > 0 && offset >= maxOffset - 2) return count - 1;
  return Math.min(count - 1, Math.max(0, Math.round(offset / interval)));
}
