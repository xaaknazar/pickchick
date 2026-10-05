import { fetch as nativeFetch } from 'expo/fetch';
import {
  CustomerCommerceOrderSchema,
  CustomerCheckoutConfigSchema,
  CustomerQuoteSchema,
  CustomerHostedPaymentSchema,
  CustomerTestPaymentSchema,
} from '@pickchick/contracts';
import { API_URL } from './api';
import { createCustomerRequest } from './customer-http';
import type { CartLine } from './model';

export const kaspiCheckoutEnabled = process.env.EXPO_PUBLIC_KASPI_CHECKOUT === '1';
export const commerceRequest = (
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  token: string,
  signal?: AbortSignal,
) =>
  createCustomerRequest(API_URL, nativeFetch, {
    allowed:
      /^\/v1\/customer-checkout\/(config|quotes|test-payments(?:\/[a-f0-9-]{36})?|orders(?:\/[a-f0-9-]{36}(?:\/payment|\/payment-method|\/hosted-payment|\/watch\?after=[a-f0-9]{64})?)?)$/,
    timeoutMs: 28000,
    maxBytes: 128000,
    accept: 'application/json; profile=pickchick.checkout-wallets-v1',
    signal,
  })(path, method, body, token);

export {
  CustomerCommerceOrderSchema,
  CustomerCheckoutConfigSchema,
  CustomerQuoteSchema,
  CustomerTestPaymentSchema,
};
export const checkoutItems = (cart: CartLine[]) =>
  cart.map((line) => ({
    productId: line.product.id,
    quantity: line.quantity,
    selections: line.selections ?? [],
  }));
export const normalizedOrderComment = (value: string) => value.trim();
export const cartSignature = (cart: CartLine[], serviceMode: string, orderComment = '') =>
  JSON.stringify({
    items: checkoutItems(cart),
    serviceMode,
    ...(normalizedOrderComment(orderComment)
      ? { kitchenComment: normalizedOrderComment(orderComment) }
      : {}),
  });
export function maskedPhone(phone?: string) {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length === 11
    ? `+${digits[0]} ${digits.slice(1, 4)} ••• •• ${digits.slice(-2)}`
    : 'На номер вашего аккаунта';
}

export { publishedCartVersion } from './published-catalog';

// Only our HTTPS checkout page may receive the opaque, short-lived payment token.
// Never include the rejected URL in errors: its fragment is a bearer credential.
export function parseHostedPayment(value: unknown, expectedOrderId: string) {
  const result = CustomerHostedPaymentSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid hosted payment response');
  const payment = result.data;
  const url = new URL(payment.checkoutUrl);
  if (
    payment.orderId !== expectedOrderId ||
    url.protocol !== 'https:' ||
    url.origin !== new URL(API_URL).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== '/v1/integrations/tiptoppay/checkout' ||
    !/^#[a-f0-9]{64}$/.test(url.hash) ||
    Date.parse(payment.expiresAt) <= Date.now()
  )
    throw new Error('Invalid hosted payment response');
  return payment;
}

export function parseHostedTestPayment(value: unknown, expectedQuoteId: string) {
  const result = CustomerTestPaymentSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid test payment response');
  const payment = result.data;
  if (!payment.checkoutUrl || payment.quoteId !== expectedQuoteId)
    throw new Error('Invalid test payment response');
  const url = new URL(payment.checkoutUrl);
  if (
    url.protocol !== 'https:' ||
    url.origin !== new URL(API_URL).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== '/v1/integrations/tiptoppay/test-checkout' ||
    !/^#[a-f0-9]{64}$/.test(url.hash) ||
    Date.parse(payment.expiresAt) <= Date.now()
  )
    throw new Error('Invalid test payment response');
  return payment;
}
