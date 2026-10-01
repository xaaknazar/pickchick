import { fetch as nativeFetch } from 'expo/fetch';
import {
  CustomerCommerceOrderSchema,
  CustomerCheckoutConfigSchema,
  CustomerQuoteSchema,
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
      /^\/v1\/customer-checkout\/(config|quotes|orders(?:\/[a-f0-9-]{36}(?:\/payment|\/watch\?after=[a-f0-9]{64})?)?)$/,
    timeoutMs: 28000,
    maxBytes: 128000,
    accept: 'application/json; profile="pickchick.checkout-comments-v1"',
    signal,
  })(path, method, body, token);

export { CustomerCommerceOrderSchema, CustomerCheckoutConfigSchema, CustomerQuoteSchema };
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
