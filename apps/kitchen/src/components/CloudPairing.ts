/**
 * Binding a kitchen browser to the cloud (ADR-0014, owner decision 5): the screen works without
 * the cashier and without a cook password. The one-time code is read once, removed from the DOM
 * and sent to the portal, which keeps the resulting key in an HttpOnly cookie.
 */
export type CloudPairingView = {
  mode: 'prep' | 'assembly' | 'display';
  branch: string;
  busy: boolean;
  error: string;
  pair: (code: string) => void;
};
export function cloudPairing(view: CloudPairingView) {
  const main = document.createElement('main');
  main.className = 'login';
  main.dataset.testid = 'cloud-pairing';
  const section = document.createElement('section'),
    eyebrow = document.createElement('span'),
    title = document.createElement('h2'),
    detail = document.createElement('p');
  eyebrow.className = 'login-eyebrow';
  eyebrow.textContent = 'ЗАКАЗЫ КИОСКА И ПРИЛОЖЕНИЯ';
  title.textContent =
    view.mode === 'display'
      ? 'Подключение табло к серверу'
      : view.mode === 'assembly'
        ? 'Подключение сборки к серверу'
        : 'Подключение кухни к серверу';
  detail.textContent = `${view.branch}. Введите одноразовый код экрана от управляющего. Касса и пароль повара для этого не нужны.`;
  const form = document.createElement('form');
  form.className = 'password-login';
  const label = document.createElement('label');
  label.htmlFor = 'cloud-code';
  label.textContent = 'Код экрана';
  const input = document.createElement('input');
  input.id = 'cloud-code';
  input.type = 'text';
  input.autocomplete = 'off';
  input.autocapitalize = 'characters';
  input.spellcheck = false;
  input.maxLength = 16;
  input.placeholder = 'XXXX-XXXXXX';
  input.required = true;
  input.disabled = view.busy;
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = 'Код действует 10 минут и подходит только для этого экрана.';
  const error = document.createElement('p');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  error.textContent = view.error;
  error.hidden = !view.error;
  const button = document.createElement('button');
  button.type = 'submit';
  button.id = 'cloud-pair';
  button.className = 'login-submit';
  button.textContent = view.busy ? 'Подключаем...' : 'Подключить экран';
  button.disabled = view.busy;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input.value;
    input.value = '';
    button.disabled = true;
    view.pair(code);
  });
  form.append(label, input, hint, error, button);
  section.append(eyebrow, title, detail, form);
  main.append(section);
  return main;
}
