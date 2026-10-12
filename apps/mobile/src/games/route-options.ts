/**
 * One native container for an arcade game, whichever screen opens it.
 *
 * Order status and Kaspi checkout are `transparentModal` routes. A route pushed after a modal
 * with no explicit presentation becomes a native-stack `modal`: on iOS that is a page sheet whose
 * own swipe-down pan cancels the board's touch, so soft drop and hard drop never fire. `card` does
 * not work either: react-native-screens puts a push after a modal underneath that modal.
 *
 * Declare these in the root layout. A route's own <Stack.Screen> applies options after mount,
 * which is too late to change how the screen is presented.
 */
export const ARCADE_SCREEN_OPTIONS = {
  presentation: 'fullScreenModal',
  gestureEnabled: false,
} as const;

/** Where the player returns to; only changes the exit wording, never the game. */
export type GameOrigin = 'events' | 'order';
export const gameOrigin = (from: string | string[] | undefined): GameOrigin =>
  from === 'order' ? 'order' : 'events';
export const exitLabel = (origin: GameOrigin) => (origin === 'order' ? 'К заказу' : 'К событиям');
