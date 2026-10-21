/** Push data is a hint. Ownership and the current order state must be read from the API. */
export function notificationId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return v.type === 'order' &&
    typeof v.notificationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v.notificationId,
    )
    ? v.notificationId
    : null;
}

/** Native push registration may wait indefinitely without connectivity. Keep settings recoverable. */
export function boundedNativeRequest<T>(request: Promise<T>, milliseconds = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('native_push_timeout')), milliseconds);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
