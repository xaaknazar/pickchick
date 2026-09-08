import { parseGame, type GameState } from './engine.ts';

export const PICK_BLOCKS_STORAGE_KEY = 'pickchick.pick-blocks.v1';
const MAX_SNAPSHOT_LENGTH = 32_768;

export type SavedPickBlocks = {
  version: 1;
  best: number;
  game: GameState | null;
};

export type PickBlocksStorageIO = {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
};

export function parseSavedPickBlocks(raw: string | null): SavedPickBlocks | null {
  if (raw === null || raw.length > MAX_SNAPSHOT_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'best,game,version' ||
      record.version !== 1 ||
      !Number.isSafeInteger(record.best) ||
      (record.best as number) < 0
    )
      return null;
    const game = record.game === null ? null : parseGame(record.game);
    if (record.game !== null && game === null) return null;
    return { version: 1, best: Math.max(record.best as number, game?.score ?? 0), game };
  } catch {
    return null;
  }
}

/** A single instance owns this storage key, including across screen remounts. */
export class PickBlocksStorage {
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;
  private best = 0;
  private readonly io: PickBlocksStorageIO;

  constructor(io: PickBlocksStorageIO) {
    this.io = io;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }

  private async readSnapshot() {
    try {
      const raw = await this.io.read();
      const snapshot = parseSavedPickBlocks(raw);
      this.loaded = true;
      this.best = Math.max(this.best, snapshot?.best ?? 0);
      return { snapshot, error: raw !== null && snapshot === null };
    } catch {
      // A failed read must not be treated as an empty file and overwritten.
      this.loaded = false;
      return { snapshot: null, error: true };
    }
  }

  load(): Promise<{ snapshot: SavedPickBlocks | null; error: boolean }> {
    return this.serial(() => this.readSnapshot());
  }

  save(game: GameState | null, best: number): Promise<{ ok: boolean; best: number }> {
    // Copy at enqueue time. The caller can continue playing while storage is busy.
    let requested: SavedPickBlocks | null = null;
    try {
      requested = parseSavedPickBlocks(JSON.stringify({ version: 1, game, best }));
    } catch {
      // Invalid or unexpectedly oversized state never replaces the last good save.
    }
    const snapshot = requested;
    return this.serial(async () => {
      if (snapshot === null) return { ok: false, best: this.best };
      if (!this.loaded) {
        await this.readSnapshot();
        if (!this.loaded) return { ok: false, best: this.best };
      }
      this.best = Math.max(this.best, snapshot.best);
      try {
        await this.io.write(JSON.stringify({ ...snapshot, best: this.best }));
        return { ok: true, best: this.best };
      } catch {
        return { ok: false, best: this.best };
      }
    });
  }
}
