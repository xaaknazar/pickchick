import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const sourceRoot = resolve(
  process.env.POS_DESKTOP_SOURCE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)),
);
export const desktopRoot = resolve(sourceRoot, 'apps/pos-desktop');
export const desktopFile = (name) => resolve(desktopRoot, name);

export async function eventually(read, predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(message);
}
