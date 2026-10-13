import { useEffect, useRef, useState } from 'react';
/**
 * A Kaspi QR lives 180 s from its first create (docs/operations/kiosk-kaspi-qr.md); a longer
 * lifetime seen on screen widens the circle instead of overflowing it.
 */
export const QR_LIFETIME_S = 180;
/** «02:58». */
export const clock = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
/**
 * Seconds left until `expiresAt` on the local clock, ticking once a second, and the lifetime the
 * circle counts down from; `left` is null without a valid expiry.
 */
export function useQrCountdown(expiresAt: string | null | undefined) {
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  const [now, setNow] = useState(() => Date.now());
  const longest = useRef({ expiry: NaN, seconds: 0 });
  useEffect(() => {
    if (!Number.isFinite(expiry)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiry]);
  if (!Number.isFinite(expiry)) return { left: null, total: QR_LIFETIME_S };
  const left = Math.max(0, Math.ceil((expiry - now) / 1000));
  if (longest.current.expiry !== expiry) longest.current = { expiry, seconds: 0 };
  longest.current.seconds = Math.max(longest.current.seconds, left);
  return { left, total: Math.max(QR_LIFETIME_S, longest.current.seconds) };
}
