const COMMENTS_PROFILE = 'application/json; profile=pickchick.checkout-comments-v1';
const WALLETS_PROFILE = 'application/json; profile=pickchick.checkout-wallets-v1';

const accepts = (accept: string | undefined, profile: string) =>
  !!accept?.split(',').some((part) => part.trim() === profile);

/** Older installed clients use strict schemas. Extra fields are explicitly opted in. */
export function checkoutRepresentation<T>(value: T, accept?: string): T {
  if (!value || typeof value !== 'object') return value;
  let response = value as Record<string, unknown>;
  // Card / Apple Pay / Google Pay (TipTopPay, 18.11.2026): only builds that know them see them.
  if (
    !accepts(accept, WALLETS_PROFILE) &&
    ('paymentMethods' in response ||
      'paymentEnvironment' in response ||
      'tipTopPayPublicId' in response)
  ) {
    const { paymentMethods, paymentEnvironment, tipTopPayPublicId, ...rest } = response;
    void paymentMethods;
    void paymentEnvironment;
    void tipTopPayPublicId;
    response = rest;
  }
  if (accepts(accept, COMMENTS_PROFILE)) return response as T;
  const { kitchenComment, orderCommentEnabled, ...legacy } = response;
  void kitchenComment;
  void orderCommentEnabled;
  if (Array.isArray(legacy.orders))
    legacy.orders = legacy.orders.map((order) => checkoutRepresentation(order));
  return legacy as T;
}
