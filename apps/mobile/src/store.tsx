import { withAvailability, availabilityStatus } from './availability';
import { useAvailability } from './useAvailability';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mergeCartLines } from './cart-actions';
import { AppState } from 'react-native';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { MenuSnapshot } from '@pickchick/contracts';
import { isRetryableCatalogError, loadCatalog, loadTestCatalog } from './api';
import { createCatalogRecovery } from './catalog-recovery';
import { DESIGN_RELEASE, designProducts, serverProducts, connectedProducts } from './catalog';
import { unpaidTestOrdersEnabled } from './order-simulator';
import { restaurantLocation } from './restaurant-location';
import { useTestOrders } from './useTestOrders';
import type { TestCatalog } from '@pickchick/test-order-flow/contracts';
import {
  parsePreferences,
  restoreCart,
  replaceCartLine,
  updateQuantity,
  cartLineKey,
  defaultSelections,
  clearMatchingCart,
  type SavedPreferences,
} from './domain';
import type {
  Branch,
  CartLine,
  CatalogMode,
  Connection,
  DiningMode,
  Locale,
  MobileModel,
  PaymentMethod,
} from './model';

const STORAGE_KEY = 'pickchick.mobile.preferences.v1';
const Context = createContext<{ live: MobileModel; preview: MobileModel } | null>(null);

// Keep sequential cart commands atomic even when React batches their renders.
function useCartState() {
  const [value, render] = useState<CartLine[]>([]);
  const current = useRef<CartLine[]>([]);
  const update = useCallback((action: CartLine[] | ((previous: CartLine[]) => CartLine[])) => {
    current.current = typeof action === 'function' ? action(current.current) : action;
    render(current.current);
  }, []);
  return [value, update] as const;
}

export function MobileProvider({ children }: { children: ReactNode }) {
  const [catalogMode, setMode] = useState<CatalogMode>('server');
  const [diningMode, setDiningMode] = useState<DiningMode>('takeaway');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('kaspi');
  const [locale, setLocale] = useState<Locale>('ru');
  const [nickname, setNickname] = useState('');
  const [orderComment, setOrderComment] = useState('');
  const [practiceScore, setPracticeScore] = useState<number | null>(null);
  const [previewPracticeScore, setPreviewPracticeScore] = useState<number | null>(null);
  const [requestedBranchId, setRequestedBranchId] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [menu, setMenu] = useState<MenuSnapshot | null>(null);
  const [unpaidAvailable, setUnpaidAvailable] = useState(false);
  const [connectedCatalog, setConnectedCatalog] = useState<TestCatalog | null>(null);
  const [cart, setCart] = useCartState();
  const [previewCart, setPreviewCart] = useCartState();
  const [previewSelectedId, setPreviewSelectedId] = useState<string | null>(null);
  const [previewDiningMode, setPreviewDiningMode] = useState<DiningMode>('takeaway');
  const [previewPaymentMethod, setPreviewPaymentMethod] = useState<PaymentMethod>('kaspi');
  const [previewNickname, setPreviewNickname] = useState('');
  const [previewOrderComment, setPreviewOrderComment] = useState('');
  const [previewLocale, setPreviewLocale] = useState<Locale>('ru');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [connection, setConnection] = useState<Connection>({
    status: 'loading',
    checkedAt: null,
    message: null,
  });
  const restoration = useRef<SavedPreferences | null>(null);
  const persistQueue = useRef(Promise.resolve());
  const modeRef = useRef(catalogMode);
  modeRef.current = catalogMode;
  const serverRelease = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        const saved = parsePreferences(raw);
        if (saved) {
          restoration.current = saved;
          setMode(saved.catalogMode);
          setDiningMode(saved.diningMode);
          setPaymentMethod(saved.paymentMethod ?? 'kaspi');
          setLocale(saved.locale);
          setNickname(saved.nickname);
          setOrderComment(saved.orderComment ?? '');
          setRequestedBranchId(saved.branchId);
          if (saved.catalogMode === 'design') {
            setCart(restoreCart(saved, designProducts, DESIGN_RELEASE));
            restoration.current = null;
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const recovery = createCatalogRecovery({
      load: async (signal) => {
        const result = await loadCatalog(requestedBranchId, signal);
        if (signal.aborted) throw new Error('Aborted');
        const testCatalog = result.capabilities.features.test_order_flow
          ? await loadTestCatalog(signal)
          : null;
        if (testCatalog && testCatalog.branch_id !== result.branch.id)
          throw new Error('Test branch mismatch');
        return { result, testCatalog };
      },
      isRetryable: isRetryableCatalogError,
      onLoading: () =>
        setConnection((previous) => ({ ...previous, status: 'loading', message: null })),
      onSuccess: ({ result, testCatalog }) => {
        const nextRelease = testCatalog
          ? `test:${testCatalog.catalog_version}`
          : result.menu.release_id;
        const changed = serverRelease.current !== null && serverRelease.current !== nextRelease;
        serverRelease.current = nextRelease;
        // Friendly names are presentation only; IDs and availability remain server-owned.
        setBranches(
          result.branches.map((branch) => ({
            ...branch,
            name: restaurantLocation(branch.id)?.name ?? branch.name,
          })),
        );
        setMenu(result.menu);
        setConnectedCatalog(testCatalog);
        setUnpaidAvailable(result.capabilities.features.unpaid_test_orders === true);
        if (restoration.current && modeRef.current === 'server') {
          setCart(
            restoreCart(
              restoration.current,
              testCatalog ? connectedProducts(testCatalog) : serverProducts(result.menu, 'ru'),
              nextRelease,
            ),
          );
          restoration.current = null;
        } else if (changed && modeRef.current === 'server') {
          setCart([]);
        }
        setConnection({
          status: 'online',
          checkedAt: new Date().toISOString(),
          message: null,
        });
      },
      onFailure: () =>
        setConnection((previous) => ({
          ...previous,
          status: 'offline',
          message: 'Не удалось обновить меню. Проверьте интернет и повторите.',
        })),
    });
    const subscription = AppState.addEventListener('change', (state) =>
      recovery.setActive(state === 'active'),
    );
    recovery.setActive(
      AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
    );
    return () => {
      subscription.remove();
      recovery.stop();
    };
  }, [hydrated, requestedBranchId, refreshIndex]);

  const availability = useAvailability(hydrated && catalogMode === 'server', refreshIndex);
  const baseProducts = useMemo(
    () =>
      catalogMode === 'design'
        ? designProducts
        : connectedCatalog
          ? connectedProducts(connectedCatalog)
          : serverProducts(menu, locale),
    [catalogMode, menu, locale, connectedCatalog],
  );
  const products = useMemo(
    () => withAvailability(baseProducts, availability.data),
    [baseProducts, availability],
  );
  const branch =
    branches.find((candidate) => candidate.id === requestedBranchId) ?? branches[0] ?? null;
  const releaseId =
    catalogMode === 'design'
      ? DESIGN_RELEASE
      : connectedCatalog
        ? `test:${connectedCatalog.catalog_version}`
        : (menu?.release_id ?? null);
  const testFlow = useTestOrders(
    connectedCatalog !== null &&
      catalogMode === 'server' &&
      connection.status === 'online' &&
      (!unpaidTestOrdersEnabled || unpaidAvailable),
    cart,
    diningMode,
    paymentMethod,
  );

  useEffect(() => {
    if (!hydrated) return;
    const pendingCart = restoration.current;
    const saved: SavedPreferences = {
      version: 1,
      catalogMode,
      diningMode,
      paymentMethod,
      locale,
      nickname,
      orderComment,
      branchId: branch?.id ?? requestedBranchId,
      releaseId: pendingCart?.releaseId ?? releaseId,
      lines:
        pendingCart?.lines ??
        cart.map((line) => ({
          id: line.product.id,
          quantity: line.quantity,
          ...(line.selections ? { selections: line.selections } : {}),
        })),
    };
    persistQueue.current = persistQueue.current
      .catch(() => {})
      .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saved)));
    void persistQueue.current.catch(() => {});
  }, [
    hydrated,
    catalogMode,
    diningMode,
    paymentMethod,
    locale,
    nickname,
    orderComment,
    branch?.id,
    requestedBranchId,
    releaseId,
    cart,
  ]);

  const resetLocalData = () => {
    restoration.current = null;
    setCart([]);
    setNickname('');
    setOrderComment('');
    setLocale('ru');
    setDiningMode('takeaway');
    setPaymentMethod('kaspi');
    setMode('server');
    setRequestedBranchId(null);
    setMenu(null);
    setConnectedCatalog(null);
    setPracticeScore(null);
    setRefreshIndex((previous) => previous + 1);
    setSelectedId(null);
    persistQueue.current = persistQueue.current
      .catch(() => {})
      .then(() => AsyncStorage.removeItem(STORAGE_KEY));
    void persistQueue.current.catch(() => {});
  };

  const model: MobileModel = {
    products,
    upsellProductIds:
      connectedCatalog && 'upsell_product_ids' in connectedCatalog
        ? connectedCatalog.upsell_product_ids
        : ['toast', 'sauce', 'cola'],
    cart: cart.map((line) => ({
      ...line,
      product: products.find((p) => p.id === line.product.id) ?? line.product,
    })),
    availabilityFresh:
      availabilityStatus(availability) === 'disabled'
        ? undefined
        : availabilityStatus(availability) === 'current',
    availabilityStatus: availabilityStatus(availability),
    availabilityHours: availability.data?.hours,
    catalogMode,
    diningMode,
    paymentMethod,
    locale,
    branches,
    branch,
    connection,
    selectedProduct: products.find((product) => product.id === selectedId) ?? products[0] ?? null,
    nickname,
    orderComment,
    testFlow,
    practiceScore,
    setPracticeScore,
    setNickname: (value) => setNickname(value.slice(0, 32)),
    setOrderComment: (value) => setOrderComment(value.slice(0, 60)),
    setLocale,
    setDiningMode,
    setPaymentMethod,
    setBranch: (id) => {
      if (!branches.some((candidate) => candidate.id === id)) return;
      if (branch?.id === id) return;
      restoration.current = null;
      setCart([]);
      setOrderComment('');
      setMenu(null);
      setConnectedCatalog(null);
      setRequestedBranchId(id);
    },
    setCatalogMode: (mode) => {
      if (mode === catalogMode) return;
      restoration.current = null;
      setCart([]);
      setOrderComment('');
      setSelectedId(null);
      setMode(mode);
    },
    selectProduct: setSelectedId,
    appendCartLines: (lines) => {
      restoration.current = null;
      let accepted = false;
      setCart((previous) => {
        const next = mergeCartLines(previous, lines, products);
        accepted = next !== null;
        return next ?? previous;
      });
      return accepted;
    },
    addToCart: (id, selections, quantity = 1) => {
      const product = products.find((candidate) => candidate.id === id);
      if (!product || product.available === false) return;
      const chosen = selections ?? defaultSelections(product);
      const key = cartLineKey({ product, selections: chosen });
      restoration.current = null;
      setCart((previous) =>
        updateQuantity(
          previous,
          product,
          (previous.find((line) => cartLineKey(line) === key)?.quantity ?? 0) + quantity,
          chosen,
        ),
      );
    },
    setQuantity: (id, quantity) => {
      restoration.current = null;
      setCart((previous) => {
        const line = previous.find((l) => cartLineKey(l) === id);
        return line ? updateQuantity(previous, line.product, quantity, line.selections) : previous;
      });
    },
    replaceCartLine: (original, selections, quantity) => {
      restoration.current = null;
      setCart((previous) => replaceCartLine(previous, original, selections, quantity));
    },
    clearCart: (expected) => {
      restoration.current = null;
      setCart((previous) => clearMatchingCart(previous, expected));
    },
    refresh: () => setRefreshIndex((previous) => previous + 1),
    resetLocalData,
  };
  const previewModel: MobileModel = {
    ...model,
    availabilityFresh: undefined,
    availabilityStatus: undefined,
    availabilityHours: undefined,
    testFlow: {
      ...testFlow,
      available: false,
      restored: true,
      hasSavedSession: false,
      recoveryAvailable: false,
      recoverPending: async () => null,
      sessionExpired: false,
      continueSession: async () => false,
      current: null,
      orders: [],
      select: () => {},
      refresh: () => {},
      submit: async () => null,
      pay: async () => null,
      cancel: async () => null,
    },
    products: designProducts,
    upsellProductIds: ['toast', 'sauce', 'cola'],
    cart: previewCart,
    catalogMode: 'design',
    selectedProduct:
      designProducts.find((product) => product.id === previewSelectedId) ??
      designProducts[0] ??
      null,
    diningMode: previewDiningMode,
    paymentMethod: previewPaymentMethod,
    setPaymentMethod: setPreviewPaymentMethod,
    setDiningMode: setPreviewDiningMode,
    nickname: previewNickname,
    orderComment: previewOrderComment,
    setNickname: (value) => setPreviewNickname(value.slice(0, 32)),
    setOrderComment: (value) => setPreviewOrderComment(value.slice(0, 60)),
    practiceScore: previewPracticeScore,
    setPracticeScore: setPreviewPracticeScore,
    locale: previewLocale,
    setLocale: setPreviewLocale,
    setCatalogMode: () => {},
    setBranch: () => {},
    selectProduct: setPreviewSelectedId,
    appendCartLines: (lines) => {
      let accepted = false;
      setPreviewCart((previous) => {
        const next = mergeCartLines(previous, lines, designProducts);
        accepted = next !== null;
        return next ?? previous;
      });
      return accepted;
    },
    addToCart: (id, selections, quantity = 1) => {
      const product = designProducts.find((candidate) => candidate.id === id);
      if (!product) return;
      const chosen = selections ?? defaultSelections(product);
      const key = cartLineKey({ product, selections: chosen });
      setPreviewCart((previous) =>
        updateQuantity(
          previous,
          product,
          (previous.find((l) => cartLineKey(l) === key)?.quantity ?? 0) + quantity,
          chosen,
        ),
      );
    },
    setQuantity: (id, quantity) =>
      setPreviewCart((previous) => {
        const line = previous.find((l) => cartLineKey(l) === id);
        return line ? updateQuantity(previous, line.product, quantity, line.selections) : previous;
      }),
    replaceCartLine: (original, selections, quantity) =>
      setPreviewCart((previous) => replaceCartLine(previous, original, selections, quantity)),
    clearCart: (expected) => setPreviewCart((previous) => clearMatchingCart(previous, expected)),
    resetLocalData: () => {
      setPreviewCart([]);
      setPreviewNickname('');
      setPreviewPaymentMethod('kaspi');
    },
  };
  return (
    <Context.Provider value={{ live: model, preview: previewModel }}>{children}</Context.Provider>
  );
}

export function useMobile(preview = false): MobileModel {
  const models = useContext(Context);
  if (!models) throw new Error('MobileProvider missing');
  return preview ? models.preview : models.live;
}
