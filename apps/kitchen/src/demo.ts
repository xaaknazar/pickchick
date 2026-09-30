/** In-memory design rehearsal. Never opens a socket or reads workstation credentials. */
import type { Transport } from './api.js';
import { allowedActions } from './model.js';
import { action, prefix, type Credential, type Order, type Station, type Task } from './types.js';

export function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
export type DemoDetails = {
  mode: 'takeaway' | 'dine_in' | 'delivery';
  source: 'pos' | 'mobile' | 'kiosk' | 'yandex';
  customerComment: string;
  orderComment: string;
};
export function demoTicketAction(
  o: Order,
  station: string,
): 'prep' | 'assembly' | 'handoff' | null {
  if (o.assemblyStationId === station) {
    if (o.state === 'ready') return 'handoff';
    if (
      ['accepted', 'in_production'].includes(o.state) &&
      o.tasks.filter((t) => t.kind === 'prep').every((t) => t.state === 'done')
    )
      return 'assembly';
  } else if (
    ['accepted', 'in_production'].includes(o.state) &&
    o.tasks.some((t) => t.stationId === station && t.state !== 'done')
  )
    return 'prep';
  return null;
}
export function createDemo() {
  const id = () => crypto.randomUUID();
  const branchId = id();
  const stations: [Station, Station] = [
    { id: id(), kind: 'prep', name: 'Горячая кухня' },
    { id: id(), kind: 'assembly', name: 'Сборка и выдача' },
  ];
  const credential: Credential = {
    session_id: id(),
    staff_id: id(),
    terminal_id: id(),
    branch_id: branchId,
    role: 'kitchen',
    token: '0'.repeat(64),
    expires_at: '2099-01-01T00:00:00.000Z',
  };
  let orders: Order[] = [];
  let next = 101;
  const notes = new Map<string, DemoDetails>();
  const replies = new Map<string, { body: string; result: Order }>();
  const menu = [
    ['Бургер с курицей', 'Картофель фри', 'Кола 0,5 л'],
    ['Фингерсы · 5 шт.', 'Картофель фри', 'Соус сырный'],
    ['Pick Combo', 'Кола 0,5 л'],
    ['Burger Combo', 'Соус барбекю'],
  ];
  function add(state: Order['state'] = 'accepted', age = 0) {
    if (orders.length >= 60) return false;
    const number = next++;
    const date = new Date(Date.now() - age * 60000).toISOString();
    const tasks: Task[] = menu[(number - 101) % menu.length]!.map((title, i, items) => ({
      taskId: id(),
      stationId: stations[i === items.length - 1 ? 1 : 0].id,
      version: 1,
      state: state === 'ready' ? 'done' : state === 'in_production' ? 'in_progress' : 'queued',
      kind: i === items.length - 1 ? 'assembly_item' : 'prep',
      details: {
        lineId: id(),
        productId: 'demo-' + i,
        title,
        parentTitle: '',
        description: '',
        quantity: number % 3 === 0 && i === 0 ? 2 : 1,
        modifiers:
          i === 0
            ? [
                {
                  groupId: 'taste',
                  groupTitle: { ru: 'Вкус', kk: 'Дәм' },
                  optionId: 'spicy',
                  label: { ru: 'Острый', kk: 'Ащы' },
                  quantity: 1,
                  linkedProductId: null,
                },
              ]
            : [],
      },
    }));
    const orderId = id();
    const source = (['pos', 'mobile', 'yandex', 'kiosk'] as const)[(number - 101) % 4]!;
    notes.set(orderId, {
      mode: source === 'yandex' ? 'delivery' : number % 3 ? 'takeaway' : 'dine_in',
      source,
      customerComment: number % 2 ? 'Без лука. Соус отдельно.' : '',
      orderComment:
        source === 'yandex' || number % 3 === 0 ? 'Приборы на 2 персоны. Проверить упаковку.' : '',
    });
    orders.push({
      orderId,
      branchId,
      version: 1,
      state,
      displayNumber: String(number),
      routingVersion: 1,
      createdAt: date,
      updatedAt: date,
      assemblyStationId: stations[1].id,
      channel: number % 2 ? 'pos' : 'mobile',
      serviceMode: number % 3 ? 'takeaway' : 'dine_in',
      tasks,
    });
    return true;
  }
  function reset() {
    orders = [];
    next = 101;
    replies.clear();
    notes.clear();
    add('in_production', 12);
    add('accepted', 8);
    add('in_production', 5);
    orders[2]!.tasks
      .filter((t) => t.kind === 'prep')
      .forEach((t) => {
        t.state = 'done';
      });
    add('accepted', 2);
    add('ready', 7);
    add('ready', 4);
  }
  reset();
  const transport: Transport = async (path, actor, body, key) => {
    const url = new URL(path, 'https://demo.invalid');
    if (url.pathname === '/edge/v1/session') return structuredClone(credential);
    if (url.pathname === prefix + '/config') return { enabled: true };
    if (url.pathname === prefix + '/stations')
      return { branchId, items: structuredClone(stations) };
    if (url.pathname === prefix + '/kitchen') {
      const station = url.searchParams.get('stationId');
      return {
        items: structuredClone(
          orders.filter(
            (o) =>
              !['handed_over', 'cancelled'].includes(o.state) &&
              (station === stations[1].id
                ? o.tasks.filter((t) => t.kind === 'prep').every((t) => t.state === 'done')
                : o.tasks.some((t) => t.stationId === station && t.state !== 'done')),
          ),
        ),
        nextAfterOrderId: null,
      };
    }
    if (url.pathname === prefix + '/display')
      return {
        items: orders
          .filter((o) => !['handed_over', 'cancelled'].includes(o.state))
          .map((o) => ({
            number: o.displayNumber!,
            state: o.state === 'ready' ? 'ready' : 'preparing',
          })),
        nextAfterNumber: null,
      };
    const match = new RegExp('^' + prefix + '/orders/([^/]+)(/actions)?$').exec(url.pathname);
    if (match) {
      const o = orders.find((o) => o.orderId === match[1]);
      if (!o) throw new Error('NOT_FOUND');
      if (!match[2]) return structuredClone(o);
      const a = action(body);
      const encoded = JSON.stringify({ orderId: o.orderId, body: a });
      const replay = key && replies.get(key);
      if (replay) {
        if (replay.body !== encoded) throw new Error('CONFLICT');
        return structuredClone(replay.result);
      }
      if (
        !key ||
        !stations.some((s) =>
          allowedActions(o, s.id).some((v) => JSON.stringify(v) === JSON.stringify(a)),
        )
      )
        throw new Error('ACTION_UNAVAILABLE');
      if ('taskId' in a) {
        const task = o.tasks.find((t) => t.taskId === a.taskId)!;
        task.state = a.action === 'start_task' ? 'in_progress' : 'done';
        task.version++;
        o.state = 'in_production';
      } else o.state = a.action === 'ready' ? 'ready' : 'handed_over';
      o.version++;
      o.updatedAt = new Date().toISOString();
      replies.set(key, { body: encoded, result: structuredClone(o) });
      return structuredClone(o);
    }
    throw new Error('DEMO_ROUTE_NOT_SUPPORTED');
  };
  function completeTicket(orderId: string, stationId: string, version: number) {
    const o = orders.find((o) => o.orderId === orderId);
    if (!o || o.version !== version) return false;
    const action = demoTicketAction(o, stationId);
    if (!action) return false;
    if (action === 'handoff') o.state = 'handed_over';
    else {
      o.tasks
        .filter((t) => t.stationId === stationId)
        .forEach((t) => {
          t.state = 'done';
          t.version++;
        });
      o.state = action === 'assembly' ? 'ready' : 'in_production';
    }
    o.version++;
    o.updatedAt = new Date().toISOString();
    return true;
  }
  return {
    credential,
    stations,
    transport,
    add,
    reset,
    completeTicket,
    details: (id: string) => notes.get(id)!,
  };
}
