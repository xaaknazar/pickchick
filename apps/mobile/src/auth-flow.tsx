import { createContext, useContext } from 'react';
import type { AccountDestination } from './account-access';

// Consent is an explicit Continue action, scoped to this sheet, phone and policy.
export const AuthFlowContext = createContext<{
  destination: AccountDestination | null;
  accepted: { phone: string; version: string } | null;
  accept(phone: string, version: string): void;
} | null>(null);
export const useAuthFlow = () => useContext(AuthFlowContext);
