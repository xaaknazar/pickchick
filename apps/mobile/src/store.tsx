import { restoreLegacyPublishedCart, publishedCartStorageRelease } from './published-catalog';
import { repriceCart, PRICES_UPDATED } from './cart-reprice';
import type { CatalogMediaMap, CatalogMobileStorefront } from '@pickchick/catalog-admin/contracts';
import { withAvailability, catalogAvailability } from './availability';
import { useAvailability } from './useAvailability';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mergeCartLines } from './cart-actions';
import { subscribeCatalogConnectivity } from './connectivity';
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
import { isRetryableCatalogError, loadCatalog, readCatalogMedia, loadTestCatalog } from './api';
import { interimMedia } from './product-photo';
import {
  PUBLISHED_CATALOG_REFRESH_MS,
  catalogRefreshTarget,
  createCatalogRecovery,
} from './catalog-recovery';
import { prefetchCatalogMedia } from './components/ProductPhoto';
import {
  DESIGN_RELEASE,
  designProducts,
  serverProducts,
  connectedProducts,
  publishedProducts,
} from './catalog';
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
  lineUnitPrice,
  cartTotal,
  selectionKey,
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
  const [catalogUpdateNotice, setCatalogUpdateNotice] = useState<string | null>(null);
  const [cartChanges, setCartChanges] = useState<{ oldTotal: string; newTotal: string } | null>(
    null,
  );
  const [publication, setPublication] = useState<CatalogMobileStorefront | null>(null);
  const [media, setMedia] = useState<CatalogMediaMap | null>(null);
  const [mediaReadVersion, setMediaReadVersion] = useState<number | null>(null);
  const mediaRef = useRef(media);
  mediaRef.current = media;
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
  const cartPublication = useRef<CatalogMobileStorefront | null>(null);
  const catalogRecovery = useRef<{ refresh(): Promise<boolean> } | null>(null);
  const requestedCatalogVersion = useRef<number | null>(null);

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
        const result = await loadCatalog(requestedBranchId, signal, { deferMedia: true });
        if (signal.aborted) throw new Error('Aborted');
        const testCatalog =
          !result.publication && result.capabilities.features.test_order_flow
            ? await loadTestCatalog(signal)
            : null;
        if (testCatalog && testCatalog.branch_id !== result.branch.id)
          throw new Error('Test branch mismatch');
        return { result, testCatalog };
      },
      isRetryable: isRetryableCatalogError,
      // A published menu is re-read every minute in the foreground (and at once when the
      // availability long-poll reports a newer head). Legacy menus keep the read-once behaviour.
      successDelay: ({ result }) => (result.publication ? PUBLISHED_CATALOG_REFRESH_MS : null),
      onLoading: (background) => {
        if (!background)
          setConnection((previous) => ({ ...previous, status: 'loading', message: null }));
      },
      onSuccess: ({ result, testCatalog }) => {
        const nextRelease = result.publication
          ? `published:${result.branch.id}:${result.publication.version}`
          : testCatalog
            ? `test:${testCatalog.catalog_version}`
            : result.menu!.release_id;
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
        setPublication(result.publication);
        // Media is read after the menu; meanwhile the previous photos stay on screen.
        const nextMedia =
          mediaRef.current?.version === result.publication?.version
            ? mediaRef.current
            : interimMedia(mediaRef.current, result.media);
        mediaRef.current = nextMedia;
        setMedia(nextMedia);
        setConnectedCatalog(testCatalog);
        setUnpaidAvailable(result.capabilities.features.unpaid_test_orders === true);
        if (restoration.current && modeRef.current === 'server') {
          const legacy = result.publication && !restoration.current.publication;
          const legacyCart = legacy
            ? restoreLegacyPublishedCart(restoration.current, designProducts)
            : null;
          const restored = legacy
            ? legacyCart!
            : restoreCart(
                restoration.current,
                result.publication
                  ? publishedProducts(
                      restoration.current.publication ?? result.publication,
                      'ru',
                      nextMedia,
                    )
                  : testCatalog
                    ? connectedProducts(testCatalog)
                    : serverProducts(result.menu, 'ru'),
                result.publication && restoration.current.publication
                  ? restoration.current.releaseId
                  : nextRelease,
              );
          setCart(restored);
          if (legacy && restoration.current.lines.length && !legacyCart?.length)
            setCatalogUpdateNotice(
              'Версия прежней корзины больше недоступна. Добавьте блюда из актуального меню и проверьте цены перед оформлением.',
            );
          restoration.current = null;
        }
        if (result.publication && modeRef.current === 'server') {
          const currentProducts = publishedProducts(result.publication, locale, nextMedia);
          setCart((previous) => {
            const repriced = repriceCart(previous, currentProducts);
            const changes = repriced.changes;
            cartPublication.current = result.publication;
            // Owner decision: only the price notice is shown. Removed lines (a chosen option
            // left the menu) and new prices both surface as a changed total.
            if (changes.priceChanged.length || changes.oldTotal !== changes.newTotal) {
              setCatalogUpdateNotice(PRICES_UPDATED);
              setCartChanges((prior) => ({
                oldTotal: prior?.oldTotal ?? changes.oldTotal,
                newTotal: changes.newTotal,
              }));
            }
            return repriced.cart;
          });
        } else if (changed && modeRef.current === 'server') setCart([]);
        setConnection({
          status: 'online',
          checkedAt: new Date().toISOString(),
          message: null,
        });
      },
      onFailure: (_error, background) => {
        // A failed background re-read keeps the loaded menu; activation and retries still report.
        if (background) return;
        setConnection((previous) => ({
          ...previous,
          status: 'offline',
          message: 'Не удалось обновить меню. Проверьте интернет и повторите.',
        }));
      },
    });
    catalogRecovery.current = recovery;
    const unsubscribe = subscribeCatalogConnectivity(recovery);
    return () => {
      unsubscribe();
      recovery.stop();
      if (catalogRecovery.current === recovery) catalogRecovery.current = null;
    };
  }, [hydrated, requestedBranchId, refreshIndex]);

  // Media is version-bound but never delays authoritative prices and selections.
  useEffect(() => {
    if (!publication) return;
    const controller = new AbortController();
    const version = publication.version;
    void readCatalogMedia(version, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setMediaReadVersion(version);
      if (next) {
        setMedia(next);
        prefetchCatalogMedia(next);
      } else
        // A failed read keeps the interim photos of the previous publication, if any.
        setMedia((previous) => previous ?? { version, products: {} });
    });
    return () => controller.abort();
  }, [publication?.branch.id, publication?.version]);

  const availability = useAvailability(hydrated && catalogMode === 'server', refreshIndex);
  // A republish (price, photo, items) reaches the long-poll as a newer X-Catalog-Version. Reload
  // through the same recovery path, which shows 'Меню обновилось' and holds checkout until the
  // customer accepts the updated basket.
  const loadedCatalogVersion = publication?.version ?? null;
  useEffect(() => {
    const target = catalogRefreshTarget(
      catalogMode === 'server' ? availability.catalogVersion : null,
      loadedCatalogVersion,
      requestedCatalogVersion.current,
    );
    if (target === null) return;
    requestedCatalogVersion.current = target;
    catalogRecovery.current?.refresh();
  }, [availability.catalogVersion, loadedCatalogVersion, catalogMode]);
  const baseProducts = useMemo(
    () =>
      catalogMode === 'design'
        ? designProducts
        : publication
          ? publishedProducts(publication, locale, media)
          : connectedCatalog
            ? connectedProducts(connectedCatalog)
            : serverProducts(menu, locale),
    [catalogMode, menu, locale, connectedCatalog, publication, media],
  );
  const products = useMemo(
    () => withAvailability(baseProducts, catalogMode === 'server' ? availability.data : null),
    [baseProducts, availability, catalogMode],
  );
  const branch =
    branches.find((candidate) => candidate.id === requestedBranchId) ?? branches[0] ?? null;
  const releaseId =
    catalogMode === 'design'
      ? DESIGN_RELEASE
      : publication
        ? `published:${publication.branch.id}:${publication.version}`
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
      version: 2,
      catalogMode,
      diningMode,
      paymentMethod,
      locale,
      nickname,
      orderComment,
      branchId: branch?.id ?? requestedBranchId,
      releaseId:
        pendingCart?.releaseId ??
        (cartPublication.current && cart.length
          ? `published:${cartPublication.current.branch.id}:${cartPublication.current.version}`
          : publication
            ? publishedCartStorageRelease(cart, releaseId)
            : releaseId),
      ...(pendingCart?.publication
        ? { publication: pendingCart.publication }
        : cartPublication.current && cart.length
          ? { publication: cartPublication.current }
          : {}),
      lines:
        pendingCart?.lines ??
        cart.map((line) => ({
          id: line.product.id,
          key: cartLineKey(line),
          quantity: line.quantity,
          ...(line.issue === 'unavailable'
            ? { unavailable: { name: line.product.name, unitMinor: lineUnitPrice(line) } }
            : {}),
          ...(line.previousUnitPriceMinor
            ? { previousUnitPriceMinor: line.previousUnitPriceMinor }
            : {}),
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
    setPublication(null);
    setMedia(null);
    setMediaReadVersion(null);
    cartPublication.current = null;
    setCatalogUpdateNotice(null);
    setCartChanges(null);
    setConnectedCatalog(null);
    setPracticeScore(null);
    setRefreshIndex((previous) => previous + 1);
    setSelectedId(null);
    persistQueue.current = persistQueue.current
      .catch(() => {})
      .then(() => AsyncStorage.removeItem(STORAGE_KEY));
    void persistQueue.current.catch(() => {});
  };

  const catalogUpdatePending = cart.some((line) => Boolean(line.issue));
  const model: MobileModel = {
    catalogUpdateNotice,
    catalogUpdatePending,
    catalogPending:
      catalogMode === 'server' &&
      (publication
        ? mediaReadVersion !== publication.version
        : !menu && !connectedCatalog && connection.status === 'loading'),
    cartChanges: cartChanges ? { ...cartChanges, newTotal: cartTotal(cart) } : null,
    refreshCatalog: () => catalogRecovery.current?.refresh() ?? Promise.resolve(false),
    dismissCatalogUpdate: () => {
      setCatalogUpdateNotice(null);
      setCartChanges(null);
      setCart((previous) =>
        previous.map((line) => ({ ...line, previousUnitPriceMinor: undefined })),
      );
    },
    products,
    upsellProductIds:
      publication && catalogMode === 'server'
        ? publication.payload.upsell_product_ids
        : connectedCatalog && 'upsell_product_ids' in connectedCatalog
          ? connectedCatalog.upsell_product_ids
          : ['toast', 'sauce', 'cola'],
    cart: cart.map((line) => ({
      ...line,
      product: publication
        ? withAvailability([line.product], availability.data)[0]!
        : (products.find((p) => p.id === line.product.id) ?? line.product),
    })),
    ...catalogAvailability(availability, catalogMode === 'server'),
    catalogMode,
    diningMode,
    paymentMethod,
    locale,
    branches,
    branch,
    connection,
    selectedProduct:
      selectedId === null
        ? (products[0] ?? null)
        : (products.find((product) => product.id === selectedId) ?? null),
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
        if (next && !previous.length) cartPublication.current = publication;
        return next ?? previous;
      });
      return accepted;
    },
    addToCart: (id, selections, quantity = 1) => {
      const product = products.find((candidate) => candidate.id === id);
      if (!product || product.available === false) return;
      const chosen = selections ?? defaultSelections(product);
      restoration.current = null;
      setCart((previous) => {
        if (!previous.length) cartPublication.current = publication;
        return updateQuantity(
          previous,
          product,
          (previous.find(
            (line) =>
              line.product.id === product.id &&
              selectionKey(line.selections) === selectionKey(chosen),
          )?.quantity ?? 0) + quantity,
          chosen,
        );
      });
    },
    setQuantity: (id, quantity) => {
      restoration.current = null;
      setCart((previous) => {
        const line = previous.find((l) => cartLineKey(l) === id);
        if (line && quantity === 0) return previous.filter((candidate) => candidate !== line);
        if (line && Number.isInteger(quantity) && quantity > 0 && quantity <= 20)
          return previous.map((candidate) =>
            candidate === line ? { ...line, quantity } : candidate,
          );
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
