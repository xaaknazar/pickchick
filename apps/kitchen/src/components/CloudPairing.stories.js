import { cloudPairing } from './CloudPairing.js';
import { surface } from '../../../operations-storybook/surface.mjs';
export default { title: 'Kitchen/CloudPairing' };
const render = (mode, error = '', busy = false) =>
  surface('kitchen', (root) =>
    root.append(cloudPairing({ mode, branch: 'ТЦ Abay Plaza', busy, error, pair: () => {} })),
  );
export const Kitchen = { render: () => render('prep') };
export const Assembly = { render: () => render('assembly') };
export const Display = { render: () => render('display') };
export const Rejected = {
  render: () => render('prep', 'Код не принят: проверьте его и срок действия (10 минут).'),
};
export const Revoked = {
  render: () => render('prep', 'Экран отключён от сервера. Введите новый код экрана.'),
};
export const Busy = { render: () => render('assembly', '', true) };
