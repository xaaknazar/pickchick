/** Local demonstration only. No bank, order API, kitchen, receipt or loyalty authority. */
export const REVIEW_DEMO_KEY = 'pickchick.demonstration.order.v1';
export type DemoStage = 'payment' | 'declined' | 'preparing' | 'ready' | 'fulfilled';
export interface DemoLine {
  productId?: string;
  description?: string;
  name: string;
  quantity: number;
  totalMinor: string;
}
export interface DemoOrder {
  version: 1;
  synthetic: true;
  stage: DemoStage;
  serviceMode: 'takeaway' | 'dine_in';
  lines: DemoLine[];
  totalMinor: string;
}
const stages: DemoStage[] = ['payment', 'declined', 'preparing', 'ready', 'fulfilled'];
export function createDemoOrder(
  lines: DemoLine[],
  serviceMode: DemoOrder['serviceMode'],
): DemoOrder {
  if (!lines.length || lines.length > 1000 || !['takeaway', 'dine_in'].includes(serviceMode))
    throw new Error('DEMO_INVALID');
  let total = 0n;
  for (const line of lines) {
    if (
      !line ||
      typeof line.name !== 'string' ||
      !line.name.trim() ||
      line.name.length > 500 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 10000 ||
      (line.productId !== undefined &&
        (typeof line.productId !== 'string' || line.productId.length > 200)) ||
      (line.description !== undefined &&
        (typeof line.description !== 'string' || line.description.length > 2000)) ||
      typeof line.totalMinor !== 'string' ||
      !/^(0|[1-9][0-9]{0,14})$/.test(line.totalMinor)
    )
      throw new Error('DEMO_INVALID');
    total += BigInt(line.totalMinor);
  }
  return {
    version: 1,
    synthetic: true,
    stage: 'payment',
    serviceMode,
    lines: lines.map(({ name, quantity, totalMinor, productId, description }) => ({
      name,
      quantity,
      totalMinor,
      productId,
      description,
    })),
    totalMinor: total.toString(),
  };
}
export function parseDemoOrder(raw: string | null): DemoOrder | null {
  if (raw === null) return null;
  if (raw.length > 500000) throw new Error('DEMO_INVALID');
  const value = JSON.parse(raw);
  if (
    !value ||
    value.version !== 1 ||
    value.synthetic !== true ||
    !stages.includes(value.stage) ||
    !Array.isArray(value.lines)
  )
    throw new Error('DEMO_INVALID');
  const order = createDemoOrder(value.lines, value.serviceMode);
  if (order.totalMinor !== value.totalMinor) throw new Error('DEMO_INVALID');
  return { ...order, stage: value.stage };
}
export type DemoAction = 'approve' | 'decline' | 'retry' | 'ready' | 'collect';
export function advanceDemoOrder(order: DemoOrder, action: DemoAction): DemoOrder {
  const next: Partial<Record<DemoStage, Partial<Record<DemoAction, DemoStage>>>> = {
    payment: { approve: 'preparing', decline: 'declined' },
    declined: { retry: 'payment' },
    preparing: { ready: 'ready' },
    ready: { collect: 'fulfilled' },
  };
  const stage = next[order.stage]?.[action];
  if (!stage) throw new Error('DEMO_TRANSITION');
  return { ...order, stage };
}
