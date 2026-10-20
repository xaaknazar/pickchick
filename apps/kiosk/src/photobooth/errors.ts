/**
 * Explicit refusals of the photo print service that mean nothing was printed, whatever the HTTP
 * status. NOT_CONFIGURED comes with 503 (tools/photo-printer/service.mjs); before 19.10 the kiosk
 * read every 5xx as a lost connection, so the guest saw «результат неизвестен» and a pending job
 * that could never be found (audit finding 3.8).
 */
const SAFE_AT_ANY_STATUS = ['NOT_CONFIGURED'];

/** Error code of a failed print service answer; anything ambiguous is CONNECTION. */
export function photoErrorCode(status: number, body: unknown): string {
  const code =
    !!body &&
    typeof body === 'object' &&
    'code' in body &&
    typeof body.code === 'string' &&
    /^[A-Z_]{1,40}$/.test(body.code)
      ? body.code
      : null;
  if (code && (status < 500 || SAFE_AT_ANY_STATUS.includes(code))) return code;
  return 'CONNECTION';
}
