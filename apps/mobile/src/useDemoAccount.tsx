import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEMO_ACCOUNT_KEY,
  DemoAccountCore,
  DemoLoginError,
  type DemoAccount,
  type DemoChallenge,
} from './demo-account';
import type { DemoProfileInput } from './profile-details';

function createCore() {
  return new DemoAccountCore({
    read: () =>
      Platform.OS === 'web'
        ? AsyncStorage.getItem(DEMO_ACCOUNT_KEY)
        : SecureStore.getItemAsync(DEMO_ACCOUNT_KEY),
    write: (raw) =>
      Platform.OS === 'web'
        ? AsyncStorage.setItem(DEMO_ACCOUNT_KEY, raw)
        : SecureStore.setItemAsync(DEMO_ACCOUNT_KEY, raw, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          }),
    remove: () =>
      Platform.OS === 'web'
        ? AsyncStorage.removeItem(DEMO_ACCOUNT_KEY)
        : SecureStore.deleteItemAsync(DEMO_ACCOUNT_KEY),
    now: Date.now,
  });
}

function errorMessage(error: unknown): string {
  if (!(error instanceof DemoLoginError))
    return 'Не удалось сохранить данные на устройстве. Попробуйте ещё раз.';
  const messages = {
    invalid_phone: 'Введите мобильный номер Казахстана: +7 и ещё 10 цифр, начиная с 7.',
    wait_to_resend: 'Подождите до повторного запроса кода.',
    no_challenge: 'Сначала укажите номер телефона.',
    expired: 'Время действия кода истекло. Запросите новый код входа.',
    attempts_exhausted: 'Попытки закончились. Запросите новый код входа.',
    invalid_code: 'Код не подошёл. Для этого входа используйте 123456.',
    invalid_profile: 'Проверьте данные профиля и дату рождения.',
    no_account: 'Сначала войдите в аккаунт.',
    restore_required: 'Не удалось прочитать сохранённый профиль. Повторите чтение данных.',
  };
  return messages[error.code];
}

export interface DemoAccountContextValue {
  account: DemoAccount | null;
  challenge: DemoChallenge | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  retryRestore(): Promise<boolean>;
  requestCode(phone: string): Promise<boolean>;
  verifyCode(code: string): Promise<boolean>;
  saveProfile(input: DemoProfileInput): Promise<boolean>;
  cancelChallenge(): void;
  signOut(): Promise<boolean>;
}
const DemoAccountContext = createContext<DemoAccountContextValue | null>(null);

export function DemoAccountProvider({ children }: { children: ReactNode }) {
  const [core] = useState(createCore);
  const [account, setAccount] = useState<DemoAccount | null>(null);
  const [challenge, setChallenge] = useState<DemoChallenge | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(true);
  const snapshot = useCallback(() => {
    setAccount(core.account);
    setChallenge(core.challenge);
  }, [core]);
  useEffect(() => {
    let active = true;
    locked.current = true;
    setBusy(true);
    core
      .restore()
      .then(() => {
        if (active) {
          snapshot();
          setReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setReady(false);
          setError('Не удалось прочитать сохранённый профиль. Повторите чтение данных.');
        }
      })
      .finally(() => {
        locked.current = false;
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [core, snapshot]);

  const retryRestore = useCallback(async (): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setReady(false);
    setError(null);
    try {
      await core.restore();
      snapshot();
      setReady(true);
      return true;
    } catch {
      // Do not offer a fresh login over a record that storage could not read.
      setError('Не удалось прочитать сохранённый профиль. Повторите чтение данных.');
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }, [core, snapshot]);

  const run = useCallback(
    async (operation: () => Promise<void> | void): Promise<boolean> => {
      if (locked.current || !ready) return false;
      locked.current = true;
      setBusy(true);
      setError(null);
      try {
        await operation();
        snapshot();
        return true;
      } catch (cause) {
        snapshot();
        setError(errorMessage(cause));
        return false;
      } finally {
        locked.current = false;
        setBusy(false);
      }
    },
    [ready, snapshot],
  );

  return (
    <DemoAccountContext.Provider
      value={{
        account,
        challenge,
        ready,
        busy,
        error,
        retryRestore,
        requestCode: (phone) => run(() => core.requestCode(phone)),
        verifyCode: (code) => run(() => core.verifyCode(code)),
        saveProfile: (input) => run(() => core.saveProfile(input)),
        cancelChallenge: () => {
          if (locked.current) return;
          core.cancelChallenge();
          setError(null);
          snapshot();
        },
        signOut: () => run(() => core.signOut()),
      }}
    >
      {children}
    </DemoAccountContext.Provider>
  );
}

export function useDemoAccount(): DemoAccountContextValue {
  const context = useContext(DemoAccountContext);
  if (!context) throw new Error('DemoAccountProvider is missing');
  return context;
}

export function useOptionalDemoAccount(): DemoAccountContextValue | null {
  return useContext(DemoAccountContext);
}
