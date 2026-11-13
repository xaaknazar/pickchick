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
  private persisted = 0;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly io: { read(): Promise<string | null>; write(value: string): Promise<void> };
  constructor(io: PickBoxRecords['io']) {
    this.io = io;
  }
  record(score = 0): Promise<{ best: number; saved: boolean }> {
    const operation = this.queue.then(async () => {
      if (Number.isSafeInteger(score) && score >= 0 && score < 10_000_000) {
        this.best = Math.max(this.best, score);
      }
      try {
        if (!this.loaded) {
          const parsed = parseRecord(await this.io.read());
          if (parsed === null) return { best: this.best, saved: false };
          this.best = Math.max(this.best, parsed);
          this.persisted = parsed;
          this.loaded = true;
        }
        if (this.best > this.persisted) {
          const pending = this.best;
          await this.io.write(String(pending));
          this.persisted = pending;
        }
        return { best: this.best, saved: true };
      } catch {
        return { best: this.best, saved: false };
      }
    });
    this.queue = operation;
    return operation;
  }
}
