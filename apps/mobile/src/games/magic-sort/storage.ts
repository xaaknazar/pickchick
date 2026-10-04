import { parseGame, type GameState } from './engine.ts';
const MAX_SAVE_BYTES = 100_000;
export type GameStorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};
export function serializeGame(state: GameState): string {
  const raw = JSON.stringify(state);
  if (raw.length > MAX_SAVE_BYTES || !parseGame(state)) throw new Error('Invalid Magic Sort save');
  return raw;
}
export function deserializeGame(raw: string | null): GameState | null {
  if (raw === null || raw.length > MAX_SAVE_BYTES) return null;
  try {
    return parseGame(JSON.parse(raw));
  } catch {
    return null;
  }
}
export function createGameStorage(adapter: GameStorageAdapter) {
  let queue: Promise<void> = Promise.resolve();
  function key(accountId: string): string {
    if (!accountId || accountId.length > 200) throw new Error('Account scope required');
    return 'pickchick.magic-sort.v1:' + encodeURIComponent(accountId);
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  return {
    load(accountId: string): Promise<GameState | null> {
      const scoped = key(accountId);
      return serial(async () => deserializeGame(await adapter.getItem(scoped)));
    },
    save(accountId: string, state: GameState): Promise<void> {
      const scoped = key(accountId),
        raw = serializeGame(state);
      return serial(() => adapter.setItem(scoped, raw));
    },
    clear(accountId: string): Promise<void> {
      const scoped = key(accountId);
      return serial(() => adapter.removeItem(scoped));
    },
  };
}
