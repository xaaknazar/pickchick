import { Kiosk } from './Kiosk';
import { Staff } from './Staff';
import { Brand } from './shared';

export function App() {
  const path = window.location.pathname.replace(/^\/test(?=\/)/, '').replace(/\/$/, '') || '/';
  if (path === '/kiosk') return <Kiosk />;
  if (path === '/kitchen/prep') return <Staff role="prep" />;
  if (path === '/kitchen/assembly') return <Staff role="assembly" />;
  if (path === '/display') return <Staff role="display" />;
  if (path === '/manager') return <Staff role="manager" />;
  return (
    <div className="launcher">
      <Brand />
      <h1>PickChick</h1>
      <p>Откройте рабочий экран по адресу вашего устройства.</p>
    </div>
  );
}
