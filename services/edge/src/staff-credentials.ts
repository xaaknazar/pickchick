import { edgeDeviceAccessEnabled } from '@pickchick/local-orders';
import type { StaffAuth } from '@pickchick/local-orders';

/**
 * Staff credentials of a request outside the fulfillment routes: the session id, the bearer
 * secret and, with device access on, the key of the paired screen when the client presents one
 * (X-Terminal-ID + X-Terminal-Key, added by the kitchen gateway, never by a browser).
 *
 * A session on a paired (device-access managed) terminal is refused without that key
 * (authenticateStaff), so a route that drops it answers 401 to every paired kitchen screen. That
 * is what GET edge/v1/session did right after a successful password login: the kitchen page
 * showed "session expired" and nobody could sign in on a paired screen (found on site 12.11).
 *
 * Nothing changes for a client that sends no key (the POS and legacy terminals) or with device
 * access off. A presented key is always verified: a wrong one or one of another terminal is
 * refused, a display screen never becomes staff.
 */
export function staffCredentials(headers: Record<string, string | undefined>): StaffAuth {
  const key = headers['x-terminal-key'];
  return {
    sessionId: headers['x-staff-session-id'] ?? '',
    token: headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
    ...(key && edgeDeviceAccessEnabled()
      ? { terminal: { id: headers['x-terminal-id'] ?? '', key } }
      : {}),
  };
}
