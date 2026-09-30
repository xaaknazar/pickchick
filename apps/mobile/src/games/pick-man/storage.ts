import { parseMaze, type MazeGame } from './engine.ts';
export const PICK_MAN_KEY = 'pickchick.pick-man.v1';
export type Snapshot = { version: 1; best: number; game: MazeGame | null };
export function parseSnapshot(raw: string | null): Snapshot | null {
  if (!raw || raw.length > 18000) return null;
  try {
    const data = JSON.parse(raw);
    if (
      data?.version !== 1 ||
      !Number.isInteger(data.best) ||
      data.best < 0 ||
      data.best > 100000000
    )
      return null;
    const game = data.game === null ? null : parseMaze(data.game);
    if (data.game !== null && !game) return null;
    return { version: 1, best: Math.max(data.best, game?.score ?? 0), game };
  } catch {
    return null;
  }
}
export class MazeStorage {
  private queue: Promise<unknown> = Promise.resolve();
  private best = 0;
  private io: { read(): Promise<string | null>; write(raw: string): Promise<void> };
  constructor(io: { read(): Promise<string | null>; write(raw: string): Promise<void> }) {
    this.io = io;
  }
  async load(): Promise<{ snapshot: Snapshot | null; error: boolean }> {
    await this.queue;
    try {
      const raw = await this.io.read(),
        snapshot = parseSnapshot(raw);
      this.best = Math.max(this.best, snapshot?.best ?? 0);
      return { snapshot, error: raw !== null && snapshot === null };
    } catch {
      return { snapshot: null, error: true };
    }
  }
  save(game: MazeGame, best: number): Promise<boolean> {
    if (!parseMaze(game)) return Promise.resolve(false);
    this.best = Math.max(this.best, best, game.score);
    const raw = JSON.stringify({ version: 1, game, best: this.best });
    const write = this.queue
      .then(() => this.io.write(raw))
      .then(
        () => true,
        () => false,
      );
    this.queue = write;
    return write;
  }
}
