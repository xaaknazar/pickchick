import { passwordReset } from './PasswordReset.js';
import { surface, actor } from '../../../operations-storybook/surface.mjs';
export default { title: 'Kitchen/PasswordReset' };
export const Form = {
  render: () =>
    surface('kitchen', (root) => {
      const button = globalThis.document.createElement('button');
      button.textContent = 'Показать восстановление пароля';
      button.onclick = () =>
        passwordReset(
          actor,
          () => {},
          async () => new globalThis.Response('{}', { status: 400 }),
        );
      root.append(button);
    }),
};
