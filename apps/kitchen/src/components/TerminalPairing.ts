import type { TerminalAccess } from '../terminal-access.js';
/** A code is read from the input once and immediately removed from the DOM. */
export function terminalPairing(access: TerminalAccess, branch: string) {
  const main = document.createElement('main');
  main.className = 'login';
  const section = document.createElement('section'),
    title = document.createElement('h2'),
    detail = document.createElement('p');
  title.textContent =
    access.mode === 'display'
      ? 'Подключение табло'
      : access.mode === 'assembly'
        ? 'Подключение сборки'
        : 'Подключение кухни';
  detail.textContent = `${branch}. Получите одноразовый код у управляющего в разделе «Устройства».`;
  const form = document.createElement('form');
  form.className = 'password-login';
  const label = document.createElement('label');
  label.htmlFor = 'terminal-code';
  label.textContent = 'Код подключения';
  const input = document.createElement('input');
  input.id = 'terminal-code';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 39;
  input.required = true;
  input.disabled = access.busy;
  const error = document.createElement('p');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  error.textContent = access.error;
  error.hidden = !access.error;
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'login-submit';
  button.textContent = access.busy ? 'Подключаем…' : 'Подключить экран';
  button.disabled = access.busy;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input.value;
    input.value = '';
    button.disabled = true;
    void access.pair(code);
  });
  form.append(label, input, error, button);
  section.append(title, detail, form);
  main.append(section);
  return main;
}
