import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import locations from '../../../config/restaurant-locations.json';
import { assets } from './assets';
import { api, ApiError, type Display } from './client';
import { usePoll } from './shared';
import './display.css';

const PAGE_INTERVAL = 8000;
const timeOptions = { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit' } as const;
const messages = [
  'PICK YOUR PEAK',
  'Готовим с хрустом. Отдаём с любовью.',
  'Следите за номером вашего заказа на табло',
  'Тапсырыс нөмірін тақтадан бақылаңыз',
];

function OrderColumn({
  items,
  ready = false,
  page,
  duplicateNumbers,
}: {
  items: Display['preparing'];
  ready?: boolean;
  page: number;
  duplicateNumbers: Set<string>;
}) {
  const capacity = ready ? 4 : 6;
  const pages = Math.max(1, Math.ceil(items.length / capacity));
  // Each column owns its page: a longer cooking queue never blanks the ready list.
  const currentPage = page % pages;
  const visible = items.slice(currentPage * capacity, (currentPage + 1) * capacity);
  return (
    <section className={ready ? 'ready' : 'preparing'} aria-label={ready ? 'Готово' : 'Готовится'}>
      <div className="display-column-heading">
        {ready ? (
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 12.5 9.5 18 20 6.5" />
          </svg>
        ) : (
          <span className="display-cooking-dot" aria-hidden="true" />
        )}
        <h2>{ready ? 'Готово' : 'Готовится'}</h2>
        <span className="display-column-translation">{ready ? 'Дайын' : 'Дайындалуда'}</span>
      </div>
      <div className="display-numbers">
        {visible.map((item, index) => (
          <article
            className="display-order"
            key={item.order_id ?? `${item.number}-${index}`}
            data-order-number={item.number}
          >
            <div
              className="display-number"
              style={{ '--number-width': Math.max(3, item.number.length) * 0.72 } as CSSProperties}
            >
              {item.number}
            </div>
            <p className="display-order-caption">
              {ready ? 'Можно забирать' : 'Ваш заказ на кухне'}
              {duplicateNumbers.has(item.number) && item.shift_number
                ? ` · Смена №${item.shift_number}`
                : ''}
              {item.business_date &&
              item.business_date !==
                new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date())
                ? ` · ${item.business_date.split('-').reverse().join('.')}`
                : ''}
            </p>
            {!ready ? <div className="display-order-divider" aria-hidden="true" /> : null}
            {!ready ? <span className="display-order-status">Готовим для вас</span> : null}
          </article>
        ))}
      </div>
      {!items.length ? (
        <p className="display-empty">
          {ready ? 'Готовые заказы появятся здесь' : 'Новые номера появятся здесь'}
        </p>
      ) : null}
      <div className="display-column-footer">
        {ready ? <p>Подойдите к стойке выдачи и назовите номер заказа</p> : <span />}
        {pages > 1 ? (
          <span className="display-page" aria-label={`Страница ${currentPage + 1} из ${pages}`}>
            {currentPage + 1} / {pages}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export function DisplayScreen({
  token,
  restoreAccess,
}: {
  token: string;
  restoreAccess: () => void;
}) {
  const load = useCallback(() => api.display(token), [token]);
  const remote = usePoll(load);
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const stale = Boolean(remote.error);
  const hasData = Boolean(remote.data);
  const counts = new Map<string, number>();
  for (const item of [...(remote.data?.preparing ?? []), ...(remote.data?.ready ?? [])]) {
    counts.set(item.number, (counts.get(item.number) ?? 0) + 1);
  }
  const duplicateNumbers = new Set(
    [...counts].filter(([, count]) => count > 1).map(([number]) => number),
  );
  const location = locations.locations.find((item) => item.branch_id === remote.data?.branch_id);
  const accessLost = remote.error instanceof ApiError && [401, 403].includes(remote.error.status);
  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      if (!document.hidden) setNow(new Date());
    }, 1000);
    return () => globalThis.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (stale || !hasData) return;
    const timer = globalThis.setInterval(() => {
      if (!document.hidden) setPage((old) => old + 1);
    }, PAGE_INTERVAL);
    return () => globalThis.clearInterval(timer);
    // A successful poll must not reset the eight-second page dwell time.
  }, [stale, hasData]);
  return (
    <div className={`display-shell ${stale ? 'display-stale' : ''}`}>
      <header className="display-header">
        <span className="display-logo">
          <img src={assets.logo} alt="Pick Chick" />
        </span>
        <div className="display-heading">
          <h1>Табло выдачи</h1>
          <p>Pick Chick{location ? ` · ${location.name} · ${location.city}` : ''}</p>
        </div>
        <div className="display-clock">
          <time dateTime={now.toISOString()}>{now.toLocaleTimeString('ru-RU', timeOptions)}</time>
          <p>
            {now.toLocaleDateString('ru-RU', {
              timeZone: 'Asia/Almaty',
              day: 'numeric',
              month: 'long',
            })}
          </p>
        </div>
      </header>
      {remote.data ? (
        <main className="display-columns" aria-label="Статусы заказов">
          <OrderColumn
            items={remote.data.preparing}
            page={page}
            duplicateNumbers={duplicateNumbers}
          />
          <OrderColumn
            items={remote.data.ready}
            ready
            page={page}
            duplicateNumbers={duplicateNumbers}
          />
        </main>
      ) : (
        <main className="display-loading" role="status">
          <span className="spinner" />
          <p>{stale ? 'Данные заказов ещё не получены' : 'Получаем заказы…'}</p>
        </main>
      )}
      <footer className="display-ticker">
        {stale ? (
          <div className="display-disconnected" role="status">
            <span className="display-disconnected-dot" aria-hidden="true" />
            <div>
              <strong>Нет свежего ответа</strong>
              <p>
                {remote.observed
                  ? `Данные на ${new Date(remote.observed).toLocaleTimeString('ru-RU', timeOptions)}. Уточните готовность на стойке выдачи.`
                  : 'Уточните готовность на стойке выдачи.'}
              </p>
            </div>
            {accessLost ? <button onClick={restoreAccess}>Восстановить доступ</button> : null}
          </div>
        ) : (
          <div className="display-ticker-track">
            {[0, 1].map((copy) => (
              <div
                className="display-ticker-group"
                key={copy}
                aria-hidden={copy === 1 ? true : undefined}
              >
                {messages.map((message) => (
                  <span key={message}>{message}</span>
                ))}
              </div>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}
