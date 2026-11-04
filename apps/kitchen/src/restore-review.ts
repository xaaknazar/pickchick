import { ApiError, assetPrefix, type Transport } from './api.js';
import type { Credential, Order } from './types.js';

type Decision = {
  commandId: string;
  epoch: number;
  expectedVersion: number;
  decision: 'resume' | 'retire';
  reason: string;
};
/** Separate immutable command journal. No credentials are persisted with the decision. */
export function openRestoreReview(
  ticket: Order,
  actor: Credential,
  transport: Transport,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  completed: () => void,
) {
  if (actor.role !== 'shift_manager' || ticket.restoreReview?.status !== 'pending') return;
  const key = `pickchick.restore-review.${actor.branch_id}.${actor.terminal_id}.${actor.staff_id}.${ticket.orderId}`;
  const dialog = document.createElement('dialog');
  dialog.className = 'password-reset restore-review';
  dialog.setAttribute('aria-label', 'Проверка восстановленного заказа');
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = assetPrefix + '/components/PasswordReset.css';
  const title = document.createElement('h2');
  title.textContent = 'Проверить заказ №' + (ticket.displayNumber ?? '-');
  const intro = document.createElement('p');
  intro.textContent =
    'Касса восстановлена из копии. Сверьте заказ с историей сервера и сотрудниками кухни. Если заказ уже выдан или его не нужно готовить, уберите его из очереди. Оплата и история сохранятся.';
  if (ticket.channel !== 'pos')
    intro.textContent +=
      ' Заказы приложения и киоска здесь можно только убрать из очереди; продолжение требует сверки с центральной системой.';
  const form = document.createElement('form');
  const choiceLabel = document.createElement('label');
  choiceLabel.textContent = 'Результат сверки';
  const choice = document.createElement('select');
  choice.required = true;
  for (const [value, label] of [
    ['', 'Выберите решение'],
    ['retire', 'Убрать из очереди'],
    ['resume', 'Разрешить приготовление'],
  ]) {
    if (value === 'resume' && ticket.channel !== 'pos') continue;
    const option = document.createElement('option');
    option.value = value!;
    option.textContent = label!;
    choice.append(option);
  }
  choiceLabel.append(choice);
  const reasonLabel = document.createElement('label');
  reasonLabel.textContent = 'Что проверили и почему';
  const reason = document.createElement('input');
  reason.required = true;
  reason.minLength = 3;
  reason.maxLength = 500;
  reasonLabel.append(reason);
  const feedback = document.createElement('p');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  const footer = document.createElement('footer');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Закрыть';
  close.onclick = () => dialog.close();
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Сохранить';
  footer.append(close, save);
  form.append(choiceLabel, reasonLabel, feedback, footer);
  dialog.append(style, title, intro, form);
  let sent: Decision | null = null,
    busy = false,
    blocked = false;
  const freeze = () => {
    choice.disabled = true;
    reason.disabled = true;
    save.textContent = 'Повторить';
  };
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Decision;
      if (
        Object.keys(parsed).sort().join(',') !==
          'commandId,decision,epoch,expectedVersion,reason' ||
        !/^[a-f0-9-]{36}$/i.test(parsed.commandId) ||
        parsed.epoch !== ticket.restoreReview.epoch ||
        !Number.isInteger(parsed.expectedVersion) ||
        parsed.expectedVersion < 1 ||
        !['resume', 'retire'].includes(parsed.decision) ||
        typeof parsed.reason !== 'string' ||
        parsed.reason.length < 3 ||
        parsed.reason.length > 500
      )
        throw new Error();
      sent = parsed;
      choice.value = parsed.decision;
      reason.value = parsed.reason;
      freeze();
      feedback.textContent = 'Предыдущий результат не подтверждён. Повторится тот же запрос.';
    }
  } catch {
    blocked = true;
    save.disabled = true;
    feedback.textContent =
      'Не удалось прочитать журнал решения. Обратитесь к администратору; сохранённые данные не удаляйте.';
  }
  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    completed();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy || blocked) return;
    if (!sent) {
      if (!['resume', 'retire'].includes(choice.value) || reason.value.trim().length < 3) return;
      const candidate: Decision = {
        commandId: crypto.randomUUID(),
        epoch: ticket.restoreReview!.epoch,
        expectedVersion: ticket.version,
        decision: choice.value as Decision['decision'],
        reason: reason.value.trim(),
      };
      try {
        storage.setItem(key, JSON.stringify(candidate));
      } catch {
        feedback.textContent =
          'Не удалось сохранить журнал. Запрос не отправлен. Проверьте доступ к хранилищу браузера.';
        return;
      }
      sent = candidate;
    }
    freeze();
    busy = true;
    save.disabled = true;
    close.disabled = true;
    feedback.textContent = 'Сохраняем решение...';
    try {
      const response = (await transport(
        `/edge/v1/fulfillment/orders/${ticket.orderId}/restore-review`,
        actor,
        sent,
      )) as { epoch?: number; status?: string };
      if (response?.epoch !== sent.epoch || response?.status !== sent.decision) throw new Error();
      storage.removeItem(key);
      blocked = true;
      feedback.textContent =
        sent.decision === 'retire'
          ? 'Заказ убран из очереди. История сохранена.'
          : 'Решение сохранено. Приготовление разрешено.';
      save.hidden = true;
      completed();
    } catch (error) {
      if (error instanceof ApiError && error.validated && error.code === 'CONFLICT') {
        try {
          storage.removeItem(key);
        } catch {
          /* Keep the exact journal if storage is unavailable. */
        }
        blocked = true;
        feedback.textContent =
          'Заказ или решение уже изменились. Закройте окно и сверьте обновлённый заказ.';
      } else
        feedback.textContent =
          'Сохранение не подтверждено. Повторите тот же запрос или закройте окно и проверьте очередь.';
    } finally {
      busy = false;
      save.disabled = blocked;
      close.disabled = false;
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  choice.focus();
}
