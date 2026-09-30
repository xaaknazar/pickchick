type LoginView = {
  name: string;
  branchLabel: string;
  configured: boolean;
  loaded: boolean;
  busy: boolean;
  retrySeconds: number;
  notice: string;
};
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function loginView(view: LoginView) {
  const blocked = view.busy || !view.configured ? ' disabled' : '';
  return `<main class="login">
    <section class="login-brand">
      <img src="/logo.png" alt="PickChick" />
      <div class="eyebrow">РАБОЧЕЕ МЕСТО КАССИРА</div>
      <h1>Хорошая смена<br />начинается здесь.</h1>
      <p>Любимые блюда. Точный состав.<br />Заказы под контролем.</p>
      <span class="brand-note">PICK CHICK · ${escape(view.branchLabel)}</span>
    </section>
    <section class="login-form">
      <div class="login-title"><span class="eyebrow">PICK CHICK</span><h2>Вход кассира</h2><p class="muted">Войдите под своим логином, чтобы начать или продолжить смену.</p></div>
      ${view.notice}
      ${!view.loaded ? '<div class="notice" role="status">Подключаем рабочее место...</div>' : !view.configured ? '<div class="notice" role="status"><strong>Настройте рабочее место</strong><p>Касса ещё не привязана к терминалу. Управляющий должен завершить настройку перед входом.</p></div>' : ''}
      <form id="password-login" class="credential-form" aria-label="Вход кассира">
        <label for="staff-login">Логин</label>
        <input id="staff-login" data-testid="pos-login" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" type="text" maxlength="64" required value="${escape(view.name)}" placeholder="Ваш логин"${blocked} />
        <label for="staff-password">Пароль</label>
        <div class="password-field">
          <input id="staff-password" data-sensitive data-testid="pos-password" name="password" autocomplete="current-password" type="password" maxlength="128" required placeholder="Введите пароль"${blocked} />
          <button type="button" class="password-toggle" data-action="password-toggle" aria-label="Показать пароль" aria-pressed="false"${blocked}>Показать</button>
        </div>
        <div class="login-wait" id="login-wait" role="status">${view.retrySeconds ? `Повторить вход через ${view.retrySeconds} с` : ''}</div>
        <button type="submit" class="primary login-submit" data-testid="pos-sign-in"${blocked || (view.retrySeconds ? ' disabled' : '')}>${view.busy ? 'Входим...' : view.retrySeconds ? `Подождите ${view.retrySeconds} с` : 'Войти'}</button>
      </form>
      <p class="fine">Логин и первый пароль выдаёт управляющий. Используйте свою учётную запись.</p>
      <details class="login-service" data-detail-key="login-service">
        <summary>Обслуживание кассы</summary>
        <p class="fine">Вход по файлу для оператора. Не передавайте файл другим сотрудникам.</p>
        <label class="file-label" for="staff-file">Выбрать файл сессии<input id="staff-file" data-testid="pos-staff-file" type="file" accept=".json,application/json"${view.busy ? ' disabled' : ''} /></label>
      </details>
    </section>
  </main>`;
}
