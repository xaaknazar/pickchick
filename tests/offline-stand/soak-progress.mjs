import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** Publish complete snapshots only; a killed writer leaves the previous JSON readable. */
export async function atomicSnapshot(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(contents);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Wall-clock passage alone cannot pass a soak after a long suspended interval. */
export function continuousSoak(samples, durationMs, intervalMs) {
  let previous = 0;
  const gaps = [];
  for (const sample of samples) {
    const elapsed = sample.elapsed_ms;
    const gap = elapsed - previous;
    if (!Number.isFinite(elapsed) || gap <= 0 || gap > intervalMs + 90000)
      gaps.push({ previous_ms: previous, elapsed_ms: elapsed });
    previous = elapsed;
  }
  return {
    ok: samples.length > 0 && gaps.length === 0 && previous >= durationMs,
    elapsed_ms: previous,
    gaps,
  };
}
