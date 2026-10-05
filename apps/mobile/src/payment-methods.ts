export type CommercePaymentMethod = 'kaspi' | 'card' | 'apple_pay' | 'google_pay';
export function availablePaymentMethods(
  configured: readonly CommercePaymentMethod[] | undefined,
  platform: string,
  webWallets: { applePay?: boolean; googlePay?: boolean } = {},
): CommercePaymentMethod[] {
  return [...new Set(configured ?? ['kaspi' as const])].filter((method) =>
    method === 'apple_pay'
      ? platform === 'ios' || (platform === 'web' && webWallets.applePay === true)
      : method === 'google_pay'
        ? platform === 'android' || (platform === 'web' && webWallets.googlePay === true)
        : true,
  );
}
export const paymentNames: Record<CommercePaymentMethod, string> = {
  kaspi: 'Kaspi',
  card: 'Банковская карта',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
};
