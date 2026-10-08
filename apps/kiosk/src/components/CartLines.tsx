import { useEffect, useState } from 'react';
import type { KioskCartLine } from '../model';
import type { Locale } from '../i18n';
import { CartRow } from './CartRow';
import { useMotionPreference } from './useMotionPreference';
interface Ghost {
  line: KioskCartLine;
  index: number;
  at: number;
}
/** A copy never outlives its exit by much, even if the exit never reports back. */
const longest = 900;
const idsOf = (lines: KioskCartLine[]) => lines.map((line) => line.lineId).join('|');
/**
 * The cart's lines. A line the cart just dropped stays in its place as an
 * untouchable copy (no ids, hidden from assistive tech) while it slides out
 * (prototype `.line.gone`, 280 ms), then the list closes up. The cart itself is
 * never held back; under reduced motion removed lines simply vanish.
 */
export function CartLines({
  lines,
  locale,
  busy,
  onQuantity,
}: {
  lines: KioskCartLine[];
  locale: Locale;
  busy: boolean;
  onQuantity: (lineId: string, quantity: number) => void;
}) {
  const reduced = useMotionPreference();
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [previous, setPrevious] = useState(() => ({ ids: idsOf(lines), lines }));
  const ids = idsOf(lines);
  if (previous.ids !== ids) {
    const kept = new Set(lines.map((line) => line.lineId));
    const dropped = reduced
      ? []
      : previous.lines
          .map((line, index) => ({ line, index, at: Date.now() }))
          .filter(({ line }) => !kept.has(line.lineId));
    setPrevious({ ids, lines });
    setGhosts((now) => [
      ...now.filter(
        (ghost) =>
          !kept.has(ghost.line.lineId) &&
          !dropped.some((next) => next.line.lineId === ghost.line.lineId),
      ),
      ...dropped,
    ]);
  }
  useEffect(() => {
    if (reduced) setGhosts([]);
  }, [reduced]);
  useEffect(() => {
    if (!ghosts.length) return;
    const timer = setTimeout(
      () => setGhosts((now) => now.filter((ghost) => Date.now() - ghost.at < longest)),
      longest,
    );
    return () => clearTimeout(timer);
  }, [ghosts]);
  const rows = lines.map((line, position) => ({ line, position, leaving: false }));
  for (const ghost of [...ghosts].sort((a, b) => a.index - b.index))
    rows.splice(Math.min(ghost.index, rows.length), 0, {
      line: ghost.line,
      position: ghost.index,
      leaving: true,
    });
  return (
    <>
      {rows.map(({ line, position, leaving }) => (
        <CartRow
          key={line.lineId}
          line={line}
          position={position}
          locale={locale}
          busy={busy}
          leaving={leaving}
          onLeft={() =>
            setGhosts((now) => now.filter((ghost) => ghost.line.lineId !== line.lineId))
          }
          onQuantity={(quantity) => onQuantity(line.lineId, quantity)}
        />
      ))}
    </>
  );
}
