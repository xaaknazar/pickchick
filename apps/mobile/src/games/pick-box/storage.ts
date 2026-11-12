export const RECORD_KEY = 'pickchick.pick-box.best.v1';
export const parseRecord = (raw: string | null): number | null => {
  if (raw === null) return 0;
  if (!/^\d{1,7}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

/** Serialize load/save so a late read or older write cannot erase a newer best. */
export class PickBoxRecords {
  private best = 0;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly io: { read(): Promise<string | null>; write(value: string): Promise<void> };
  constructor(io: PickBoxRecords['io']) {
    this.io = io;
  }
  record(score = 0): Promise<{ best: number; saved: boolean }> {
    const operation = this.queue.then(async () => {
      try {
        if (!this.loaded) {
          const parsed = parseRecord(await this.io.read());
          if (parsed === null) return { best: Math.max(this.best, score), saved: false };
          this.best = Math.max(this.best, parsed);
          this.loaded = true;
        }
        if (Number.isSafeInteger(score) && score > this.best && score < 10_000_000) {
          await this.io.write(String(score));
          this.best = score;
        }
        return { best: this.best, saved: true };
      } catch {
        return { best: Math.max(this.best, score), saved: false };
      }
    });
    this.queue = operation;
    return operation;
  }
}
