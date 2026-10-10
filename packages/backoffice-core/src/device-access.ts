import { BackofficeError } from './model.js';

/** Cloud edge identities cannot be revoked until a replacement/fencing protocol exists.
 * Check this on the locked row, never on a client-supplied kind or capability. */
export function assertDeviceRevocation(
  device: { kind: string; name: string; status: string },
  confirmedName: string,
) {
  if (device.kind === 'edge')
    throw new BackofficeError('CONFLICT', 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL');
  if (device.kind === 'kiosk')
    throw new BackofficeError('CONFLICT', 'KIOSK_REVOKE_REQUIRES_SESSION_PROTOCOL');
  if (device.name !== confirmedName)
    throw new BackofficeError('CONFLICT', 'DEVICE_NAME_CONFIRMATION_REQUIRED');
}
