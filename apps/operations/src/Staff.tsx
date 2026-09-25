import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  ApiError,
  errorText,
  money,
  paymentLabels,
  stateLabels,
  type StaffRole,
  type TestOrder,
} from './client';
import { Brand, Connection, Empty, Loading, Notice, commandKey, usePoll } from './shared';
import { DisplayScreen } from './DisplayScreen';
import locations from '../../../config/restaurant-locations.json';
import { TEST_BRANCH_ID } from '@pickchick/test-order-flow/contracts';

const location = locations.locations.find((item) => item.branch_id === TEST_BRANCH_ID);

const titles: Record<StaffRole, string> = {
  prep: 'A · Приготовление',
  assembly: 'B · Сборка и выдача',
  display: 'Табло выдачи',
  manager: 'Управляющий',
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
        <header>
          <Brand />
        </header>
        <main>
          <form onSubmit={(event) => void login(event)}>
            <span className="eyebrow">Доступ сотрудника</span>
            <h1>{titles[role]}</h1>
            <p>Введите ключ доступа. Оплата и чеки - в процессе подключения.</p>
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
  if (role === 'display') return <DisplayScreen token={token} restoreAccess={logout} />;
  if (role === 'manager') return <Manager token={token} logout={logout} />;
  return <KitchenScreen token={token} station={role} logout={logout} />;
}

function StaffHeader({ title }: { title: string }) {
  return (
    <header className="staff-header">
      <Brand />
      <h1>{title}</h1>
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
      <StaffHeader title={titles[station]} />
      <Connection observed={remote.observed} error={remote.error} refresh={remote.refresh} />
      {remote.error instanceof ApiError && [401, 403].includes(remote.error.status) ? (
        <button className="staff-access-recovery" onClick={logout}>
          Восстановить доступ
        </button>
      ) : null}
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
            Этот ключ выдан для другой кухонной станции.
            <button onClick={logout}>Восстановить доступ</button>
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
                      <div key={'line_id' in line ? line.line_id : line.id}>
                        <strong>{line.quantity}×</strong>
                        <span>
                          {line.name}
                          <small>
                            {'selections' in line && line.selections.length
                              ? line.selections
                                  .map((item) => `${item.option_label} × ${item.quantity}`)
                                  .join(' · ')
                              : 'Стандартный состав'}
                          </small>
                        </span>
                      </div>
                    ))}
                  </div>
                  {tasks.some((task) => task.state === 'pending') ? (
                    <button
                      className="primary full"
                      disabled={Boolean(
                        busy || remote.error || waiting || order.state !== 'preparing',
                      )}
                      onClick={() =>
                        void complete(
                          order,
                          tasks.find((task) => task.state === 'pending')!.task_id,
                        )
                      }
                    >
                      {busy === order.order_id
                        ? 'Сохраняем…'
                        : station === 'prep'
                          ? 'Весь заказ готов'
                          : 'Заказ собран'}
                    </button>
                  ) : null}
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
          <Empty title="Очередь свободна">Подтверждённый заказ появится здесь автоматически.</Empty>
        )}
      </main>
    </div>
  );
}

function Metric({ value, children }: { value: number; children: ReactNode }) {
  return (
    <article className="metric">
      <span>{children}</span>
      <strong>{value}</strong>
      <small>Сохранённые заказы</small>
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
      <div className="manager-layout">
        <main className="manager-main">
          <header>
            <div>
              <span className="eyebrow">{location?.name ?? 'PickChick'}</span>
              <h1>Заказы и результаты</h1>
              <p>{location ? `${location.city}, ${location.address}` : 'Заказы ресторана'}</p>
            </div>
            <div className="manager-header-actions">
              <span className="test-label">Оплата и чеки - в процессе подключения</span>
              <button onClick={logout}>Выйти из роли</button>
            </div>
          </header>
          <Connection observed={remote.observed} error={remote.error} refresh={remote.refresh} />
          <div className="metrics">
            <Metric value={all.length}>Всего в списке</Metric>
            <Metric value={all.filter((o) => o.state === 'preparing').length}>На кухне</Metric>
            <Metric value={all.filter((o) => o.state === 'ready').length}>Готовы к выдаче</Metric>
            <Metric value={all.filter((o) => o.payment_state === 'simulated_unknown').length}>
              Требуют уточнения
            </Metric>
          </div>
          <Notice>
            Оплата и чеки - в процессе подключения. Суммы заказов не являются поступлениями в кассу.
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
                      <th>Без списания</th>
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
              <Empty title="Заказов пока нет">Создайте заказ в приложении или на киоске.</Empty>
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
                  <div key={'line_id' in line ? line.line_id : line.id}>
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
                  <li>Ожидают подтверждения заказа</li>
                )}
              </ul>
              {current.payment_state === 'simulated_unknown' ? (
                <>
                  <Notice warning>Подтверждение передаст заказ на кухню без списания денег.</Notice>
                  <div className="action-row">
                    <button
                      className="primary"
                      disabled={busy || Boolean(remote.error)}
                      onClick={() => void command(current, 'approved')}
                    >
                      Подтвердить без оплаты
                    </button>
                    <button
                      disabled={busy || Boolean(remote.error)}
                      onClick={() => void command(current, 'declined')}
                    >
                      Отклонить
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
                    Причина отмены заказа
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
