import type { Order, Station } from './types.js';
import { demoTicketAction, type DemoDetails } from './demo.js';
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function demoTicket(
  o: Order,
  stations: Station[],
  stationId: string,
  details: DemoDetails,
  blocked: boolean,
) {
  const assembly = stationId === o.assemblyStationId;
  const action = demoTicketAction(o, stationId);
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(o.createdAt)) / 60000));
  const received = new Date(o.createdAt).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Almaty',
  });
  const mode = { takeaway: 'С СОБОЙ', dine_in: 'В ЗАЛЕ', delivery: 'ДОСТАВКА' }[details.mode];
  const source = { pos: 'Касса', mobile: 'Приложение', kiosk: 'Киоск', yandex: 'Яндекс Еда' }[
    details.source
  ];
  const status =
    o.state === 'ready' ? 'Готов к выдаче' : assembly ? 'Кухня приготовила' : 'Приготовить заказ';
  const title =
    action === 'prep'
      ? 'Готово - на сборку'
      : action === 'assembly'
        ? 'Собран - на выдачу'
        : 'Заказ выдан';
  const tasks = assembly ? o.tasks : o.tasks.filter((t) => t.stationId === stationId);
  const comments = [
    ['Комментарий клиента', details.customerComment],
    ['Комментарий к заказу', details.orderComment],
  ];
  return `<article class="ticket whole-ticket ${o.state === 'ready' ? 'is-ready' : ''} ${minutes >= 10 ? 'is-late' : ''}" data-order="${o.orderId}">
    <div class="ticket-head"><div class="order-identity"><span class="eyebrow">ЗАКАЗ</span><strong class="number">${escape(o.displayNumber ?? '-')}</strong></div><div class="order-origin"><span class="mode mode-${details.mode}">${mode}</span><p class="channel">${source}</p></div><div class="age"><strong>${minutes} мин</strong><small>с ${received}</small></div></div>
    <div class="ticket-stage ${assembly ? 'stage-assembly' : ''}">${o.state === 'ready' ? '✓' : assembly ? '✓' : '●'} ${status}${minutes >= 10 && o.state !== 'ready' ? '<span>Долго в очереди</span>' : ''}</div>
    ${comments
      .filter(([, text]) => text)
      .map(
        ([label, text]) =>
          `<aside class="order-note"><strong>${label}</strong><p>${escape(text!)}</p></aside>`,
      )
      .join('')}
    <div class="lines">${tasks
      .map((t) => {
        const number = o.tasks.indexOf(t) + 1;
        const done = t.state === 'done';
        return `<section class="line"><div class="line-number" aria-label="Позиция ${number}">${String(number).padStart(2, '0')}</div><div class="line-info"><div class="item-title"><h3>${escape(t.details.title)}</h3><span class="quantity">${t.details.quantity}×</span></div>${t.details.parentTitle && t.details.parentTitle !== t.details.title ? `<p class="parent">${escape(t.details.parentTitle)}</p>` : ''}${t.details.modifiers.length ? `<p class="modifiers">${t.details.modifiers.map((m) => escape(m.label.ru) + (m.quantity > 1 ? ' ×' + m.quantity : '')).join(' · ')}</p>` : ''}${t.details.description ? `<p class="description">${escape(t.details.description)}</p>` : ''}${assembly ? `<p class="item-readiness ${done ? 'done' : ''}">${done ? '✓ Готово' : 'Добавить при сборке'}</p>` : ''}</div></section>`;
      })
      .join('')}</div>
    ${
      !assembly && o.tasks.some((t) => t.stationId !== stationId)
        ? `<p class="assembly-extras">На сборке: ${o.tasks
            .filter((t) => t.stationId !== stationId)
            .map((t) => `${escape(t.details.title)} ×${t.details.quantity}`)
            .join(' · ')}</p>`
        : ''
    }
    <div class="ticket-actions">${action ? `<button data-demo-order="${o.orderId}" data-version="${o.version}" ${blocked ? 'disabled' : ''}>${title}</button>` : '<p>Ожидаем готовность кухни</p>'}</div>
  </article>`;
}
