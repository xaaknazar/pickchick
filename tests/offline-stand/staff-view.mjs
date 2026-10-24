/**
 * What staff see about connectivity, derived from the same requests the installed screens make.
 *  - Cashier POS v2 header: apps/pos model connectionLabel() over the operations refresh
 *    (cash-shifts/current) and the edge's cloud link (GET edge/v1/cloud-link, offline stand
 *    finding). An edge without that route answers 404 and the header shows no internet state.
 *  - Kitchen LAN screen (apps/kitchen/src/app.ts nav): the kitchen read succeeds ->
 *    "Связь с локальным узлом", otherwise "Нет актуального подтверждения связи".
 * The kitchen texts are pinned against the sources by stand.test.mjs.
 */
import { connectionLabel } from '../../apps/pos/dist/model.js';

export const LABELS = {
  posLanOk: 'Локальная сеть',
  posLanDown: 'Нет связи с кассой',
  posWanDown: 'Нет интернета · касса работает',
  kitchenLanOk: 'Связь с локальным узлом',
  kitchenLanDown: 'Нет актуального подтверждения связи',
};

async function answer(url, headers) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    const body = response.ok ? await response.json() : (await response.arrayBuffer(), null);
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

export async function staffView(stand) {
  const cashier = stand.staff.cashier,
    cook = stand.staff.cook;
  const posHeaders = {
    Authorization: `Bearer ${cashier.token}`,
    'X-Staff-Session-Id': cashier.session_id,
  };
  const operations = await answer(`${stand.edgeOrigin}/edge/v1/cash-shifts/current`, posHeaders);
  const link = await answer(`${stand.edgeOrigin}/edge/v1/cloud-link`, posHeaders);
  const pos = connectionLabel({
    actor: { role: 'cashier' },
    operationsAvailable: operations.status === 200,
    operationsError: operations.status === 200 ? null : 'EDGE_UNREACHABLE',
    cloudLink: link.status === 200 ? link.body : null,
  });
  const kitchen = await answer(
    `${stand.lan.url}/edge/v1/fulfillment/kitchen?stationId=${stand.ids.prep}&limit=1`,
    {
      Authorization: `Bearer ${cook.token}`,
      'X-Staff-Session-Id': cook.session_id,
      'X-Terminal-Id': cook.terminal_id,
    },
  );
  return {
    pos: pos.label,
    kitchen: kitchen.status === 200 ? LABELS.kitchenLanOk : LABELS.kitchenLanDown,
    cloud_link: link.status === 200 ? link.body.state : `http_${link.status}`,
  };
}

const visible = (view) => ({ pos: view.pos, kitchen: view.kitchen });
const same = (a, b) => JSON.stringify(visible(a)) === JSON.stringify(visible(b));
/** Launch-offline acceptance: staff can tell "no internet" from "no local network". */
export function distinguishable({ normal, wanLoss, lanLoss }) {
  return {
    wanVisible: !same(normal, wanLoss),
    lanVisible: !same(normal, lanLoss),
    different: !same(wanLoss, lanLoss),
    ok: !same(normal, wanLoss) && !same(normal, lanLoss) && !same(wanLoss, lanLoss),
  };
}
