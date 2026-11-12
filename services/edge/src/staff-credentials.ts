import { edgeDeviceAccessEnabled } from '@pickchick/local-orders';
import type { StaffAuth } from '@pickchick/local-orders';

type RequestHeaders = Record<string, string | undefined>;

/**
 * Staff credentials of a cashier-desk request: the session id and the bearer secret, as the POS
 * and legacy terminals send them.
 *
 * A session held on a paired (device-access managed) screen is refused with these, with the
 * screen's key as without it: authenticateStaff answers 401 to a managed terminal that shows no
 * key. That is on purpose. A kitchen screen never works with the cash desk, whoever signed in on
 * it. The POS sales, cloud-link and approval routes build the same pair themselves for the same
 * reason.
 */
export function deskCredentials(headers: RequestHeaders): StaffAuth {
  return {
    sessionId: headers['x-staff-session-id'] ?? '',
    token: headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '',
  };
}

/**
 * Credentials of the session read (GET edge/v1/session): the desk pair and, with device access
 * on, the key of the paired screen when the client presents one (X-Terminal-ID +
 * X-Terminal-Key, added by the kitchen gateway, never by a browser).
 *
 * Outside login, logout, the terminal routes and the fulfillment routes this is the only route a
 * paired kitchen screen calls: the page reads it right after a successful password login. The
 * route used to drop the key, so every paired screen got 401 there, the page showed "session
 * expired" and nobody could sign in on a paired screen (found on site 12.11).
 *
 * Nothing changes for a client that sends no key (the POS and legacy terminals) or with device
 * access off. With device access on a presented key is verified: a wrong one or one of another
 * terminal is refused, and a display screen never becomes staff.
 */
export function screenCredentials(headers: RequestHeaders): StaffAuth {
  const key = headers['x-terminal-key'];
  return {
    ...deskCredentials(headers),
    ...(key && edgeDeviceAccessEnabled()
      ? { terminal: { id: headers['x-terminal-id'] ?? '', key } }
      : {}),
  };
}
