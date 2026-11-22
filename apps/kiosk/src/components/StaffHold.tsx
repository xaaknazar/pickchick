import type { ReactNode } from 'react';
import { Pressable } from 'react-native';
import { STAFF_HOLD_MS } from './WelcomeContent';
/**
 * Staff only (owner 22.11.2026: no «Сотруднику» button in front of guests): a long hold on the
 * wrapped mark opens the staff dialog (staff code, then the service reset), like the logo of the
 * start screen. Nothing shows it to a guest, and a short tap does nothing.
 */
export function StaffHold({
  onHold,
  testID = 'kiosk-staff-hold',
  children,
}: {
  /** Opens the staff dialog; without it the mark is plain. */
  onHold?: () => void;
  testID?: string;
  children: ReactNode;
}) {
  if (!onHold) return <>{children}</>;
  return (
    <Pressable
      testID={testID}
      accessible={false}
      delayLongPress={STAFF_HOLD_MS}
      onLongPress={onHold}
    >
      {children}
    </Pressable>
  );
}
