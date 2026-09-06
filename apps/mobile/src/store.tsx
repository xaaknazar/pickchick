import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { MenuSnapshot } from '@pickchick/contracts';
import { loadCatalog } from './api';
import { DESIGN_RELEASE, designProducts, serverProducts, connectedProducts } from './catalog';
import { loadTestCatalog } from './test-client';
import { useTestOrders } from './useTestOrders';
import type { TestCatalog } from '@pickchick/test-order-flow/contracts';
import { parsePreferences, restoreCart, updateQuantity, type SavedPreferences } from './domain';
import type {
  Branch,
  CartLine,
  CatalogMode,
  Connection,
  DiningMode,
  Locale,
  MobileModel,
} from './model';

const STORAGE_KEY = 'pickchick.mobile.preferences.v1';
const Context = createContext<{ live: MobileModel; preview: MobileModel } | null>(null);

export function MobileProvider({ children }: { children: ReactNode }) {
  const [catalogMode, setMode] = useState<CatalogMode>('server');
  const [diningMode, setDiningMode] = useState<DiningMode>('takeaway');
  const [locale, setLocale] = useState<Locale>('ru');
  const [nickname, setNickname] = useState('');
  const [practiceScore, setPracticeScore] = useState<number | null>(null);
  const [previewPracticeScore, setPreviewPracticeScore] = useState<number | null>(null);
  const [requestedBranchId, setRequestedBranchId] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [menu, setMenu] = useState<MenuSnapshot | null>(null);
  const [connectedCatalog, setConnectedCatalog] = useState<TestCatalog | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [previewCart, setPreviewCart] = useState<CartLine[]>([]);
  const [previewSelectedId, setPreviewSelectedId] = useState<string | null>(null);
  const [previewDiningMode, setPreviewDiningMode] = useState<DiningMode>('takeaway');
  const [previewNickname, setPreviewNickname] = useState('');
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
          setLocale(saved.locale);
          setNickname(saved.nickname);
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
    const controller = new AbortController();
    setConnection((previous) => ({ ...previous, status: 'loading', message: null }));
    void loadCatalog(requestedBranchId, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return;
        const testCatalog = result.capabilities.features.test_order_flow
          ? await loadTestCatalog()
          : null;
        if (controller.signal.aborted) return;
        if (testCatalog && testCatalog.branch_id !== result.branch.id)
          throw new Error('Test branch mismatch');
        const nextRelease = testCatalog
          ? `test:${testCatalog.catalog_version}`
          : result.menu.release_id;
        const changed = serverRelease.current !== null && serverRelease.current !== nextRelease;
        const savedChanged =
          restoration.current !== null && restoration.current.releaseId !== nextRelease;
        serverRelease.current = nextRelease;
        setBranches(result.branches);
        setMenu(result.menu);
        setConnectedCatalog(testCatalog);
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
          message:
            changed || savedChanged ? 'Меню обновилось. Соберите корзину по новым ценам.' : null,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setConnection((previous) => ({
            ...previous,
            status: 'offline',
            message: 'Не удалось обновить меню. Проверьте интернет и повторите.',
          }));
      });
    return () => controller.abort();
  }, [hydrated, requestedBranchId, refreshIndex]);

  const products = useMemo(
    () =>
      catalogMode === 'design'
        ? designProducts
        : connectedCatalog
          ? connectedProducts(connectedCatalog)
          : serverProducts(menu, locale),
    [catalogMode, menu, locale, connectedCatalog],
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
    connectedCatalog !== null && catalogMode === 'server',
    cart,
    diningMode,
  );

  useEffect(() => {
    if (!hydrated) return;
    const pendingCart = restoration.current;
    const saved: SavedPreferences = {
      version: 1,
      catalogMode,
      diningMode,
      locale,
      nickname,
      branchId: branch?.id ?? requestedBranchId,
      releaseId: pendingCart?.releaseId ?? releaseId,
      lines:
        pendingCart?.lines ??
        cart.map((line) => ({ id: line.product.id, quantity: line.quantity })),
    };
    persistQueue.current = persistQueue.current
      .catch(() => {})
      .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saved)));
    void persistQueue.current.catch(() => {});
  }, [
    hydrated,
    catalogMode,
    diningMode,
    locale,
    nickname,
    branch?.id,
    requestedBranchId,
    releaseId,
    cart,
  ]);

  const resetLocalData = () => {
    restoration.current = null;
    setCart([]);
    setNickname('');
    setLocale('ru');
    setDiningMode('takeaway');
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
    cart,
    catalogMode,
    diningMode,
    locale,
    branches,
    branch,
    connection,
    selectedProduct: products.find((product) => product.id === selectedId) ?? products[0] ?? null,
    nickname,
    testFlow,
    practiceScore,
    setPracticeScore,
    setNickname: (value) => setNickname(value.slice(0, 32)),
    setLocale,
    setDiningMode,
    setBranch: (id) => {
      if (!branches.some((candidate) => candidate.id === id)) return;
      if (branch?.id === id) return;
      restoration.current = null;
      setCart([]);
      setMenu(null);
      setConnectedCatalog(null);
      setRequestedBranchId(id);
    },
    setCatalogMode: (mode) => {
      if (mode === catalogMode) return;
      restoration.current = null;
      setCart([]);
      setSelectedId(null);
      setMode(mode);
    },
    selectProduct: setSelectedId,
    addToCart: (id) => {
      const product = products.find((candidate) => candidate.id === id);
      if (!product) return;
      restoration.current = null;
      setCart((previous) =>
        updateQuantity(
          previous,
          product,
          (previous.find((line) => line.product.id === id)?.quantity ?? 0) + 1,
        ),
      );
    },
    setQuantity: (id, quantity) => {
      const product = products.find((candidate) => candidate.id === id);
      if (!product) return;
      restoration.current = null;
      setCart((previous) => updateQuantity(previous, product, quantity));
    },
    clearCart: () => {
      restoration.current = null;
      setCart([]);
    },
    refresh: () => setRefreshIndex((previous) => previous + 1),
    resetLocalData,
  };
  const previewModel: MobileModel = {
    ...model,
    testFlow: {
      ...testFlow,
      available: false,
      current: null,
      orders: [],
      select: () => {},
      refresh: () => {},
      submit: async () => null,
      pay: async () => null,
      cancel: async () => null,
    },
    products: designProducts,
    cart: previewCart,
    catalogMode: 'design',
    selectedProduct:
      designProducts.find((product) => product.id === previewSelectedId) ??
      designProducts[0] ??
      null,
    diningMode: previewDiningMode,
    setDiningMode: setPreviewDiningMode,
    nickname: previewNickname,
    setNickname: (value) => setPreviewNickname(value.slice(0, 32)),
    practiceScore: previewPracticeScore,
    setPracticeScore: setPreviewPracticeScore,
    locale: previewLocale,
    setLocale: setPreviewLocale,
    setCatalogMode: () => {},
    setBranch: () => {},
    selectProduct: setPreviewSelectedId,
    addToCart: (id) => {
      const product = designProducts.find((candidate) => candidate.id === id);
      if (product)
        setPreviewCart((previous) =>
          updateQuantity(
            previous,
            product,
            (previous.find((line) => line.product.id === id)?.quantity ?? 0) + 1,
          ),
        );
    },
    setQuantity: (id, quantity) => {
      const product = designProducts.find((candidate) => candidate.id === id);
      if (product) setPreviewCart((previous) => updateQuantity(previous, product, quantity));
    },
    clearCart: () => setPreviewCart([]),
    resetLocalData: () => {
      setPreviewCart([]);
      setPreviewNickname('');
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
