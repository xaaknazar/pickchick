import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { fetch as nativeFetch } from 'expo/fetch';
import {
  NotificationConfigSchema,
  NotificationInboxSchema,
  NotificationPreferencesSchema,
} from '@pickchick/contracts';
import { API_URL } from '../api';
import { createCustomerRequest } from '../customer-http';
import { useAccount } from '../useAccount';
import { t, useLocale } from '../i18n';
import { notificationId, boundedNativeRequest } from './routing';

type Preferences = ReturnType<typeof NotificationPreferencesSchema.parse>;
type Config = ReturnType<typeof NotificationConfigSchema.parse>;
type Item = ReturnType<typeof NotificationInboxSchema.parse>['items'][number];
const request = createCustomerRequest(API_URL, nativeFetch, {
  allowed:
    /^\/v1\/(notifications\/config|customers\/me\/(notification-preferences|push-devices(?:\/[a-f0-9-]{36})?|notifications(?:\/[a-f0-9-]{36}\/read)?))$/,
  timeoutMs: 10000,
  maxBytes: 128000,
});
const Context = createContext<{
  preferences: Preferences;
  items: Item[];
  busy: boolean;
  available: boolean;
  reason: 'web' | 'login' | 'service' | null;
  error: string | null;
  denied: boolean;
  change(kind: 'orders' | 'promotions', enabled: boolean): Promise<void>;
  refresh(): Promise<void>;
  open(item: Item): Promise<void>;
  openSettings(): Promise<void>;
} | null>(null);
let installationPromise: Promise<string> | null = null;
function installationId() {
  installationPromise ??= (async () => {
    const key = 'pickchick.push.installation.v1';
    const saved = await SecureStore.getItemAsync(key);
    if (saved && /^[a-f0-9-]{36}$/i.test(saved)) return saved;
    const id = Crypto.randomUUID();
    await SecureStore.setItemAsync(key, id);
    return id;
  })().catch((error) => {
    installationPromise = null;
    throw error;
  });
  return installationPromise;
}
const granted = (permission: Notifications.NotificationPermissionsStatus) =>
  permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const account = useAccount(),
    locale = useLocale(),
    router = useRouter();
  const customer =
    account.account?.kind === 'server_customer' ? account.account.customerId : undefined;
  const currentCustomer = useRef(customer);
  currentCustomer.current = customer;
  const [config, setConfig] = useState<Config | null>(null);
  const [preferences, setPreferences] = useState<Preferences>({
    locale,
    orders: false,
    promotions: false,
  });
  const [items, setItems] = useState<Item[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [denied, setDenied] = useState(false);
  const busyRef = useRef(false);
  const supported = Platform.OS === 'ios' ? 'apns' : Platform.OS === 'android' ? 'fcm' : null;
  const reason =
    Platform.OS === 'web'
      ? 'web'
      : !customer
        ? 'login'
        : !config?.enabled || !supported || !config.providers.includes(supported)
          ? 'service'
          : null;
  const access = useCallback(
    async (path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown) => {
      if (!customer || !account.withOrderAccess) throw new Error('sign_in_required');
      const value = await account.withOrderAccess(customer, (token) =>
        request(path, method, body, token),
      );
      if (currentCustomer.current !== customer) throw new Error('account_changed');
      return value;
    },
    [customer, account.withOrderAccess],
  );
  const register = useCallback(
    async (ask: boolean) => {
      if (!supported) throw new Error('unsupported');
      if (Platform.OS === 'android')
        await Notifications.setNotificationChannelAsync('orders', {
          name: t('Мои заказы'),
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      let permission = await Notifications.getPermissionsAsync();
      if (!granted(permission) && ask && permission.canAskAgain)
        permission = await Notifications.requestPermissionsAsync();
      if (!granted(permission)) {
        setDenied(!permission.canAskAgain);
        throw new Error('permission_denied');
      }
      setDenied(false);
      const nativeToken = await boundedNativeRequest(Notifications.getDevicePushTokenAsync());
      const environment =
        Platform.OS === 'ios'
          ? await Application.getIosPushNotificationServiceEnvironmentAsync()
          : 'production';
      if (!environment || typeof nativeToken.data !== 'string')
        throw new Error('native_configuration');
      await access('/v1/customers/me/push-devices', 'POST', {
        installationId: await installationId(),
        provider: supported,
        environment,
        token: nativeToken.data,
        bundleId: Application.applicationId,
      });
    },
    [access, supported],
  );
  const refresh = useCallback(async () => {
    const owner = customer;
    try {
      const next = NotificationConfigSchema.parse(await request('/v1/notifications/config', 'GET'));
      if (currentCustomer.current !== owner) return;
      setConfig(next);
      if (!owner || !next.enabled) return;
      const prefs = NotificationPreferencesSchema.parse(
        await access('/v1/customers/me/notification-preferences', 'GET'),
      );
      if (currentCustomer.current !== owner) return;
      setPreferences(prefs);
      const inbox = NotificationInboxSchema.parse(
        await access('/v1/customers/me/notifications', 'GET'),
      );
      if (currentCustomer.current === owner) {
        setItems(inbox.items);
        setError(null);
      }
    } catch {
      if (currentCustomer.current === owner)
        setError('Не удалось обновить уведомления. Попробуйте ещё раз.');
    }
  }, [customer, access]);
  useEffect(() => {
    setItems([]);
    setPreferences({ locale, orders: false, promotions: false });
    setError(null);
    setDenied(false);
    void refresh();
  }, [customer, refresh]);
  useEffect(() => {
    if (!customer || !config?.enabled) return;
    let active = true;
    void access('/v1/customers/me/notification-preferences', 'PATCH', { locale })
      .then((value) => {
        if (active) setPreferences(NotificationPreferencesSchema.parse(value));
      })
      .catch(() => {
        if (active) setError('Не удалось сохранить язык уведомлений. Повторите попытку.');
      });
    return () => {
      active = false;
    };
  }, [locale, customer, config?.enabled, access]);
  useEffect(() => {
    if (reason || (!preferences.orders && !preferences.promotions)) return;
    let active = true;
    const update = () => {
      void register(false).catch(() => {
        if (active) setError('Проверьте разрешение на уведомления в настройках устройства.');
      });
    };
    update();
    const tokenListener = Notifications.addPushTokenListener(update);
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        update();
        void refresh();
      }
    });
    return () => {
      active = false;
      tokenListener.remove();
      foreground.remove();
    };
  }, [reason, preferences.orders, preferences.promotions, register, refresh]);
  const change = useCallback(
    async (kind: 'orders' | 'promotions', enabled: boolean) => {
      if (reason || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const owner = customer;
      try {
        if (enabled) await register(true);
        const next = NotificationPreferencesSchema.parse(
          await access('/v1/customers/me/notification-preferences', 'PATCH', {
            [kind]: enabled,
            locale,
            ...(kind === 'promotions' && enabled ? { consentVersion: 'notifications-v1' } : {}),
          }),
        );
        if (currentCustomer.current === owner) setPreferences(next);
      } catch {
        if (currentCustomer.current === owner)
          setError('Не удалось изменить уведомления. Проверьте разрешение и повторите попытку.');
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [reason, customer, register, access, locale],
  );
  const open = useCallback(
    async (item: Item) => {
      try {
        await access(`/v1/customers/me/notifications/${item.id}/read`, 'POST');
        router.push('/(tabs)/orders');
        await refresh();
      } catch {
        setError('Не удалось открыть уведомление. Попробуйте ещё раз.');
      }
    },
    [access, router, refresh],
  );
  useEffect(() => {
    if (Platform.OS === 'web') return;
    // In-app state is shown by our inbox/order screens, never by an unverified payload.
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    if (!customer || !config?.enabled) return;
    let active = true;
    const handle = async (response: Notifications.NotificationResponse) => {
      const id = notificationId(response.notification.request.content.data);
      if (!id) return;
      try {
        const inbox = NotificationInboxSchema.parse(
          await access('/v1/customers/me/notifications', 'GET'),
        );
        if (!active) return;
        const item = inbox.items.find((v) => v.id === id);
        if (item) await open(item);
        await Notifications.clearLastNotificationResponseAsync();
      } catch {
        /* Preserve the last response for a later authenticated retry. */
      }
    };
    const response = Notifications.addNotificationResponseReceivedListener((value) => {
      void handle(value);
    });
    const received = Notifications.addNotificationReceivedListener(() => {
      void refresh();
    });
    void Notifications.getLastNotificationResponseAsync()
      .then((value) => {
        if (value && active) void handle(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      response.remove();
      received.remove();
    };
  }, [customer, config?.enabled, access, open, refresh]);
  return (
    <Context.Provider
      value={{
        preferences,
        items,
        busy,
        available: reason === null,
        reason,
        error,
        denied,
        change,
        refresh,
        open,
        openSettings: () => Linking.openSettings(),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useNotifications() {
  const value = useContext(Context);
  if (!value) throw new Error('NotificationsProvider missing');
  return value;
}
