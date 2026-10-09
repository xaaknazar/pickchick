import { DisplayAccess } from './DisplayAccess.js';
import { TerminalAccess } from '../terminal-access.js';
import { surface } from '../../../operations-storybook/surface.mjs';
export default { title: 'Kitchen/DisplayAccess' };
export const Empty = {
  render: () =>
    surface('kitchen', (root) => {
      const access = new TerminalAccess(() => {});
      access.mode = 'display';
      access.paired = true;
      new DisplayAccess(access, () => {}).render(root, 'ТЦ Abay Plaza');
    }),
};
export const Offline = {
  render: () =>
    surface('kitchen', (root) => {
      const access = new TerminalAccess(() => {});
      access.mode = 'display';
      access.paired = true;
      access.error = 'Нет ответа кассы. Привязка сохранена.';
      new DisplayAccess(access, () => {}).render(root, 'ТЦ Abay Plaza');
    }),
};
