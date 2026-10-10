import { apiPrefix, assetPrefix } from '../api.js';
/** Owns its form and appearance. Plaintext input is cleared before the one-shot request. */
export function passwordReset(
  terminalId: string,
  completed: () => void,
  request: typeof fetch = fetch,
) {
  const dialog = document.createElement('dialog');
  dialog.className = 'password-reset';
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = assetPrefix + '/components/PasswordReset.css';
  const heading = document.createElement('h2');
  heading.textContent = 'Новый пароль кухни';
  const intro = document.createElement('p');
  intro.textContent =
    'Получите код в разделе «Устройства» у управляющего. Пароль изменится для kitchen на кухне и сборке. Все прежние входы этого сотрудника завершатся.';
  const form = document.createElement('form');
  const input = (label: string, type: string, autocomplete: string, max: number) => {
    const l = document.createElement('label'),
      i = document.createElement('input');
    l.textContent = label;
    i.type = type;
    i.setAttribute('autocomplete', autocomplete);
    i.maxLength = max;
    i.required = true;
    l.append(i);
    form.append(l);
    return i;
  };
  const code = input('Код восстановления', 'text', 'off', 39),
    password = input('Новый пароль', 'password', 'new-password', 128),
    confirm = input('Повторите пароль', 'password', 'new-password', 128);
  password.minLength = 12;
  confirm.minLength = 12;
  const hint = document.createElement('p');
  hint.textContent =
    'От 12 до 128 символов. Пароль вводится только здесь и не сохраняется в журнале.';
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  const footer = document.createElement('footer'),
    cancel = document.createElement('button'),
    save = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Отмена';
  save.type = 'submit';
  save.textContent = 'Сохранить пароль';
  cancel.onclick = () => dialog.close();
  footer.append(cancel, save);
  form.append(hint, error, footer);
  dialog.append(style, heading, intro, form);
  let busy = false;
  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  dialog.addEventListener('close', () => {
    code.value = '';
    password.value = '';
    confirm.value = '';
    dialog.remove();
  });
  form.onsubmit = (event) => {
    event.preventDefault();
    if (busy) return;
    if (password.value !== confirm.value) {
      error.textContent = 'Пароли не совпадают.';
      return;
    }
    if (!/^([a-f0-9]{4}-){7}[a-f0-9]{4}$|^[a-f0-9]{32}$/i.test(code.value.trim())) {
      error.textContent = 'Введите полный код.';
      return;
    }
    const body = JSON.stringify({
      code: code.value.trim(),
      password: password.value,
      terminal_id: terminalId,
    });
    code.value = '';
    password.value = '';
    confirm.value = '';
    busy = true;
    save.disabled = true;
    cancel.disabled = true;
    error.textContent = '';
    void request(apiPrefix + '/edge/v1/staff/password-reset', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body,
    })
      .then((response) => {
        if (response.ok) {
          completed();
          dialog.close();
          return;
        }
        error.textContent =
          response.status === 429
            ? 'Слишком много попыток. Подождите минуту.'
            : 'Код не принят. Проверьте срок действия и готовность кода у управляющего.';
      })
      .catch(() => {
        error.textContent =
          'Ответ не получен. Попробуйте войти с новым паролем: изменение могло сохраниться. Повтор автоматически не отправляется.';
      })
      .finally(() => {
        busy = false;
        save.disabled = false;
        cancel.disabled = false;
      });
  };
  document.body.append(dialog);
  dialog.showModal();
  code.focus();
}
