import { useMemo } from 'react';
import { useAccount } from './useAccount';
import { TestApiError, TestCustomerClient } from './test-client';

export function useOrderClient() {
  const account = useAccount();
  const id = account.account?.customerId ?? null;
  const authorize = account.withOrderAccess;
  return useMemo(
    () =>
      account.mode === 'server'
        ? new TestCustomerClient({
            customerId: id,
            authorize: (send) => {
              if (!id || !authorize) return Promise.reject(new TestApiError(401, 'UNAUTHORIZED'));
              return authorize(id, send);
            },
          })
        : new TestCustomerClient(),
    [account.mode, id, authorize],
  );
}
