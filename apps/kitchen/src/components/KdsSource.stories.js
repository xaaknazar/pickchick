import { kdsScreen } from '../kds-view.js';
import { surface } from '../../../operations-storybook/surface.mjs';
export default { title: 'Kitchen/KdsSource' };
/**
 * Synthetic KDS station queues: every ticket head names where the order came from (Касса,
 * Киоск, Приложение) under the mode chip; a delivery order names its aggregator in the chip
 * only. No live server is used.
 */
const S = {
  toasts: '00000000-0000-4000-8000-0000000000a5',
  table1: '00000000-0000-4000-8000-0000000000a1',
  table2: '00000000-0000-4000-8000-0000000000a2',
  issue: '00000000-0000-4000-8000-0000000000b2',
  counter: '00000000-0000-4000-8000-0000000000b3',
};
const stations = [
  { id: S.toasts, kind: 'prep', name: 'Тосты и бургеры (5)' },
  { id: S.table1, kind: 'assembly', name: 'Сборка - зал (стол 1)' },
  { id: S.table2, kind: 'assembly', name: 'Сборка - доставка (стол 2)' },
  { id: S.issue, kind: 'assembly', name: 'Выдача (2)' },
  { id: S.counter, kind: 'assembly', name: 'Выдача доставки (3)' },
];
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
let seq = 0;
const task = (stationId, fn, title, extra = {}) => ({
  taskId: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  stationId,
  version: 1,
  state: 'queued',
  kind: 'assembly_item',
  details: {
    lineId: `00000000-0000-4000-9000-${String(seq).padStart(12, '0')}`,
    productId: 'p' + seq,
    title,
    parentTitle: '',
    description: '',
    quantity: 1,
    modifiers: [],
    kds: { function: fn, ...extra },
  },
});
const order = (n, channel, serviceMode, minutes, tasks, extra = {}) => ({
  orderId: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`,
  branchId: '00000000-0000-4000-8000-000000000001',
  version: 1,
  state: 'in_production',
  displayNumber: String(n),
  routingVersion: 1,
  createdAt: ago(minutes),
  updatedAt: ago(0),
  assemblyStationId: S.issue,
  channel,
  serviceMode,
  tasks,
  ...extra,
});
const hall = (fn, station) => [
  order(112, 'pos', 'dine_in', 2, [task(station, fn, 'Пик бургер')]),
  order(301, 'kiosk', 'takeaway', 8, [task(station, fn, 'Комбо Крылья')]),
  order(604, 'mobile', 'takeaway', 13, [task(station, fn, 'Тост с курицей')]),
];
const delivery = (n, provider, externalNumber, station, fn) =>
  order(n, 'pos', 'takeaway', 4, [task(station, fn, 'Бокс Стрипсы')], {
    assemblyStationId: S.counter,
    delivery: { provider, externalNumber },
  });
function station(fn, stationId, orders) {
  return surface('kitchen', (root) => {
    root.innerHTML = kdsScreen({
      fn,
      stationId,
      stations,
      orders,
      breading: null,
      incidents: [],
      now: Date.now(),
      courierNumber: '',
      actions: () => [],
      blocked: () => false,
      ticket: () => '',
    });
  });
}
export const Toasts = {
  render: () => station('toasts', S.toasts, hall('toasts', S.toasts)),
};
export const HallTable = {
  render: () => station('assembly_hall', S.table1, hall('assembly_hall', S.table1)),
};
export const Issue = {
  render: () =>
    station('issue', S.issue, [
      ...hall('issue', S.issue),
      delivery(27, 'glovo', 'G-456', S.issue, 'issue'),
    ]),
};
export const DeliveryTable = {
  render: () =>
    station('assembly_delivery', S.table2, [
      delivery(27, 'glovo', 'G-456', S.table2, 'assembly_delivery'),
      delivery(31, 'yandex_eda', 'Y-123', S.table2, 'assembly_delivery'),
    ]),
};
