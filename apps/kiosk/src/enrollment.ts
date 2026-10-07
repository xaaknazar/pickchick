/** Operator credentials are only used for enrollment, never for guest requests. */
export const KIOSK_ENROLLMENT_REQUEST_KEY = 'pickchick.kiosk.enrollment-request.v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const legacyDeviceCredentials = (id: string, key: string) =>
  uuid.test(id) && /^[a-f0-9]{64}$/.test(key);
export const operatorCredentialsValid = (login: string, password: string) =>
  /^[A-Za-z0-9_.-]{3,64}$/.test(login) &&
  password.length >= 12 &&
  password.length <= 128 &&
  Array.from(password).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
export const enrollmentCredentialsValid = (id: string, key: string) =>
  legacyDeviceCredentials(id, key) || operatorCredentialsValid(id, key);

type Device = { deviceId: string; key: string };
type EnrollmentIO = {
  occupied(): Promise<boolean>;
  readRequest(): Promise<string | null>;
  writeRequest(value: string): Promise<void>;
  removeRequest(): Promise<void>;
  uuid(): string;
  exchange(input: { login: string; password: string; requestId: string }): Promise<unknown>;
  check(device: Device): Promise<unknown>;
  save(device: Device): Promise<void>;
};

export async function enrollDevice(login: string, password: string, io: EnrollmentIO) {
  if (!enrollmentCredentialsValid(login, password)) throw new Error('Invalid enrollment input');
  if (await io.occupied())
    throw new Error('Existing enrollment must be reviewed before replacement');
  let device: Device;
  if (legacyDeviceCredentials(login, password)) {
    device = { deviceId: login, key: password };
  } else {
    let requestId = '';
    const pending = await io.readRequest();
    if (pending) {
      try {
        const value: unknown = JSON.parse(pending);
        if (
          value &&
          typeof value === 'object' &&
          'login' in value &&
          value.login === login &&
          'requestId' in value &&
          typeof value.requestId === 'string' &&
          uuid.test(value.requestId)
        )
          requestId = value.requestId;
      } catch {
        /* A malformed local retry marker is replaced before any request. */
      }
    }
    if (!requestId) {
      requestId = io.uuid();
      if (!uuid.test(requestId)) throw new Error('Invalid enrollment request');
      // Persist before exchange so a lost response does not consume a second activation.
      await io.writeRequest(JSON.stringify({ login, requestId }));
    }
    const response = await io.exchange({ login, password, requestId });
    if (
      !response ||
      typeof response !== 'object' ||
      !('deviceId' in response) ||
      !('key' in response) ||
      typeof response.deviceId !== 'string' ||
      typeof response.key !== 'string' ||
      !legacyDeviceCredentials(response.deviceId, response.key)
    )
      throw new Error('Invalid enrollment response');
    device = { deviceId: response.deviceId, key: response.key };
  }
  const checked = await io.check(device);
  if (!checked || typeof checked !== 'object' || !('valid' in checked) || checked.valid !== true)
    throw new Error('Device enrollment was not verified');
  await io.save(device);
  // Saving the device is the durable completion point; retry-marker cleanup is optional.
  await io.removeRequest().catch(() => {});
}
