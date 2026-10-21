import {
  applyRecord,
  parseGame,
  MAX_MOVES,
  PUZZLE_SEED,
  PUZZLE_VERSION,
  type GameState,
  type RecordResult,
} from './engine.ts';
const MAX_SAVE_BYTES = 100_000;
const MAX_RECORD_BYTES = 200;
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
/** Records are tied to the fixed puzzle; any other shape or puzzle is ignored. */
export function serializeRecord(moves: number): string {
  if (!Number.isInteger(moves) || moves < 1 || moves > MAX_MOVES)
    throw new Error('Invalid Magic Sort record');
  return JSON.stringify({ version: PUZZLE_VERSION, seed: PUZZLE_SEED, moves });
}
export function deserializeRecord(raw: string | null): number | null {
  if (raw === null || raw.length > MAX_RECORD_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'moves,seed,version' ||
      record.version !== PUZZLE_VERSION ||
      record.seed !== PUZZLE_SEED ||
      !Number.isInteger(record.moves) ||
      (record.moves as number) < 1 ||
      (record.moves as number) > MAX_MOVES
    )
      return null;
    return record.moves as number;
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
  function recordKey(accountId: string): string {
    if (!accountId || accountId.length > 200) throw new Error('Account scope required');
    return 'pickchick.magic-sort.record.v1:' + encodeURIComponent(accountId);
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
    loadRecord(accountId: string): Promise<number | null> {
      const scoped = recordKey(accountId);
      return serial(async () => deserializeRecord(await adapter.getItem(scoped)));
    },
    /** Read-compare-write inside the queue: repeated or stale wins never raise the record. */
    saveRecord(accountId: string, moves: number): Promise<RecordResult> {
      const scoped = recordKey(accountId);
      serializeRecord(moves);
      return serial(async () => {
        const result = applyRecord(deserializeRecord(await adapter.getItem(scoped)), moves);
        if (result.isNew) await adapter.setItem(scoped, serializeRecord(result.best));
        return result;
      });
    },
  };
}
