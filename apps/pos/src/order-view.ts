import { money, type LocalOrder, type Quote } from './types.js';
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function kitchenLabel(order: LocalOrder) {
  if (order.state === 'cancelled') return 'Отменён';
  return {
    blocked: 'Не передан на кухню',
    accepted: 'На кухне',
    in_production: 'Готовится',
    ready: 'Готов к выдаче',
    handed_over: 'Выдан',
    cancel_requested: 'Ожидает отмены',
    cancelled: 'Отменён',
  }[order.fulfillment_state];
}
export function orderNumber(order: LocalOrder) {
  return order.fulfillment?.display_number ?? order.order_id.slice(0, 8);
}
export function quoteLines(quote: Quote) {
  return quote.lines
    .map(
      (line) =>
        `<div class="review-line"><div><strong>${escape(line.name.ru)}</strong><small>${line.quantity} × ${money(line.unit_price_minor)}</small>${line.modifiers?.length ? `<p class="cart-line-modifiers">${line.modifiers.map((m) => escape(`${(m.quantity ?? 1) > 1 ? `${m.quantity} × ` : ''}${m.name.ru}`)).join(' · ')}</p>` : ''}</div><b>${money(line.total_minor)}</b></div>`,
    )
    .join('');
}
export function orderView(order: LocalOrder, locked: boolean, updated: string) {
  const admitted = order.execution_mode === 'unpaid_service';
  const stopped = ['handed_over', 'cancel_requested', 'cancelled'].includes(
    order.fulfillment_state,
  );
  const canCancel =
    order.state === 'awaiting_payment' && (!admitted || order.fulfillment_state === 'accepted');
  const disabled = locked ? ' disabled' : '';
  return `<section class="order-detail" data-testid="pos-order">
    <div class="section-head"><div><span class="eyebrow">${admitted ? 'ЗАКАЗ ПЕРЕДАН' : 'ЗАКАЗ СОХРАНЁН'}</span><h1>Заказ № ${escape(orderNumber(order))}</h1></div><button class="primary" data-action="new"${disabled}>Новый заказ</button></div>
    <div class="order-columns">
      <section class="panel order-progress">
        <span class="eyebrow">${admitted ? 'СТАТУС КУХНИ' : 'СТАТУС ЗАКАЗА'}</span>
        <div class="kitchen-state ${escape(order.fulfillment_state)}" data-testid="pos-kitchen-state">${kitchenLabel(order)}</div>
        ${admitted ? `<div class="kitchen-number" data-testid="pos-display-number">${escape(order.fulfillment!.display_number)}</div><p>${order.fulfillment_state === 'ready' ? 'Заказ готов. Можно перейти к выдаче.' : order.fulfillment_state === 'handed_over' ? 'Выдача подтверждена.' : stopped ? 'Проверьте результат перед следующим действием.' : 'Заказ находится в рабочей очереди кухни.'}</p>` : '<p>Этот заказ сохранён без передачи на приготовление.</p>'}
        <p class="fine">${escape(updated)}</p>
        <button class="subtle" data-open="${order.order_id}"${disabled}>Обновить статус</button>
        <div class="payment-summary"><div class="state-line"><span>Оплата</span><strong>Не начата</strong></div><div class="state-line"><span>Фискальный чек</span><strong>Не запрошен</strong></div></div>
        ${order.cancellation_reason ? `<div class="notice">Причина отмены: ${escape(order.cancellation_reason)}</div>` : ''}
        ${canCancel ? `<button class="danger" data-action="cancel" data-testid="pos-cancel"${disabled}>Отменить заказ</button>` : order.fulfillment_state === 'in_production' ? '<p class="fine">Приготовление уже началось. Отмена с кассы недоступна.</p>' : ''}
        <details class="order-reference" data-detail-key="order-reference"><summary>Данные заказа</summary><p class="order-id" data-testid="pos-order-id">${escape(order.order_id)}</p></details>
      </section>
      <section class="panel"><div class="section-head"><h2>Состав заказа</h2><span class="service-tag">${order.snapshot.service_mode === 'dine_in' ? 'В зале' : 'С собой'}</span></div>${quoteLines(order.snapshot)}<div class="total-row"><span>Сумма заказа</span><strong>${money(order.snapshot.total_minor)}</strong></div><p class="fine">Сумма заказа не является подтверждением оплаты.</p></section>
    </div>
  </section>`;
}
export function confirmationView(quote: Quote, admitted: boolean) {
  return `<form method="dialog"><header><span class="eyebrow">ПРОВЕРКА ЗАКАЗА</span><h2 id="review-title">Всё верно?</h2><p class="muted">${quote.service_mode === 'dine_in' ? 'В зале' : 'С собой'} · Позиций: ${quote.lines.reduce((sum, line) => sum + line.quantity, 0)}</p></header><div class="review-items">${quoteLines(quote)}</div><div class="total-row"><span>Итого</span><strong>${money(quote.total_minor)}</strong></div><p class="service-mode-note">${admitted ? 'Передадим заказ на кухню без оплаты и чека.' : 'Сохраним заказ без оплаты. На кухню он пока не поступит.'}</p><div class="modifier-error" data-quote-error role="status"></div><footer class="dialog-actions"><button type="button" data-dismiss>К заказу</button><button type="submit" class="primary" data-testid="pos-create">${admitted ? 'Передать на кухню' : 'Сохранить заказ'}</button></footer></form>`;
}
