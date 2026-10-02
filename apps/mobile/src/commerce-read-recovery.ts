import { createCatalogRecovery } from './catalog-recovery.ts';
import { watchRetryDelay } from './commerce-watch.ts';

/** Caller supplies a GET only. Order creation, quoting and payment stay outside. */
export function recoverCommerceRead<T>(options: {
  read(signal: AbortSignal): Promise<T>;
  signal: AbortSignal;
  active: boolean;
  subscribe(listener: (active: boolean) => void): () => void;
  onFailure(error: unknown): void;
  onRecovered(): void;
  accept?: (value: T) => boolean;
  onPending?: () => void;
  random?: () => number;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    let remove = () => {};
    const cleanup = () => {
      recovery.stop();
      remove();
      options.signal.removeEventListener('abort', abort);
    };
    const recovery = createCatalogRecovery({
      load: options.read,
      onLoading: () => {},
      isRetryable: (error) => watchRetryDelay(error, 1) !== null,
      random: options.random,
      successDelay: () => Math.round(10_000 * (0.8 + (options.random ?? Math.random)() * 0.2)),
      onSuccess: (value) => {
        if (options.accept && !options.accept(value)) {
          options.onPending?.();
          return;
        }
        cleanup();
        options.onRecovered();
        resolve(value);
      },
      onFailure: (error) => {
        options.onFailure(error);
        if (watchRetryDelay(error, 1) === null) {
          cleanup();
          reject(error);
        }
      },
    });
    const abort = () => {
      cleanup();
      reject(new Error('Read cancelled'));
    };
    remove = options.subscribe((active) => recovery.setActive(active));
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    else recovery.setActive(options.active);
  });
}

export const historyOrderNeedsWatch = (phase: string) =>
  !['failed', 'handed_over', 'attention'].includes(phase);

export function checkoutReadError(
  error: unknown,
  history: boolean,
  retrying = watchRetryDelay(error, 1) !== null,
): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'RESTAURANT_CLOSED')
    return 'Ресторан сейчас закрыт. Корзина сохранена - оформите заказ в часы работы.';
  if (code === 'UNAUTHORIZED') return 'Войдите в аккаунт снова, чтобы продолжить.';
  if (code === 'FORBIDDEN')
    return 'Оформление пока недоступно для вашего аккаунта. Корзина сохранена.';
  if (code === 'NOT_READY') return 'Ресторан пока не готов принимать заказы. Корзина сохранена.';
  const recovery = retrying ? 'Проверяем связь автоматически.' : 'Повторите проверку.';
  return history
    ? `Не удалось загрузить заказы. ${recovery}`
    : `Не удалось загрузить оформление. Корзина сохранена. ${recovery}`;
}
