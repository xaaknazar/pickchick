const WALLETS_PROFILE = 'application/json; profile=pickchick.checkout-wallets-v1';
const COMMENTS_PROFILE = 'application/json; profile=pickchick.checkout-comments-v1';

/** Older installed clients use strict schemas. Extra fields are explicitly opted in. */
export function checkoutRepresentation<T>(value: T, accept?: string): T {
  if (accept?.split(',').some((part) => part.trim() === WALLETS_PROFILE)) return value;
  if (!value || typeof value !== 'object') return value;
  const response = value as Record<string, unknown>;
  const { paymentMethods, paymentMethod, paymentEnvironment, ...walletLegacy } = response;
  void paymentEnvironment;
  void paymentMethods;
  void paymentMethod;
  if (Array.isArray(walletLegacy.orders))
    walletLegacy.orders = walletLegacy.orders.map((order) => checkoutRepresentation(order, accept));
  if (accept?.split(',').some((part) => part.trim() === COMMENTS_PROFILE)) return walletLegacy as T;
  const { kitchenComment, orderCommentEnabled, ...legacy } = walletLegacy;
  void kitchenComment;
  void orderCommentEnabled;
  if (Array.isArray(legacy.orders))
    legacy.orders = legacy.orders.map((order) => checkoutRepresentation(order));
  return legacy as T;
}
