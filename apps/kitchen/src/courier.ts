/**
 * Courier counter dialogs (Аг9, contracts section 5.4): the three handover marks and the
 * "Отказ по протоколу" record. The handover itself goes through the kitchen command journal
 * (model.command); a refusal has its own journal, so a lost answer repeats exactly the same
 * request (Idempotency-Key = incident id) instead of recording a second incident.
 */
import { ApiError, assetPrefix, type Transport } from './api.js';
import { incidentKindName, providerName } from './kds-view.js';
import { INCIDENT_KINDS, incident, prefix, UUID } from './types.js';
import type { Credential, IncidentKind, IncidentProvider, Order } from './types.js';

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};
type IncidentBody = {
  orderId?: string;
  provider: IncidentProvider;
  claimedNumber?: string;
  kind: IncidentKind;
  description: string;
};
type IncidentDraft = { incidentId: string; body: IncidentBody };

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
};
function shell(label: string, heading: string) {
  const dialog = element('dialog', { className: 'password-reset courier-dialog' });
  dialog.setAttribute('aria-label', label);
  const style = element('link', {
    rel: 'stylesheet',
    href: assetPrefix + '/components/PasswordReset.css',
  });
  dialog.append(style, element('h2', { textContent: heading }));
  return dialog;
}
/**
 * A Kazakhstan/Russian phone number (+7 or 8 and ten digits, with any spacing); descriptions must
 * not carry personal data. Aggregator order numbers do not start this way.
 */
export const looksLikePhone = (text: string) =>
  /(?:\+\s*7|(?<![\p{L}\p{N}-])8)(?:[\s()-]*\d){10}(?!\d)/u.test(text);

/**
 * "Передача курьеру G-456": the button is active only with all three marks. A number typed at
 * the counter that equals the order number sets the first mark (design-kds section 5).
 */
export function openHandover(
  order: Order,
  typedNumber: string,
  confirm: () => void,
  refuse: () => void,
) {
  if (!order.delivery) return;
  const number = order.delivery.externalNumber;
  const dialog = shell(
    'Передача курьеру',
    `Передача курьеру ${providerName[order.delivery.provider]} ${number}`,
  );
  const intro = element('p', {
    textContent: `Заказ №${order.displayNumber ?? '-'}. Отметьте каждое условие при курьере.`,
  });
  const marks = [
    ['numberMatched', 'Номер в приложении курьера совпал'],
    ['courierAccepted', 'Курьер при мне нажал «Принял заказ»'],
    ['photoTaken', 'Курьер сфотографировал заказ'],
  ].map(([id, text]) => {
    const input = element('input', { type: 'checkbox', id: 'mark-' + id });
    input.dataset.mark = id!;
    return { input, label: element('label', { className: 'courier-mark' }, input, text!) };
  });
  if (typedNumber.trim().toUpperCase() === number) marks[0]!.input.checked = true;
  const hint = element('p', {
    className: 'courier-hint',
    textContent: 'Отметьте все три условия протокола передачи.',
  });
  hint.setAttribute('role', 'status');
  const cancel = element('button', {
    type: 'button',
    id: 'handover-cancel',
    textContent: 'Отмена',
  });
  const refusal = element('button', {
    type: 'button',
    id: 'handover-refuse',
    className: 'kds-secondary',
    textContent: 'Отказ по протоколу',
  });
  const submit = element('button', {
    type: 'submit',
    id: 'handover-confirm',
    className: 'kds-action kds-final',
    textContent: 'Передать курьеру',
  });
  const update = () => {
    const all = marks.every((m) => m.input.checked);
    submit.disabled = !all;
    hint.textContent = all
      ? 'Все условия отмечены.'
      : 'Отметьте все три условия протокола передачи.';
  };
  marks.forEach((m) => m.input.addEventListener('change', update));
  update();
  const form = element('form', { method: 'dialog' }, ...marks.map((m) => m.label), hint);
  form.append(element('footer', {}, cancel, refusal, submit));
  dialog.append(intro, form);
  let chosen: 'confirm' | 'refuse' | null = null;
  cancel.onclick = () => dialog.close();
  refusal.onclick = () => {
    chosen = 'refuse';
    dialog.close();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!marks.every((m) => m.input.checked)) return;
    chosen = 'confirm';
    dialog.close();
  };
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (chosen === 'confirm') confirm();
    if (chosen === 'refuse') refuse();
  });
  document.body.append(dialog);
  dialog.showModal();
  (marks.find((m) => !m.input.checked)?.input ?? submit).focus();
}

export const incidentJournalKey = (actor: Credential) =>
  `pickchick.kitchen.incident.v1.${actor.branch_id}.${actor.staff_id}.${actor.terminal_id}`;
function parseDraft(raw: string): IncidentDraft {
  const draft = JSON.parse(raw) as IncidentDraft;
  const body = draft?.body;
  if (
    !draft ||
    typeof draft.incidentId !== 'string' ||
    !UUID.test(draft.incidentId) ||
    !body ||
    !['yandex_eda', 'glovo', 'other'].includes(body.provider) ||
    !INCIDENT_KINDS.includes(body.kind) ||
    typeof body.description !== 'string' ||
    (body.orderId !== undefined &&
      (typeof body.orderId !== 'string' || !UUID.test(body.orderId))) ||
    (body.claimedNumber !== undefined &&
      (typeof body.claimedNumber !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(body.claimedNumber)))
  )
    throw new Error('JOURNAL_INVALID');
  return { incidentId: draft.incidentId, body };
}

/**
 * "Отказ по протоколу": records the refusal on the edge (POST fulfillment/incidents) and calls the
 * manager (banner on screens 2 and 3). Free text without phone numbers or names.
 */
export function openIncident(input: {
  actor: Credential;
  transport: Transport;
  storage: Storage;
  order?: Order;
  claimedNumber?: string;
  recorded: () => void;
}) {
  const { actor, transport, storage, order } = input;
  const key = incidentJournalKey(actor);
  const dialog = shell('Отказ по протоколу', 'Отказ по протоколу');
  const intro = element('p', {
    textContent: order
      ? `Заказ №${order.displayNumber ?? '-'}${order.delivery ? ` · ${providerName[order.delivery.provider]} ${order.delivery.externalNumber}` : ''}. Запись увидит менеджер.`
      : 'Заказ не найден по номеру. Запись увидит менеджер.',
  });
  const provider = element('select', { id: 'incident-provider', required: true });
  for (const [value, text] of [
    ['', 'Выберите агрегатора'],
    ['yandex_eda', providerName.yandex_eda],
    ['glovo', providerName.glovo],
    ['other', providerName.other],
  ])
    provider.append(element('option', { value: value!, textContent: text! }));
  provider.value = order?.delivery?.provider ?? '';
  const claimed = element('input', {
    id: 'incident-number',
    maxLength: 40,
    autocomplete: 'off',
    spellcheck: false,
    value: (order?.delivery?.externalNumber ?? input.claimedNumber ?? '').trim().toUpperCase(),
    placeholder: 'Например G-456',
  });
  const kind = element('select', { id: 'incident-kind', required: true });
  kind.append(element('option', { value: '', textContent: 'Выберите причину' }));
  for (const value of INCIDENT_KINDS)
    kind.append(element('option', { value, textContent: incidentKindName[value] }));
  const description = element('textarea', {
    id: 'incident-description',
    required: true,
    minLength: 3,
    maxLength: 500,
    rows: 3,
    placeholder: 'Что произошло',
  });
  // Free text in Russian: the on-screen keyboard opens with Russian letters.
  description.dataset.keyboard = 'ru';
  const feedback = element('p', { className: 'courier-hint' });
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  const close = element('button', { type: 'button', id: 'incident-close', textContent: 'Закрыть' });
  const save = element('button', {
    type: 'submit',
    id: 'incident-save',
    className: 'kds-action',
    textContent: 'Записать и вызвать менеджера',
  });
  const form = element(
    'form',
    {},
    element('label', { htmlFor: 'incident-provider', textContent: 'Агрегатор' }),
    provider,
    element('label', { htmlFor: 'incident-number', textContent: 'Номер, который назвал курьер' }),
    claimed,
    element('label', { htmlFor: 'incident-kind', textContent: 'Причина' }),
    kind,
    element('label', { htmlFor: 'incident-description', textContent: 'Описание' }),
    description,
    element('p', {
      className: 'courier-privacy',
      textContent: 'Не вводите телефоны и имена гостей и курьеров.',
    }),
    feedback,
    element('footer', {}, close, save),
  );
  dialog.append(intro, form);
  let sent: IncidentDraft | null = null,
    busy = false,
    blocked = false;
  const freeze = () => {
    for (const field of [provider, claimed, kind, description]) field.disabled = true;
    save.textContent = 'Повторить';
  };
  try {
    const raw = storage.getItem(key);
    if (raw) {
      sent = parseDraft(raw);
      provider.value = sent.body.provider;
      claimed.value = sent.body.claimedNumber ?? '';
      kind.value = sent.body.kind;
      description.value = sent.body.description;
      freeze();
      feedback.textContent = 'Предыдущая запись не подтверждена. Повторится тот же запрос.';
    }
  } catch {
    blocked = true;
    save.disabled = true;
    feedback.textContent =
      'Не удалось прочитать журнал отказа. Вызовите менеджера голосом и обратитесь к администратору.';
  }
  const forget = () => {
    try {
      storage.removeItem(key);
    } catch {
      /* the journal is kept when storage is unavailable */
    }
  };
  close.onclick = () => dialog.close();
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener('close', () => dialog.remove());
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy || blocked) return;
    if (!sent) {
      const text = description.value.trim(),
        number = claimed.value.trim().toUpperCase();
      if (!provider.value || !kind.value) {
        feedback.textContent = 'Выберите агрегатора и причину.';
        return;
      }
      if (text.length < 3 || text.length > 500) {
        feedback.textContent = 'Опишите отказ: от 3 до 500 символов.';
        return;
      }
      if (looksLikePhone(text)) {
        feedback.textContent = 'Уберите номер телефона из описания.';
        return;
      }
      if (number && !/^[A-Z0-9-]{1,40}$/.test(number)) {
        feedback.textContent = 'Номер - только буквы, цифры и дефис.';
        return;
      }
      // The edge refuses a phone number in either field (no personal data in the journal).
      if (number && looksLikePhone(number)) {
        feedback.textContent = 'Это похоже на телефон - введите номер заказа агрегатора.';
        return;
      }
      const draft: IncidentDraft = {
        incidentId: crypto.randomUUID(),
        body: {
          ...(order ? { orderId: order.orderId } : {}),
          provider: provider.value as IncidentProvider,
          ...(number ? { claimedNumber: number } : {}),
          kind: kind.value as IncidentKind,
          description: text,
        },
      };
      try {
        storage.setItem(key, JSON.stringify(draft));
        if (storage.getItem(key) !== JSON.stringify(draft)) throw new Error();
      } catch {
        feedback.textContent =
          'Не удалось сохранить журнал. Запись не отправлена. Вызовите менеджера голосом.';
        return;
      }
      sent = draft;
    }
    freeze();
    busy = true;
    save.disabled = true;
    close.disabled = true;
    feedback.textContent = 'Записываем...';
    try {
      const saved = incident(
        await transport(prefix + '/incidents', actor, sent.body, sent.incidentId),
      );
      if (saved.incidentId !== sent.incidentId) throw new Error();
      forget();
      blocked = true;
      busy = false;
      dialog.close();
      input.recorded();
      return;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.validated &&
        error.status < 500 &&
        error.status !== 429
      ) {
        // The edge refused it: nothing was recorded under this id.
        forget();
        blocked = true;
        feedback.textContent =
          error.status === 409
            ? 'Под этим номером уже записан другой отказ. Закройте окно и проверьте баннер.'
            : error.status === 403
              ? 'Записать отказ можно только на экране выдачи. Вызовите менеджера голосом.'
              : error.status === 404
                ? 'Раскладка KDS выключена. Вызовите менеджера голосом.'
                : error.status === 401
                  ? 'Сессия истекла. Войдите снова и запишите отказ.'
                  : 'Запись не принята: проверьте поля и откройте форму заново.';
      } else
        feedback.textContent =
          'Запись не подтверждена. Нажмите «Повторить» - отправится тот же запрос.';
    } finally {
      busy = false;
      save.disabled = blocked;
      close.disabled = false;
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  (sent ? save : provider.value ? kind : provider).focus();
}
