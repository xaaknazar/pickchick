import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TestOrderSchema, TestQuoteSchema } from '@pickchick/test-order-flow/contracts';
import {
  api,
  ApiError,
  errorText,
  money,
  paymentLabels,
  readSession,
  stateLabels,
  type Product,
  type ServiceMode,
  type Session,
  type TestOrder,
  type TestQuote,
} from './client';
import { assets, productImage } from './assets';
import {
  Brand,
  Connection,
  Empty,
  Loading,
  Notice,
  TestBanner,
  readJson,
  saveJson,
  usePoll,
} from './shared';

type Screen = 'welcome' | 'mode' | 'menu' | 'product' | 'cart' | 'loyalty' | 'quote' | 'order';
type Pending =
  | { kind: 'create'; key: string; quote: TestQuote }
  | { kind: 'payment'; key: string; order: TestOrder; outcome: 'approved' | 'declined' | 'unknown' }
  | { kind: 'cancel'; key: string; order: TestOrder };
interface Draft {
  screen: Screen;
  counts: Record<string, number>;
  mode: ServiceMode;
  selected: string | null;
  quote: TestQuote | null;
  quoteKey: string | null;
  createKey: string | null;
  orderId: string | null;
  pending: Pending | null;
}
const blank = (): Draft => ({
  screen: 'welcome',
  counts: {},
  mode: 'takeaway',
  selected: null,
  quote: null,
  quoteKey: null,
  createKey: null,
  orderId: null,
  pending: null,
});
const DRAFT_KEY = 'pickchick.kiosk.draft';
function restore(): Draft {
  const raw = readJson(DRAFT_KEY) as Partial<Draft> | null;
  if (!raw || !raw.counts || typeof raw.counts !== 'object') return blank();
  const base = blank();
  const screens: Screen[] = [
    'welcome',
    'mode',
    'menu',
    'product',
    'cart',
    'loyalty',
    'quote',
    'order',
  ];
  base.screen = screens.includes(raw.screen as Screen) ? (raw.screen as Screen) : 'welcome';
  base.counts = Object.fromEntries(
    Object.entries(raw.counts).filter(
      ([id, n]) => /^[a-z0-9-]{1,40}$/.test(id) && Number.isInteger(n) && n >= 1 && n <= 20,
    ),
  );
  base.mode = raw.mode === 'dine_in' ? 'dine_in' : 'takeaway';
  base.selected = typeof raw.selected === 'string' ? raw.selected : null;
  base.quote = TestQuoteSchema.safeParse(raw.quote).data ?? null;
  base.quoteKey = typeof raw.quoteKey === 'string' ? raw.quoteKey : null;
  base.createKey = typeof raw.createKey === 'string' ? raw.createKey : null;
  base.orderId = typeof raw.orderId === 'string' ? raw.orderId : null;
  const pending = raw.pending;
  if (pending && typeof pending.key === 'string') {
    if (pending.kind === 'create' && TestQuoteSchema.safeParse(pending.quote).success)
      base.pending = pending;
    if (
      (pending.kind === 'payment' || pending.kind === 'cancel') &&
      TestOrderSchema.safeParse(pending.order).success
    )
      base.pending = pending;
  }
  if (base.orderId || base.pending) base.screen = 'order';
  else if (base.screen === 'order' || (base.screen === 'quote' && !base.quote))
    base.screen = 'cart';
  return base;
}

export function Kiosk() {
  const [draft, setDraft] = useState(restore);
  const draftRef = useRef(draft);
  const [session, setSession] = useState<Session | null>(readSession);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [sessionBlocked, setSessionBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ack, setAck] = useState<TestOrder | null>(null);
  const [category, setCategory] = useState('Все');
  const [quantity, setQuantity] = useState(1);
  const [idle, setIdle] = useState(false);
  const [idleLeft, setIdleLeft] = useState(15);
  const [help, setHelp] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const activity = useRef(Date.now());
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      const element = video.current;
      if (!element) return;
      const play = !reduced.matches && !document.hidden;
      element.autoplay = play;
      if (play) void element.play().catch(() => {});
      else element.pause();
    };
    sync();
    reduced.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      reduced.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [draft.screen]);

  const catalogLoad = useCallback(() => api.catalog(), []);
  const catalog = usePoll(catalogLoad);
  const orderLoad = useCallback(
    () => api.order(session?.token ?? '', draft.orderId ?? ''),
    [session?.token, draft.orderId],
  );
  const remote = usePoll(orderLoad, Boolean(session && draft.orderId));
  const order = remote.data && (!ack || remote.data.version >= ack.version) ? remote.data : ack;
  const accessExpired = Boolean(
    session && (sessionExpired || Date.parse(session.expires_at) <= Date.now()),
  );
  const protectedOrder = Boolean(
    draft.pending ||
    (draft.orderId &&
      (!order ||
        (!['fulfilled', 'cancelled'].includes(order.state) &&
          order.payment_state !== 'simulated_approved'))),
  );
  const products = catalog.data?.products ?? [];
  const selected = products.find((p) => p.id === draft.selected);
  const lines = products.filter((p) => (draft.counts[p.id] ?? 0) > 0);
  const missingIds = catalog.data
    ? Object.keys(draft.counts).filter((id) => !products.some((p) => p.id === id))
    : [];
  const count = Object.values(draft.counts).reduce((n, q) => n + q, 0);
  const estimate = lines
    .reduce((n, p) => n + BigInt(p.price_minor) * BigInt(draft.counts[p.id] ?? 0), 0n)
    .toString();

  const update = useCallback((changes: Partial<Draft>) => {
    const next = { ...draftRef.current, ...changes };
    // Persist the exact command before fetch; React state updates may be batched.
    saveJson(DRAFT_KEY, next);
    draftRef.current = next;
    setDraft(next);
  }, []);
  const reset = useCallback(() => {
    sessionStorage.removeItem('pickchick.kiosk.session');
    sessionStorage.removeItem(DRAFT_KEY);
    const next = blank();
    draftRef.current = next;
    setDraft(next);
    setSession(null);
    setSessionExpired(false);
    setSessionBlocked(false);
    setAck(null);
    setError(null);
    setHelp(false);
    setCategory('Все');
    setIdle(false);
    activity.current = Date.now();
  }, []);

  useEffect(() => {
    if ([error, remote.error].some((cause) => cause instanceof ApiError && cause.status === 401))
      setSessionExpired(true);
  }, [error, remote.error]);

  async function continueSession() {
    if (!session || busy) return;
    setBusy(true);
    setError(null);
    setSessionBlocked(false);
    try {
      const next = await api.continueSession(session.token);
      if (next.session_id !== session.session_id || next.channel !== 'kiosk')
        throw new ApiError(502, 'INVALID_RESPONSE');
      saveJson('pickchick.kiosk.session', next);
      setSession(next);
      setSessionExpired(false);
      void remote.refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setSessionBlocked(true);
      else setError(cause);
    } finally {
      setBusy(false);
    }
  }

  // Recover an active server order if the local route was lost; no fabricated queue.
  useEffect(() => {
    if (!session || draft.orderId || draft.pending) return;
    let live = true;
    api
      .orders(session.token)
      .then((result) => {
        if (!live) return;
        const active = result.orders.find(
          (item) => !['fulfilled', 'cancelled'].includes(item.state),
        );
        if (active) {
          setAck(active);
          update({ orderId: active.order_id, screen: 'order' });
        }
      })
      .catch((cause: unknown) => {
        if (live) setError(cause);
      });
    return () => {
      live = false;
    };
  }, [session, draft.orderId, draft.pending, update]);

  useEffect(() => {
    const record = () => {
      if (!idle) activity.current = Date.now();
    };
    document.addEventListener('pointerdown', record);
    document.addEventListener('keydown', record);
    const timer = globalThis.setInterval(() => {
      if (draft.screen === 'welcome' || protectedOrder || busy) return;
      const elapsed = Math.floor((Date.now() - activity.current) / 1000);
      if (elapsed >= 90) {
        setIdle(true);
        setIdleLeft(Math.max(0, 105 - elapsed));
      }
      if (elapsed >= 105) reset();
    }, 1000);
    return () => {
      globalThis.clearInterval(timer);
      document.removeEventListener('pointerdown', record);
      document.removeEventListener('keydown', record);
    };
  }, [draft.screen, protectedOrder, busy, idle, reset]);

  async function start() {
    if (busy) return;
    if (session) {
      update({ screen: draft.orderId ? 'order' : 'mode' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.session();
      saveJson('pickchick.kiosk.session', next);
      setSession(next);
      update({ screen: 'mode' });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  function changeCount(id: string, delta: number) {
    const next = Math.min(20, Math.max(0, (draft.counts[id] ?? 0) + delta));
    const counts = { ...draft.counts };
    if (next) counts[id] = next;
    else delete counts[id];
    update({ counts, quote: null, quoteKey: null, createKey: null });
  }
  function openProduct(product: Product) {
    setQuantity(1);
    update({ selected: product.id, screen: 'product' });
  }
  async function calculate() {
    if (!session || accessExpired || !catalog.data || !count || missingIds.length || busy) return;
    setBusy(true);
    setError(null);
    const key = draft.quoteKey ?? crypto.randomUUID();
    update({ quoteKey: key });
    try {
      const quote = await api.quote(
        session.token,
        {
          catalog_version: catalog.data.catalog_version,
          service_mode: draft.mode,
          items: Object.entries(draft.counts).map(([product_id, q]) => ({
            product_id,
            quantity: q,
          })),
        },
        key,
      );
      update({ quote, createKey: crypto.randomUUID(), screen: 'quote' });
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiError && cause.status < 500) update({ quoteKey: null });
    } finally {
      setBusy(false);
    }
  }
  async function execute(command: Pending) {
    if (!session || accessExpired || busy) return;
    setBusy(true);
    setError(null);
    try {
      update({ pending: command, screen: 'order' });
      const result =
        command.kind === 'create'
          ? await api.create(session.token, command.quote.quote_id, command.key)
          : command.kind === 'payment'
            ? await api.payment(session.token, command.order, command.outcome, command.key)
            : await api.cancel(
                session.token,
                command.order,
                'Гость отменил тестовый заказ',
                command.key,
              );
      setAck(result);
      update({ pending: null, orderId: result.order_id, screen: 'order' });
      void remote.refresh();
    } catch (cause) {
      setError(cause);
      // Keep the exact command across expired credentials and ambiguous transport failures.
      if (cause instanceof ApiError && [400, 403, 404, 409, 422].includes(cause.status)) {
        update({
          pending: null,
          ...(command.kind === 'create'
            ? { screen: 'cart' as const, quote: null, quoteKey: null, createKey: null }
            : {}),
        });
        void remote.refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  function pay(outcome: 'approved' | 'declined' | 'unknown') {
    if (order) void execute({ kind: 'payment', key: crypto.randomUUID(), order, outcome });
  }
  function resume() {
    activity.current = Date.now();
    setIdle(false);
  }
  useEffect(() => {
    if (!idle && !help) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.modal button:not(:disabled)'),
      );
      const first = buttons[0],
        last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [idle, help]);

  const routeBack: Partial<Record<Screen, Screen>> = {
    mode: 'welcome',
    menu: 'mode',
    product: 'menu',
    cart: 'menu',
    loyalty: 'cart',
    quote: 'cart',
  };
  const title = {
    welcome: '',
    mode: 'Где будете есть?',
    menu: 'Выбери свой вкус',
    product: selected?.name ?? 'Блюдо',
    cart: 'Ваш заказ',
    loyalty: 'Чики за заказ',
    quote: 'Проверим заказ',
    order: 'Статус заказа',
  }[draft.screen];
  const caption = draft.mode === 'dine_in' ? 'В зале' : 'С собой';

  return (
    <div className={`kiosk-shell screen-${draft.screen}`}>
      <TestBanner />
      {accessExpired ? (
        <section className="notice warning session-recovery" role="alert">
          <h2>Срок тестового сеанса истёк</h2>
          <p>
            {sessionBlocked
              ? 'Сервер не разрешил продление: управляющий должен завершить или отменить прежний тестовый заказ и разрешить неизвестную оплату. Затем повторите продление.'
              : 'Корзина, заказ и незавершённый запрос сохранены. Продлите доступ к прежнему сеансу, чтобы проверить результат.'}
          </p>
          <button className="primary" disabled={busy} onClick={() => void continueSession()}>
            {busy ? 'Проверяем доступ…' : 'Продлить тестовый сеанс'}
          </button>
          <button className="secondary" onClick={() => setHelp(true)}>
            Нужна помощь с доступом
          </button>
        </section>
      ) : null}
      {draft.screen === 'welcome' ? (
        <main className="attract" style={{ backgroundImage: `url(${assets.poster})` }}>
          <video
            ref={video}
            src={assets.hero}
            poster={assets.poster}
            autoPlay
            muted
            loop
            playsInline
            aria-hidden="true"
          />
          <div className="attract-shade" />
          <header>
            <Brand />
          </header>
          <div className="attract-copy">
            <h1>
              PICK YOUR
              <br />
              PEAK
            </h1>
            <p>Твой вкус. Твой момент.</p>
            {error ? <Notice warning>{errorText(error)}</Notice> : null}
            <button className="primary start" onClick={() => void start()} disabled={busy}>
              {busy ? 'Подключаемся…' : 'НАЧАТЬ →'}
            </button>
            <span>Коснись экрана и сделай свой выбор</span>
            <small>Язык: русский · перевод на қазақша готовится</small>
          </div>
        </main>
      ) : (
        <>
          <header
            className="kiosk-header"
            style={{
              backgroundImage: `linear-gradient(#063b99cc, #063b99cc), url(${assets.bluePattern})`,
            }}
          >
            {routeBack[draft.screen] && !protectedOrder && !busy ? (
              <button
                className="back"
                aria-label="Назад"
                onClick={() => {
                  const screen = routeBack[draft.screen] ?? 'menu';
                  if (screen === 'welcome') reset();
                  else update({ screen });
                }}
              >
                ←
              </button>
            ) : null}
            <Brand />
            <span className="mode-label">{caption}</span>
            {!protectedOrder && !busy ? (
              <button
                className="cancel"
                onClick={() => {
                  setIdle(true);
                  activity.current = Date.now() - 90000;
                }}
              >
                Завершить
              </button>
            ) : null}
          </header>
          {draft.screen !== 'order' ? (
            <Connection
              observed={catalog.observed}
              error={catalog.error}
              refresh={catalog.refresh}
            />
          ) : null}
          {error && !draft.pending ? <Notice warning>{errorText(error)}</Notice> : null}
          {draft.screen === 'mode' ? (
            <main className="mode-screen">
              <h1>{title}</h1>
              <div className="mode-options">
                <button
                  onClick={() =>
                    update({
                      mode: 'dine_in',
                      screen: 'menu',
                      quote: null,
                      quoteKey: null,
                      createKey: null,
                    })
                  }
                >
                  <span>⌂</span>
                  <strong>В ЗАЛЕ</strong>
                  <small>Насладись моментом здесь</small>
                </button>
                <button
                  onClick={() =>
                    update({
                      mode: 'takeaway',
                      screen: 'menu',
                      quote: null,
                      quoteKey: null,
                      createKey: null,
                    })
                  }
                >
                  <span>↗</span>
                  <strong>С СОБОЙ</strong>
                  <small>Забери любимое с собой</small>
                </button>
              </div>
            </main>
          ) : null}
          {draft.screen === 'menu' ? (
            <>
              <nav className="category-nav" aria-label="Категории меню">
                {['Все', ...new Set(products.map((p) => p.category))].map((name) => (
                  <button
                    key={name}
                    className={category === name ? 'selected' : ''}
                    aria-pressed={category === name}
                    onClick={() => setCategory(name)}
                  >
                    {name}
                  </button>
                ))}
              </nav>
              <main className="menu-scroll">
                {!catalog.data && catalog.error ? (
                  <Empty title="Меню не загрузилось">
                    Проверьте связь и нажмите «Повторить» выше.
                  </Empty>
                ) : !catalog.data ? (
                  <Loading />
                ) : !products.some((p) => category === 'Все' || p.category === category) ? (
                  <Empty title="В меню пока нет блюд">
                    Выберите другую категорию или обновите каталог.
                  </Empty>
                ) : (
                  <>
                    {products[0] ? (
                      <button className="promo" onClick={() => openProduct(products[0]!)}>
                        <span>
                          <small>ВЫБОР PICK CHICK</small>
                          <strong>PICK COMBO</strong>
                          <span>
                            Хрустящий повод
                            <br />
                            заглянуть к нам.
                          </span>
                        </span>
                        <img src={assets.combo} alt="" />
                        <b>{money(products[0].price_minor)} →</b>
                      </button>
                    ) : null}
                    <div className="product-grid">
                      {products
                        .filter((p) => category === 'Все' || p.category === category)
                        .map((p) => (
                          <button className="product" key={p.id} onClick={() => openProduct(p)}>
                            <img src={productImage(p.image_id)} alt={p.name} />
                            <span className="product-copy">
                              <strong>{p.name}</strong>
                              <span>{p.category}</span>
                              <span className="price">
                                {money(p.price_minor)}
                                <b>+</b>
                              </span>
                            </span>
                          </button>
                        ))}
                    </div>
                  </>
                )}
              </main>
              <footer className="cart-bar">
                <div>
                  <span>В корзине: {count}</span>
                  <strong>{money(estimate)}</strong>
                </div>
                <button
                  className="primary"
                  disabled={!count}
                  onClick={() => update({ screen: 'cart' })}
                >
                  Оформить заказ →
                </button>
              </footer>
            </>
          ) : null}
          {draft.screen === 'product' ? (
            selected ? (
              <main className="product-detail">
                <img
                  className="detail-photo"
                  src={productImage(selected.image_id)}
                  alt={selected.name}
                />
                <div className="detail-gradient" />
                <div className="detail-heading">
                  <h1>{selected.name}</h1>
                  <p>{selected.category}</p>
                </div>
                <div className="detail-body">
                  <h2>Состав по каталогу</h2>
                  <p>{selected.description}</p>
                  <Notice>
                    В этом тесте доступен стандартный состав. Модификаторы и пошаговый конструктор
                    комбо пока не подключены к серверному расчёту.
                  </Notice>
                  <p>Аллергены и пищевая ценность появятся после утверждения карточки блюда.</p>
                </div>
                <footer className="detail-footer">
                  <div className="stepper">
                    <button
                      aria-label="Уменьшить количество"
                      disabled={quantity <= 1}
                      onClick={() => setQuantity((n) => Math.max(1, n - 1))}
                    >
                      −
                    </button>
                    <strong>{quantity}</strong>
                    <button
                      aria-label="Увеличить количество"
                      disabled={quantity >= 20}
                      onClick={() => setQuantity((n) => Math.min(20, n + 1))}
                    >
                      +
                    </button>
                  </div>
                  <button
                    className="primary"
                    onClick={() => {
                      changeCount(selected.id, quantity);
                      update({ screen: 'menu' });
                    }}
                  >
                    Добавить · {money((BigInt(selected.price_minor) * BigInt(quantity)).toString())}
                  </button>
                </footer>
              </main>
            ) : !catalog.data && !catalog.error ? (
              <Loading />
            ) : (
              <Empty title="Блюдо недоступно">Вернитесь в меню и обновите каталог.</Empty>
            )
          ) : null}
          {draft.screen === 'cart' ? (
            <KioskStep
              actions={
                <>
                  <button className="secondary full" onClick={() => update({ screen: 'menu' })}>
                    Добавить ещё
                  </button>
                  {catalog.data && lines.length ? (
                    <button
                      className="primary full"
                      disabled={Boolean(missingIds.length)}
                      onClick={() => update({ screen: 'loyalty' })}
                    >
                      Продолжить →
                    </button>
                  ) : null}
                </>
              }
            >
              <h1>{title}</h1>
              {missingIds.length ? (
                <section className="cart-items" aria-label="Недоступные блюда">
                  <Notice warning>
                    Некоторые блюда исчезли из каталога. Удалите их перед расчётом.
                  </Notice>
                  {missingIds.map((id) => (
                    <article key={id}>
                      <div>
                        <h2>Недоступное блюдо · {id}</h2>
                        <span>Количество: {draft.counts[id]}</span>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => changeCount(id, -(draft.counts[id] ?? 0))}
                      >
                        Удалить недоступное блюдо
                      </button>
                    </article>
                  ))}
                </section>
              ) : null}
              {!catalog.data ? (
                catalog.error ? (
                  <Empty title="Не удалось проверить корзину">
                    Состав сохранён. Повторите загрузку каталога.
                  </Empty>
                ) : (
                  <Loading />
                )
              ) : lines.length ? (
                <>
                  <section className="cart-items">
                    {lines.map((p) => (
                      <article key={p.id}>
                        <img src={productImage(p.image_id)} alt={p.name} />
                        <div>
                          <h2>{p.name}</h2>
                          <span>Стандартный состав</span>
                          <div className="stepper">
                            <button
                              aria-label={`Уменьшить ${p.name}`}
                              onClick={() => changeCount(p.id, -1)}
                            >
                              −
                            </button>
                            <strong>{draft.counts[p.id]}</strong>
                            <button
                              aria-label={`Увеличить ${p.name}`}
                              disabled={(draft.counts[p.id] ?? 0) >= 20}
                              onClick={() => changeCount(p.id, 1)}
                            >
                              +
                            </button>
                          </div>
                        </div>
                        <strong>
                          {money(
                            (BigInt(p.price_minor) * BigInt(draft.counts[p.id] ?? 0)).toString(),
                          )}
                        </strong>
                      </article>
                    ))}
                  </section>
                  <div className="summary">
                    <span>{caption}</span>
                    <strong>Предварительно {money(estimate)}</strong>
                  </div>
                  <Notice>
                    Точную сумму и доступность проверит сервер. Промокоды и Чики в этом тесте не
                    применяются.
                  </Notice>
                </>
              ) : !missingIds.length ? (
                <Empty title="Корзина пока пуста">Выберите блюда в меню.</Empty>
              ) : null}
            </KioskStep>
          ) : null}
          {draft.screen === 'loyalty' ? (
            <KioskStep
              actions={
                <button
                  className="primary full"
                  disabled={
                    busy ||
                    accessExpired ||
                    !catalog.data ||
                    !count ||
                    Boolean(catalog.error) ||
                    Boolean(missingIds.length)
                  }
                  onClick={() => void calculate()}
                >
                  {busy ? 'Считаем на сервере…' : 'Рассчитать тестовый заказ'}
                </button>
              }
            >
              <h1>Продолжим без регистрации</h1>
              <div className="loyalty-card">
                <span>✦</span>
                <h2>Чики скоро появятся здесь</h2>
                <p>
                  Телефон, QR и SMS пока не подключены. Для этого тестового заказа контактные данные
                  не нужны.
                </p>
              </div>
              <Notice>Денежных списаний и бонусных начислений в тестовом контуре нет.</Notice>
              {missingIds.length ? (
                <Notice warning>
                  Состав изменился. Вернитесь в корзину и удалите недоступные блюда.
                </Notice>
              ) : null}
            </KioskStep>
          ) : null}
          {draft.screen === 'quote' && draft.quote ? (
            <KioskStep
              actions={
                <button
                  className="primary full"
                  disabled={busy || accessExpired}
                  onClick={() =>
                    void execute({
                      kind: 'create',
                      quote: draft.quote!,
                      key: draft.createKey ?? crypto.randomUUID(),
                    })
                  }
                >
                  Создать тестовый заказ →
                </button>
              }
            >
              <h1>{title}</h1>
              <p className="eyebrow">Расчёт подтверждён сервером</p>
              <section className="summary-lines">
                {draft.quote.lines.map((line) => (
                  <div key={line.id}>
                    <span>
                      {line.name} × {line.quantity}
                    </span>
                    <strong>{money(line.line_total_minor)}</strong>
                  </div>
                ))}
              </section>
              <div className="summary">
                <span>{caption}</span>
                <strong>Итого {money(draft.quote.total_minor)}</strong>
              </div>
              <Notice>
                Сейчас создадим тестовый заказ. На следующем экране можно выбрать результат
                симулятора оплаты; Kaspi не вызывается.
              </Notice>
            </KioskStep>
          ) : null}
          {draft.screen === 'order' ? (
            <main className="kiosk-body order-screen">
              <Connection
                observed={remote.observed}
                error={remote.error}
                refresh={remote.refresh}
              />
              {draft.pending ? (
                <>
                  <h1>Проверяем результат операции</h1>
                  <Notice warning>
                    {accessExpired
                      ? 'Незавершённый запрос сохранён. Продлите прежний сеанс выше, затем повторите этот запрос.'
                      : busy
                        ? 'Ожидаем ответ сервера…'
                        : 'Ответ не получен. Новый заказ и новая попытка заблокированы. Повторим тот же запрос с прежним идентификатором.'}
                  </Notice>
                  {error ? <p>{errorText(error)}</p> : null}
                  <button
                    className="primary full"
                    disabled={busy || accessExpired}
                    onClick={() => draft.pending && void execute(draft.pending)}
                  >
                    {busy ? 'Проверяем…' : 'Повторить прежний запрос'}
                  </button>
                </>
              ) : order ? (
                <>
                  <span className={`order-pill ${order.state}`}>{stateLabels[order.state]}</span>
                  <h1>
                    {order.payment_state === 'simulated_unknown'
                      ? 'Проверяем тестовую оплату'
                      : order.state === 'ready'
                        ? 'Всё готово!'
                        : order.state === 'preparing'
                          ? 'Ваш заказ на кухне'
                          : order.state === 'fulfilled'
                            ? 'Заказ выдан'
                            : order.state === 'cancelled'
                              ? 'Заказ отменён'
                              : 'Тестовая оплата'}
                  </h1>
                  <div className="order-number">{order.number}</div>
                  <p>{paymentLabels[order.payment_state]}</p>
                  {order.state === 'awaiting_test_payment' &&
                  order.payment_state !== 'simulated_unknown' ? (
                    <>
                      <Notice>
                        Это симулятор. Выбранный результат сохранится на сервере; реальный банк и
                        ККМ не вызываются.
                      </Notice>
                      <button
                        className="primary full"
                        disabled={busy || accessExpired || Boolean(remote.error)}
                        onClick={() => pay('approved')}
                      >
                        Тест: подтвердить оплату
                      </button>
                      <div className="simulation-options">
                        <button
                          disabled={busy || accessExpired || Boolean(remote.error)}
                          onClick={() => pay('declined')}
                        >
                          Тест: отказ
                        </button>
                        <button
                          disabled={busy || accessExpired || Boolean(remote.error)}
                          onClick={() => pay('unknown')}
                        >
                          Тест: неизвестный результат
                        </button>
                      </div>
                      <button
                        className="secondary full"
                        disabled={busy || accessExpired}
                        onClick={() =>
                          void execute({ kind: 'cancel', key: crypto.randomUUID(), order })
                        }
                      >
                        Отменить тестовый заказ
                      </button>
                    </>
                  ) : null}
                  {order.payment_state === 'simulated_unknown' ? (
                    <>
                      <Notice warning>
                        Повторная оплата заблокирована. Управляющий должен разрешить этот тестовый
                        результат; экран продолжает получать сохранённый статус.
                      </Notice>
                      <button className="primary full" onClick={() => void remote.refresh()}>
                        Проверить состояние
                      </button>
                      <button className="secondary full" onClick={() => setHelp(true)}>
                        Нужна помощь
                      </button>
                    </>
                  ) : null}
                  {order.state === 'preparing' ? (
                    <Notice>
                      Задания сохранены для кухни. После приготовления и сборки этот номер появится
                      в разделе «Готово» на табло.
                    </Notice>
                  ) : null}
                  {order.state === 'ready' ? (
                    <Notice>Назовите номер сотруднику. Выдачу подтверждает сотрудник кухни.</Notice>
                  ) : null}
                  {['preparing', 'ready'].includes(order.state) &&
                  order.payment_state === 'simulated_approved' ? (
                    <>
                      <p className="fine">
                        Запомните номер: {order.number}. Заказ останется на кухне после завершения
                        этого экрана.
                      </p>
                      <button className="primary full" onClick={reset}>
                        Следующий гость
                      </button>
                    </>
                  ) : null}
                  {['fulfilled', 'cancelled'].includes(order.state) ? (
                    <button className="primary full" onClick={reset}>
                      Завершить и начать новый заказ
                    </button>
                  ) : null}
                  <section className="summary-lines">
                    {order.snapshot.lines.map((line) => (
                      <div key={line.id}>
                        <span>
                          {line.name} × {line.quantity}
                        </span>
                        <strong>{money(line.line_total_minor)}</strong>
                      </div>
                    ))}
                  </section>
                  <p className="fine">
                    Чек: не применяется к тестовой операции · Чики не начисляются
                  </p>
                </>
              ) : remote.error ? (
                <Empty title="Не удалось восстановить заказ">
                  {accessExpired
                    ? 'Продлите прежний сеанс выше. Ссылка на заказ сохранена.'
                    : 'Ссылка на заказ сохранена. Проверьте связь и нажмите «Повторить» выше.'}
                </Empty>
              ) : (
                <Loading>Восстанавливаем сохранённый заказ…</Loading>
              )}
            </main>
          ) : null}
        </>
      )}
      {idle ? (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="idle-title">
            <h2 id="idle-title">Продолжим заказ?</h2>
            <p>
              {protectedOrder
                ? 'Активный заказ сохраняется. Его нельзя скрыть до окончательного результата.'
                : `Через ${idleLeft} с очистим эту корзину для следующего гостя.`}
            </p>
            <button className="primary full" autoFocus onClick={resume}>
              Да, я здесь
            </button>
            {!protectedOrder ? (
              <button className="secondary full" onClick={reset}>
                Завершить сеанс
              </button>
            ) : null}
          </section>
        </div>
      ) : null}
      {help ? (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
            <h2 id="help-title">Обратитесь к управляющему</h2>
            <p>
              {accessExpired
                ? `Срок доступа истёк. Попросите управляющего найти прежний TEST-заказ${order?.number ? ` ${order.number}` : ''}, проверить неизвестный платёж и завершить выдачу или отмену. Затем вернитесь сюда и продлите прежний сеанс. Корзина и незавершённый запрос сохраняются.`
                : `Номер ${order?.number}. Повторную оплату не запускайте. Управляющий может разрешить неизвестный результат в тестовом контуре.`}
            </p>
            <button className="primary full" autoFocus onClick={() => setHelp(false)}>
              Вернуться к проверке
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function KioskStep({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <section className="kiosk-step">
      <main className="kiosk-body">{children}</main>
      <footer className="kiosk-actions">{actions}</footer>
    </section>
  );
}
