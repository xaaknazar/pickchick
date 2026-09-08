import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  errorText,
  money,
  paymentLabels,
  stateLabels,
  type StaffRole,
  type TestOrder,
} from './client';
import {
  Brand,
  Connection,
  Empty,
  Loading,
  Notice,
  TestBanner,
  commandKey,
  usePoll,
} from './shared';

const titles: Record<StaffRole, string> = {
  prep: 'A · Приготовление',
  assembly: 'B · Сборка и выдача',
  display: 'Табло выдачи',
  manager: 'Управляющий',
};
const paths: Record<StaffRole, string> = {
  prep: '/kitchen/prep',
  assembly: '/kitchen/assembly',
  display: '/display',
  manager: '/manager',
};

export function Staff({ role }: { role: StaffRole }) {
  const key = `pickchick.staff.${role}`;
  const [token, setToken] = useState(() => sessionStorage.getItem(key) ?? '');
  const [input, setInput] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (!/^[a-f0-9]{64}$/.test(input.trim()) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const value = input.trim();
      if (role === 'display') await api.display(value);
      else if (role === 'manager') await api.manager(value);
      else await api.kitchen(value);
      sessionStorage.setItem(key, value);
      setToken(value);
      setInput('');
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  function logout() {
    sessionStorage.removeItem(key);
    setToken('');
    setError(null);
  }
  if (!token)
    return (
      <div className={`staff-login ${role === 'manager' ? 'dark' : ''}`}>
        <TestBanner />
        <header>
          <Brand />
        </header>
        <main>
          <form onSubmit={(event) => void login(event)}>
            <span className="eyebrow">Доступ сотрудника</span>
            <h1>{titles[role]}</h1>
            <p>
              Введите временный ключ тестовой роли, выданный управляющим через служебную команду.
            </p>
            <label>
              Ключ доступа
              <input
                aria-label="Ключ доступа"
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={64}
                required
              />
            </label>
            {error ? <Notice warning>{errorText(error)}</Notice> : null}
            <button
              className="primary full"
              disabled={busy || !/^[a-f0-9]{64}$/.test(input.trim())}
            >
              {busy ? 'Проверяем права…' : 'Открыть рабочий экран'}
            </button>
            <p className="fine">
              Ключ хранится только в текущей вкладке. Публичной регистрации сотрудников нет.
            </p>
          </form>
        </main>
      </div>
    );
  if (role === 'display') return <DisplayScreen token={token} logout={logout} />;
  if (role === 'manager') return <Manager token={token} logout={logout} />;
  return <KitchenScreen token={token} station={role} logout={logout} />;
}

function StaffHeader({
  title,
  role,
  logout,
}: {
  title: string;
  role: StaffRole;
  logout: () => void;
}) {
  return (
    <header className="staff-header">
      <Brand />
      <h1>{title}</h1>
      <nav aria-label="Рабочие экраны">
        {(['prep', 'assembly', 'display', 'manager'] as const).map((item) => (
          <a key={item} href={paths[item]} aria-current={role === item ? 'page' : undefined}>
            {titles[item]}
          </a>
        ))}
      </nav>
      <button onClick={logout}>Выйти</button>
    </header>
  );
}
function Age({ since }: { since: string }) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60000));
  return <span className={`age ${minutes >= 10 ? 'late' : ''}`}>{minutes} мин</span>;
}
function channel(order: TestOrder) {
  return order.snapshot.channel === 'kiosk' ? 'Киоск' : 'Приложение';
}

function KitchenScreen({
  token,
  station,
  logout,
}: {
  token: string;
  station: 'prep' | 'assembly';
  logout: () => void;
}) {
  const load = useCallback(() => api.kitchen(token), [token]);
  const remote = usePoll(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const all = remote.data?.orders ?? [];
  const permitted = remote.data?.station === station || remote.data?.station === 'manager';
  const orders = all.filter(
    (order) =>
      filter === 'all' ||
      (station === 'assembly'
        ? true
        : order.tasks.some((task) => task.station === 'prep' && task.state === 'pending')),
  );
  async function complete(order: TestOrder, task: string | null) {
    if (busy || remote.error) return;
    setBusy(order.order_id);
    setError(null);
    try {
      const payload = { order: order.order_id, task, version: order.version };
      const key = commandKey(`${station}.${order.order_id}`, payload);
      if (task) await api.complete(token, order, task, key);
      else await api.handoff(token, order, key);
      await remote.refresh();
    } catch (cause) {
      setError(cause);
      void remote.refresh();
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="kitchen-shell">
      <TestBanner />
      <StaffHeader title={titles[station]} role={station} logout={logout} />
      <Connection observed={remote.observed} error={remote.error} refresh={remote.refresh} />
      <main className="kitchen-main">
        <div className="queue-controls">
          <div>
            <h2>{station === 'prep' ? 'Готовим горячее' : 'Собираем и выдаём'}</h2>
            <p>Порядок по времени поступления · В очереди: {orders.length}</p>
          </div>
          <div className="segments">
            <button
              className={filter === 'active' ? 'selected' : ''}
              onClick={() => setFilter('active')}
            >
              Активные
            </button>
            <button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>
              Вся очередь
            </button>
          </div>
        </div>
        {error ? (
          <Notice warning>
            {errorText(error)} Действие не отображается выполненным без ответа сервера.
          </Notice>
        ) : null}
        {remote.data && !permitted ? (
          <Notice warning>
            Этот ключ выдан для другой кухонной станции. Выйдите и используйте ключ нужной роли.
          </Notice>
        ) : !remote.data ? (
          <Loading />
        ) : orders.length ? (
          <div className="ticket-grid">
            {orders.map((order) => {
              const tasks = order.tasks.filter((task) => task.station === station);
              const waiting =
                station === 'assembly' &&
                order.tasks.some((task) => task.station === 'prep' && task.state !== 'done');
              return (
                <article
                  className={`ticket ${order.state}`}
                  key={order.order_id}
                  data-order-number={order.number}
                >
                  <header>
                    <div>
                      <strong>{order.number}</strong>
                      <span>
                        {channel(order)} ·{' '}
                        {order.snapshot.service_mode === 'dine_in' ? 'В зале' : 'С собой'}
                      </span>
                    </div>
                    <Age since={order.created_at} />
                  </header>
                  <div className="ticket-lines">
                    {order.snapshot.lines.map((line) => (
                      <div key={line.id}>
                        <strong>{line.quantity}×</strong>
                        <span>
                          {line.name}
                          <small>Стандартный состав</small>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="task-list">
                    {tasks.map((task) => (
                      <div className={task.state === 'done' ? 'done' : ''} key={task.task_id}>
                        <span>{task.state === 'done' ? '✓' : '○'}</span>
                        <strong>{task.title}</strong>
                        {task.state === 'pending' ? (
                          <button
                            disabled={Boolean(
                              busy || remote.error || waiting || order.state !== 'preparing',
                            )}
                            onClick={() => void complete(order, task.task_id)}
                          >
                            {busy === order.order_id
                              ? 'Сохраняем…'
                              : station === 'prep'
                                ? 'Готово'
                                : 'Заказ собран'}
                          </button>
                        ) : (
                          <small>Подтверждено</small>
                        )}
                      </div>
                    ))}
                  </div>
                  {waiting ? (
                    <p className="dependency">Ждём обязательные компоненты приготовления</p>
                  ) : null}
                  {order.state === 'ready' && station === 'assembly' ? (
                    <button
                      className="primary full"
                      disabled={Boolean(busy || remote.error)}
                      onClick={() => void complete(order, null)}
                    >
                      {busy === order.order_id ? 'Сохраняем…' : 'Выдать заказ'}
                    </button>
                  ) : (
                    <footer>
                      {station === 'prep' && tasks.every((task) => task.state === 'done')
                        ? 'Передано на сборку'
                        : stateLabels[order.state]}
                    </footer>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <Empty title="Очередь свободна">
            Подтверждённый тестовый заказ появится здесь автоматически.
          </Empty>
        )}
      </main>
    </div>
  );
}

function DisplayScreen({ token, logout }: { token: string; logout: () => void }) {
  const load = useCallback(() => api.display(token), [token]);
  const remote = usePoll(load);
  const [page, setPage] = useState(0);
  const pages = Math.max(
    1,
    Math.ceil(Math.max(remote.data?.preparing.length ?? 0, remote.data?.ready.length ?? 0) / 6),
  );
  const offset = (page % pages) * 6;
  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      if (!document.hidden) setPage((old) => (old + 1) % pages);
    }, 8000);
    return () => globalThis.clearInterval(timer);
  }, [pages]);
  return (
    <div className="display-shell">
      <TestBanner />
      <header className="display-header">
        <Brand />
        <h1>Твой хруст уже близко</h1>
        <button onClick={logout} aria-label="Выйти из тестового табло">
          Выход
        </button>
      </header>
      <Connection observed={remote.observed} error={remote.error} refresh={remote.refresh} />
      {!remote.data ? (
        <Loading />
      ) : (
        <main className="display-columns">
          <section>
            <h2>
              Готовится <span>Дайындалуда</span>
            </h2>
            <div className="display-numbers">
              {remote.data.preparing.slice(offset, offset + 6).map((item) => (
                <div key={item.number}>{item.number}</div>
              ))}
            </div>
            {!remote.data.preparing.length ? <p>Новые номера появятся здесь</p> : null}
          </section>
          <section className="ready">
            <h2>
              Готово <span>Дайын</span>
            </h2>
            <div className="display-numbers">
              {remote.data.ready.slice(offset, offset + 6).map((item) => (
                <div key={item.number}>{item.number}</div>
              ))}
            </div>
            {!remote.data.ready.length ? <p>Готовим для вас</p> : null}
          </section>
        </main>
      )}
      <footer>
        Назовите номер сотруднику · Заказ исчезнет после подтверждённой выдачи
        {pages > 1 ? ` · Страница ${(page % pages) + 1} из ${pages}` : ''}
      </footer>
    </div>
  );
}

const designLinks = [
  ['B05', 'Номенклатура'],
  ['B12', 'Остатки'],
  ['B18', 'Отчёты'],
  ['B20', 'Касса и бухгалтерия'],
  ['B23', 'Промо'],
  ['B25', 'Игры'],
  ['B28', 'Гости и push'],
  ['B35', 'Станции'],
  ['B36', 'Устройства'],
  ['B41', 'Сотрудники'],
  ['B42', 'Аудит'],
];
function Metric({ value, children }: { value: number; children: ReactNode }) {
  return (
    <article className="metric">
      <span>{children}</span>
      <strong>{value}</strong>
      <small>Сохранённые тестовые заказы</small>
    </article>
  );
}

function Manager({ token, logout }: { token: string; logout: () => void }) {
  const load = useCallback(() => api.manager(token), [token]);
  const remote = usePoll(load);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const all = remote.data?.orders ?? [];
  const orders = all.filter((order) =>
    `${order.number} ${channel(order)} ${stateLabels[order.state]}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const current = all.find((order) => order.order_id === selected);
  async function command(order: TestOrder, action: 'approved' | 'declined' | 'handoff' | 'cancel') {
    if (busy || remote.error) return;
    setBusy(true);
    setError(null);
    const key = commandKey(`manager.${order.order_id}`, {
      version: order.version,
      action,
      reason: action === 'cancel' ? reason.trim() : '',
    });
    try {
      if (action === 'handoff') await api.handoff(token, order, key);
      else if (action === 'cancel') await api.cancel(token, order, reason.trim(), key);
      else await api.resolve(token, order, action, key);
      await remote.refresh();
      setReason('');
    } catch (cause) {
      setError(cause);
      void remote.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="manager-shell">
      <TestBanner />
      <div className="manager-layout">
        <aside className="manager-sidebar">
          <Brand />
          <span className="eyebrow">Управление тестовой точкой</span>
          <a className="selected" href="/manager">
            Заказы и результаты
          </a>
          <a href="/kitchen/prep">A · Приготовление</a>
          <a href="/kitchen/assembly">B · Сборка и выдача</a>
          <a href="/display">Табло выдачи</a>
          <a href="/kiosk">Открыть киоск</a>
          <span className="eyebrow">Макеты будущих разделов</span>
          {designLinks.map(([id, name]) => (
            <a
              href={`/design/prototype/index.html#${id}`}
              key={id}
              target="_blank"
              rel="noreferrer"
            >
              {name}
              <small>Макет ↗</small>
            </a>
          ))}
          <button onClick={logout}>Выйти из роли</button>
        </aside>
        <main className="manager-main">
          <header>
            <div>
              <span className="eyebrow">TEST-ALMATY-01</span>
              <h1>Заказы и результаты</h1>
              <p>Серверный тестовый контур · Алматы</p>
            </div>
            <span className="test-label">Реальные продажи отключены</span>
          </header>
          <Connection observed={remote.observed} error={remote.error} refresh={remote.refresh} />
          <div className="metrics">
            <Metric value={all.length}>Всего в списке</Metric>
            <Metric value={all.filter((o) => o.state === 'preparing').length}>На кухне</Metric>
            <Metric value={all.filter((o) => o.state === 'ready').length}>Готовы к выдаче</Metric>
            <Metric value={all.filter((o) => o.payment_state === 'simulated_unknown').length}>
              Проверка оплаты
            </Metric>
          </div>
          <Notice>
            Суммы ниже относятся к симуляции. Продажи, реальные остатки, фискальные документы и
            банковская сверка ещё не подключены.
          </Notice>
          {error ? <Notice warning>{errorText(error)}</Notice> : null}
          <section className="manager-panel">
            <div className="panel-heading">
              <h2>Все каналы · сохранённые заказы</h2>
              <input
                aria-label="Найти заказ"
                placeholder="Номер, канал или статус…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {!remote.data ? (
              <Loading />
            ) : orders.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Заказ / канал</th>
                      <th>Состояние</th>
                      <th>Тестовая оплата</th>
                      <th>Сумма</th>
                      <th>Действие</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.order_id}>
                        <td>
                          <strong>{order.number}</strong>
                          <small>
                            {channel(order)} ·{' '}
                            {new Date(order.created_at).toLocaleTimeString('ru-RU', {
                              timeZone: 'Asia/Almaty',
                            })}
                          </small>
                        </td>
                        <td>
                          <span className={`order-pill ${order.state}`}>
                            {stateLabels[order.state]}
                          </span>
                        </td>
                        <td>{paymentLabels[order.payment_state]}</td>
                        <td>{money(order.snapshot.total_minor)}</td>
                        <td>
                          <button
                            onClick={() => {
                              setSelected(order.order_id);
                              setReason('');
                              setError(null);
                            }}
                          >
                            Открыть
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Заказов пока нет">
                Создайте тестовый заказ в приложении или на киоске.
              </Empty>
            )}
          </section>
          {current ? (
            <section className="manager-panel order-details">
              <div className="panel-heading">
                <h2>
                  {current.number} · версия {current.version}
                </h2>
                <button onClick={() => setSelected(null)}>Закрыть</button>
              </div>
              <p>
                {stateLabels[current.state]} · {paymentLabels[current.payment_state]}
              </p>
              <section className="summary-lines">
                {current.snapshot.lines.map((line) => (
                  <div key={line.id}>
                    <span>
                      {line.name} × {line.quantity}
                    </span>
                    <strong>{money(line.line_total_minor)}</strong>
                  </div>
                ))}
              </section>
              <h3>Кухонные задания</h3>
              <ul>
                {current.tasks.length ? (
                  current.tasks.map((task) => (
                    <li key={task.task_id}>
                      {task.station === 'prep' ? 'A' : 'B'} · {task.title} -{' '}
                      {task.state === 'done' ? 'готово' : 'ожидает'}
                    </li>
                  ))
                ) : (
                  <li>Не созданы до подтверждения тестовой оплаты</li>
                )}
              </ul>
              {current.payment_state === 'simulated_unknown' ? (
                <>
                  <Notice warning>
                    Разрешите результат только в симуляторе. Эта операция не связана с Kaspi.
                  </Notice>
                  <div className="action-row">
                    <button
                      className="primary"
                      disabled={busy || Boolean(remote.error)}
                      onClick={() => void command(current, 'approved')}
                    >
                      Тест: подтвердить
                    </button>
                    <button
                      disabled={busy || Boolean(remote.error)}
                      onClick={() => void command(current, 'declined')}
                    >
                      Тест: отклонить
                    </button>
                  </div>
                </>
              ) : null}
              {current.state === 'ready' ? (
                <button
                  className="primary"
                  disabled={busy || Boolean(remote.error)}
                  onClick={() => void command(current, 'handoff')}
                >
                  Подтвердить выдачу
                </button>
              ) : null}
              {!['fulfilled', 'cancelled'].includes(current.state) &&
              current.payment_state !== 'simulated_unknown' ? (
                <div className="cancel-order">
                  <label>
                    Причина отмены тестового заказа
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      minLength={3}
                      maxLength={300}
                    />
                  </label>
                  <button
                    disabled={busy || reason.trim().length < 3 || Boolean(remote.error)}
                    onClick={() => void command(current, 'cancel')}
                  >
                    Отменить с причиной
                  </button>
                </div>
              ) : null}
              {current.cancellation_reason ? (
                <p>Причина отмены: {current.cancellation_reason}</p>
              ) : null}
              <p className="fine">ККМ: не применяется · Состояния и версии проверяются сервером</p>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}
