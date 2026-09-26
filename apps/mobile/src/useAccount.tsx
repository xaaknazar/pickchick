import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { fetch as customerFetch } from 'expo/fetch';
import { API_URL } from './api';
import { DemoAccountProvider, useOptionalDemoAccount } from './useDemoAccount';
import type { DemoAccount, DemoChallenge } from './demo-account';
import type { DemoProfileInput } from './profile-details';
import {
  CUSTOMER_SESSION_KEY,
  CustomerSessionCore,
  CustomerSessionError,
  type CustomerChannel,
} from './customer-session';
import { createCustomerRequest } from './customer-http';

export const SERVER_CUSTOMER_AUTH = process.env.EXPO_PUBLIC_CUSTOMER_AUTH === 'server';
type Account = Omit<DemoAccount, 'kind'> & {
  kind: 'local_demo' | 'server_customer';
  customerId?: string;
};
interface AccountContextValue {
  mode: 'demo' | 'server';
  channels: CustomerChannel[];
  activeChannel: CustomerChannel | null;
  deliveryConsentVersion: string | null;
  account: Account | null;
  challenge: DemoChallenge | null;
  deliveryUnknown: boolean;
  pendingVerify: boolean;
  pendingOtp: boolean;
  legal: { version: string; termsUrl: string; privacyUrl: string } | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  retryRestore(): Promise<boolean>;
  requestCode(
    phone: string,
    channel?: CustomerChannel,
    acceptedDeliveryVersion?: string | null,
  ): Promise<boolean>;
  verifyCode(code: string, acceptedVersion?: string | null): Promise<boolean>;
  saveProfile(input: DemoProfileInput): Promise<boolean>;
  cancelChallenge(): void;
  signOut(): Promise<boolean>;
  deleteAccount(): Promise<boolean>;
}
const CustomerContext = createContext<AccountContextValue | null>(null);
function makeCore(): CustomerSessionCore {
  return new CustomerSessionCore({
    read: async () =>
      Platform.OS === 'web'
        ? sessionStorage.getItem(CUSTOMER_SESSION_KEY)
        : SecureStore.getItemAsync(CUSTOMER_SESSION_KEY),
    write: async (raw) => {
      if (Platform.OS === 'web') sessionStorage.setItem(CUSTOMER_SESSION_KEY, raw);
      else
        await SecureStore.setItemAsync(CUSTOMER_SESSION_KEY, raw, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
    },
    randomId: Crypto.randomUUID,
    now: Date.now,
    request: createCustomerRequest(API_URL, customerFetch),
  });
}
function message(error: unknown): string {
  if (!(error instanceof CustomerSessionError))
    return 'Не удалось прочитать или сохранить доступ на устройстве. Попробуйте ещё раз.';
  const messages: Record<string, string> = {
    INVALID_PHONE: 'Введите мобильный номер Казахстана.',
    INVALID_CODE: 'Введите код из шести цифр.',
    UNAUTHORIZED: 'Код не подошёл или доступ был отозван. Проверьте код либо войдите снова.',
    RATE_LIMITED:
      'Подождите перед повторным запросом. Лимит защищает ваш номер от лишних сообщений.',
    INVALID_REQUEST: 'Проверьте введённые данные. При необходимости запросите новый код.',
    NO_CHALLENGE: 'Сначала запросите код на свой номер.',
    CONSENT_REQUIRED: 'Подтвердите условия заказа и обработку данных для входа.',
    INVALID_PROFILE: 'Проверьте имя и дату рождения.',
    SERVICE_UNAVAILABLE: 'Этот способ входа сейчас недоступен. Попробуйте позднее.',
    NETWORK_UNAVAILABLE:
      'Нет связи с сервером. Сохранённый вход останется на устройстве. Попробуйте ещё раз.',
    RESTORE_REQUIRED: 'Не удалось прочитать сохранённый вход. Повторите восстановление.',
    LOGOUT_PENDING:
      'Выход ожидает связи с сервером. Нажмите «Повторить», когда интернет восстановится.',
    CONFLICT: 'Не удалось подтвердить операцию. Повторите восстановление доступа.',
  };
  return messages[error.code] ?? 'Не удалось подтвердить действие. Попробуйте ещё раз.';
}
function ServerAccountProvider({ children }: { children: ReactNode }) {
  const [core] = useState(makeCore);
  const [account, setAccount] = useState<Account | null>(null);
  const [challenge, setChallenge] = useState<DemoChallenge | null>(null);
  const [deliveryUnknown, setDeliveryUnknown] = useState(false);
  const [pendingVerify, setPendingVerify] = useState(false);
  const [pendingOtp, setPendingOtp] = useState(false);
  const [channels, setChannels] = useState<CustomerChannel[]>([]);
  const [activeChannel, setActiveChannel] = useState<CustomerChannel | null>(null);
  const [legal, setLegal] = useState<AccountContextValue['legal']>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(true);
  const snapshot = useCallback(() => {
    const customer = core.customer;
    setAccount(
      customer
        ? {
            version: 2,
            kind: 'server_customer',
            customerId: customer.id,
            phone: customer.phone,
            createdAt: Date.parse(customer.created_at),
            profile: {
              nickname: customer.nickname,
              birthDate: customer.birth_date,
              gender: customer.gender,
              completedAt:
                customer.profile_completed_at === null
                  ? null
                  : Date.parse(customer.profile_completed_at),
            },
          }
        : null,
    );
    setChallenge(
      core.challenge
        ? {
            phone: core.challenge.phone,
            expiresAt: Date.parse(core.challenge.expires_at),
            resendAt: Date.parse(core.challenge.resend_at),
            attemptsLeft: 5,
          }
        : null,
    );
    setDeliveryUnknown(core.challenge?.delivery_status === 'unknown');
    setPendingVerify(core.pendingVerify);
    setPendingOtp(core.pendingOtp);
    setChannels(core.config.channels);
    setActiveChannel(core.pendingChannel ?? core.challenge?.channel ?? null);
    setLegal(
      core.config.consent_version && core.config.terms_url && core.config.privacy_url
        ? {
            version: core.config.consent_version,
            termsUrl: core.config.terms_url,
            privacyUrl: core.config.privacy_url,
          }
        : null,
    );
    setReady(core.ready);
  }, [core]);
  const run = useCallback(
    async (operation: () => Promise<void>): Promise<boolean> => {
      if (locked.current) return false;
      locked.current = true;
      setBusy(true);
      setError(null);
      try {
        await operation();
        snapshot();
        return true;
      } catch (cause) {
        snapshot();
        setError(
          core.closing ? message(new CustomerSessionError('LOGOUT_PENDING')) : message(cause),
        );
        return false;
      } finally {
        locked.current = false;
        setBusy(false);
      }
    },
    [core, snapshot],
  );
  useEffect(() => {
    let active = true;
    core
      .restore()
      .then(async () => {
        if (!active) return;
        snapshot();
        // Cached identity remains usable for display if refreshing fails offline.
        try {
          await core.sync();
        } catch (cause) {
          if (active) setError(message(cause));
        }
        if (active) snapshot();
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        locked.current = false;
        if (active) setBusy(false);
      });
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && core.ready) void run(() => core.sync());
    });
    return () => {
      active = false;
      listener.remove();
    };
  }, [core, run, snapshot]);
  return (
    <CustomerContext.Provider
      value={{
        mode: 'server',
        channels,
        activeChannel,
        deliveryConsentVersion: core.challenge?.deliveryConsentVersion ?? null,
        account,
        challenge,
        deliveryUnknown,
        pendingVerify,
        pendingOtp,
        legal,
        ready,
        busy,
        error,
        retryRestore: () =>
          run(async () => {
            await core.restore();
            snapshot();
            await core.sync();
          }),
        requestCode: (phone, channel, version) =>
          run(() => core.requestCode(phone, channel, version)),
        verifyCode: (code, acceptedVersion = null) =>
          run(() => core.verifyCode(code, acceptedVersion)),
        saveProfile: (input) => run(() => core.saveProfile(input)),
        cancelChallenge: () => {
          void run(() => core.cancelChallenge());
        },
        signOut: () => run(() => core.signOut()),
        deleteAccount: () => run(() => core.deleteAccount()),
      }}
    >
      {children}
    </CustomerContext.Provider>
  );
}
export function AccountProvider({ children }: { children: ReactNode }) {
  return SERVER_CUSTOMER_AUTH ? (
    <ServerAccountProvider>{children}</ServerAccountProvider>
  ) : (
    <DemoAccountProvider>{children}</DemoAccountProvider>
  );
}
export function useAccount(): AccountContextValue {
  const server = useContext(CustomerContext);
  const demo = useOptionalDemoAccount();
  if (server) return server;
  if (!demo) throw new Error('AccountProvider is missing');
  return {
    ...demo,
    mode: 'demo',
    channels: ['sms'],
    activeChannel: 'sms',
    deliveryConsentVersion: null,
    deliveryUnknown: false,
    pendingVerify: false,
    pendingOtp: false,
    legal: null,
    deleteAccount: demo.signOut,
  };
}
