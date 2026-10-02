import { fetch as nativeFetch } from 'expo/fetch';
import {
  CustomerOrderFeedbackResponseSchema,
  CustomerOrderFeedbackListSchema,
  type CustomerOrderFeedbackList,
  type CustomerOrderFeedbackResponse,
} from '@pickchick/contracts';
import { API_URL } from './api';
import { createCustomerRequest } from './customer-http';

export { CustomerOrderFeedbackResponseSchema, type CustomerOrderFeedbackResponse };
export async function orderFeedbackRequest(
  orderId: string,
  method: 'GET' | 'POST',
  body: unknown,
  token: string,
  signal?: AbortSignal,
): Promise<CustomerOrderFeedbackResponse> {
  const request = createCustomerRequest(API_URL, nativeFetch, {
    allowed: /^\/v1\/customer-checkout\/orders\/[a-f0-9-]{36}\/feedback$/,
    timeoutMs: 10000,
    maxBytes: 16000,
    signal,
  });
  return CustomerOrderFeedbackResponseSchema.parse(
    await request(`/v1/customer-checkout/orders/${orderId}/feedback`, method, body, token),
  );
}

export async function listOrderFeedback(
  token: string,
  signal?: AbortSignal,
): Promise<CustomerOrderFeedbackList> {
  const request = createCustomerRequest(API_URL, nativeFetch, {
    allowed: /^\/v1\/customer-checkout\/feedback$/,
    timeoutMs: 10000,
    maxBytes: 128000,
    signal,
  });
  return CustomerOrderFeedbackListSchema.parse(
    await request('/v1/customer-checkout/feedback', 'GET', undefined, token),
  );
}
export { type CustomerOrderFeedbackList };
