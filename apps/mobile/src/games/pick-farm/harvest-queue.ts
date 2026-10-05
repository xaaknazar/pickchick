import type { FarmCommand } from '@pickchick/farm-game';
type Harvest = Extract<FarmCommand, { type: 'harvest' }>;
type Item = { command: Harvest; resolve: (saved: boolean) => void; promise: Promise<boolean> };

/** Serialize deliberate harvest taps; only the active command enters durable storage. */
export class HarvestQueue {
  private items: Item[] = [];
  private running = false;
  private disposed = false;
  private execute: (command: Harvest) => Promise<boolean>;
  constructor(execute: (command: Harvest) => Promise<boolean>) {
    this.execute = execute;
  }

  enqueue(command: Harvest): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const existing = this.items.find((item) => item.command.plotId === command.plotId);
    if (existing) return existing.promise;
    let resolve!: Item['resolve'];
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    this.items.push({ command: { ...command }, resolve, promise });
    void this.drain();
    return promise;
  }

  private async drain() {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed && this.items.length) {
        const item = this.items[0]!;
        let saved = false;
        try {
          saved = await this.execute(item.command);
        } catch {
          /* Stop on unknown outcomes. */
        }
        this.items.shift();
        item.resolve(saved);
        if (!saved) {
          this.cancelPending();
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private cancelPending() {
    for (const item of this.items.splice(0)) item.resolve(false);
  }
  dispose() {
    this.disposed = true;
    this.cancelPending();
  }
}
