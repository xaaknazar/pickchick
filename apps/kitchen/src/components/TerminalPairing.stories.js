import { terminalPairing } from './TerminalPairing.js';
import { TerminalAccess } from '../terminal-access.js';
import { surface } from '../../../operations-storybook/surface.mjs';
export default { title: 'Kitchen/TerminalPairing' };
function render(mode, error = '') {
  return surface('kitchen', (root) => {
    const model = new TerminalAccess(() => {});
    model.enabled = true;
    model.mode = mode;
    model.error = error;
    model.pair = async () => false;
    root.append(terminalPairing(model, 'ТЦ Abay Plaza'));
  });
}
export const Kitchen = { render: () => render('prep') };
export const Assembly = { render: () => render('assembly') };
export const Display = { render: () => render('display') };
export const InvalidCode = {
  render: () => render('prep', 'Код не принят: проверьте назначение экрана и срок действия.'),
};
