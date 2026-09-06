import { Kiosk } from './Kiosk';
import { Staff } from './Staff';
import { Brand, TestBanner } from './shared';

export function App() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  if (path === '/kiosk') return <Kiosk />;
  if (path === '/kitchen/prep') return <Staff role="prep" />;
  if (path === '/kitchen/assembly') return <Staff role="assembly" />;
  if (path === '/display') return <Staff role="display" />;
  if (path === '/manager') return <Staff role="manager" />;
  return (
    <div className="launcher">
      <TestBanner />
      <Brand />
      <h1>PickChick · Рабочие экраны</h1>
      <p>Единый тестовый заказ от киоска до выдачи.</p>
      <nav>
        <a href="/kiosk">Киоск</a>
        <a href="/kitchen/prep">A · Приготовление</a>
        <a href="/kitchen/assembly">B · Сборка и выдача</a>
        <a href="/display">Табло</a>
        <a href="/manager">Управляющий</a>
      </nav>
      <p>Для служебных экранов нужен временный ключ соответствующей роли.</p>
    </div>
  );
}
