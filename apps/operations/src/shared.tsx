import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { assets } from './assets';
import { errorText } from './client';

export function usePoll<T>(load: () => Promise<T>, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [observed, setObserved] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const serial = useRef(0);
  const flight = useRef(false);
  const refresh = useCallback(async () => {
    if (!enabled || flight.current || document.hidden) return;
    flight.current = true;
    const version = serial.current;
    setLoading(true);
    try {
      const next = await load();
      if (version === serial.current) {
        setData(next);
        setError(null);
        setObserved(Date.now());
      }
    } catch (cause) {
      if (version === serial.current) setError(cause);
    } finally {
      flight.current = false;
      if (version === serial.current) setLoading(false);
    }
  }, [load, enabled]);
  useEffect(() => {
    serial.current += 1;
    setData(null);
    setError(null);
    setObserved(null);
    void refresh();
    const timer = globalThis.setInterval(() => {
      void refresh();
    }, 2500);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      serial.current += 1;
      globalThis.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);
  return { data, error, loading, observed, refresh };
}

export function Brand() {
  return (
    <span className="brand">
      <span className="logo-crop">
        <img src={assets.logo} alt="Pick Chick" />
      </span>
      <strong>PICK CHICK</strong>
    </span>
  );
}
export function TestBanner() {
  return (
    <div className="test-banner">
      Тестовый контур — не ресторан · Реальные деньги не списываются
    </div>
  );
}
export function Notice({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return (
    <div role={warning ? 'alert' : 'status'} className={`notice ${warning ? 'warning' : ''}`}>
      {children}
    </div>
  );
}
export function Connection({
  observed,
  error,
  refresh,
}: {
  observed: number | null;
  error: unknown;
  refresh: () => Promise<void>;
}) {
  return (
    <div className={`connection ${error ? 'stale' : ''}`} role="status">
      <span className="connection-dot" />
      <span>
        {error ? 'Нет свежего ответа' : observed ? 'Связь с сервером' : 'Получаем данные'}
        {observed
          ? ` · ${new Date(observed).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Almaty' })} Алматы`
          : ''}
      </span>
      {error ? (
        <>
          <span>
            {errorText(error)}{' '}
            {observed ? 'Последние данные не заменены.' : 'Данные ещё не получены.'}
          </span>
          <button onClick={() => void refresh()}>Повторить</button>
        </>
      ) : null}
    </div>
  );
}

export function Loading({ children = 'Загружаем данные с сервера…' }: { children?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <span className="spinner" />
      <p>{children}</p>
    </div>
  );
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-symbol">✓</span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function readJson(key: string): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as unknown;
  } catch {
    return null;
  }
}
export function saveJson(key: string, value: unknown) {
  sessionStorage.setItem(key, JSON.stringify(value));
}
export function commandKey(scope: string, payload: unknown): string {
  const storageKey = `pickchick.command.${scope}`;
  const fingerprint = JSON.stringify(payload);
  const old = readJson(storageKey) as { fingerprint?: string; key?: string } | null;
  if (old?.fingerprint === fingerprint && typeof old.key === 'string') return old.key;
  const key = crypto.randomUUID();
  saveJson(storageKey, { fingerprint, key });
  return key;
}
