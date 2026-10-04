import { z } from 'zod';

export const CropIdSchema = z.enum([
  'carrot',
  'tomato',
  'strawberry',
  'sunflower',
  'tulip',
  'apple',
]);
export type CropId = z.infer<typeof CropIdSchema>;
export const CROPS = [
  {
    id: 'carrot',
    name: 'Морковь',
    kind: 'vegetable',
    growSeconds: 3600,
    harvestWindowSeconds: 3600,
    seedCost: 4,
    sellPrice: 4,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'tomato',
    name: 'Томат',
    kind: 'vegetable',
    growSeconds: 10800,
    harvestWindowSeconds: 10800,
    seedCost: 12,
    sellPrice: 10,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'strawberry',
    name: 'Клубника',
    kind: 'berry',
    growSeconds: 7200,
    harvestWindowSeconds: 7200,
    seedCost: 8,
    sellPrice: 7,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'sunflower',
    name: 'Подсолнух',
    kind: 'flower',
    growSeconds: 14400,
    harvestWindowSeconds: 14400,
    seedCost: 18,
    sellPrice: 13,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'tulip',
    name: 'Тюльпан',
    kind: 'flower',
    growSeconds: 21600,
    harvestWindowSeconds: 21600,
    seedCost: 24,
    sellPrice: 17,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'apple',
    name: 'Яблоня',
    kind: 'tree',
    growSeconds: 28800,
    harvestWindowSeconds: 28800,
    seedCost: 0,
    sellPrice: 10,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 3,
  },
] as const satisfies readonly {
  id: CropId;
  name: string;
  kind: string;
  growSeconds: number;
  harvestWindowSeconds: number;
  seedCost: number;
  sellPrice: number;
  harvestYield: number;
  unlockLevel: number;
  maxHarvests: number;
}[];
export const ORDERS = [
  {
    id: 'vegetable-basket',
    name: 'Овощная корзина',
    requires: { carrot: 3, tomato: 3 },
    rewardCoins: 46,
    rewardXp: 30,
  },
  {
    id: 'berry-basket',
    name: 'Фруктовая корзина',
    requires: { strawberry: 3, apple: 3 },
    rewardCoins: 57,
    rewardXp: 40,
  },
  {
    id: 'flower-basket',
    name: 'Букет',
    requires: { sunflower: 3, tulip: 3 },
    rewardCoins: 99,
    rewardXp: 50,
  },
] as const;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bounded = z.number().int().min(0).max(1_000_000_000);
const LegacyFarmStateBase = z
  .object({
    version: z.literal(1),
    revision: integer,
    coins: bounded,
    xp: bounded,
    plots: z
      .array(
        z
          .object({
            id: integer,
            cropId: CropIdSchema.nullable(),
            plantedAt: integer.nullable(),
            harvests: z.number().int().min(0).max(2),
          })
          .strict(),
      )
      .min(12)
      .max(24),
    inventory: z
      .object({
        carrot: bounded,
        tomato: bounded,
        strawberry: bounded,
        sunflower: bounded,
        tulip: bounded,
        apple: bounded,
      })
      .strict(),
    completedOrders: bounded,
  })
  .strict();
const LegacyFarmStateSchema = LegacyFarmStateBase.superRefine((state, ctx) => {
  state.plots.forEach((plot, index) => {
    const crop = CROPS.find((item) => item.id === plot.cropId);
    if (
      plot.id !== index ||
      (plot.cropId === null) !== (plot.plantedAt === null) ||
      (!crop && plot.harvests !== 0) ||
      (crop && plot.harvests >= crop.maxHarvests)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid plot state', path: ['plots', index] });
    }
  });
});
export const FIELD_SIZE = 64;
export const HOUSE_CELL = { x: 32, y: 28 } as const;
export const BED_COST = 150;
export const TREE_COST = 250;
const coordinate = z
  .number()
  .int()
  .min(0)
  .max(FIELD_SIZE - 1);
const PlotSchema = z
  .object({
    id: integer,
    x: coordinate,
    y: coordinate,
    kind: z.enum(['bed', 'tree']),
    cropId: CropIdSchema.nullable(),
    plantedAt: integer.nullable(),
    harvests: z.number().int().min(0).max(2),
  })
  .strict();
const FarmStateBase = LegacyFarmStateBase.extend({
  version: z.literal(2),
  plots: z.array(PlotSchema).max(FIELD_SIZE * FIELD_SIZE - 1),
  nextPlotId: integer,
});
export const FarmStateSchema = FarmStateBase.superRefine((state, ctx) => {
  const cells = new Set<string>();
  const ids = new Set<number>();
  if (!Number.isSafeInteger(state.nextPlotId)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid next plot ID', path: ['nextPlotId'] });
  }
  state.plots.forEach((plot, index) => {
    const cell = `${plot.x},${plot.y}`;
    if (
      ids.has(plot.id) ||
      plot.id >= state.nextPlotId ||
      cells.has(cell) ||
      (plot.x === HOUSE_CELL.x && plot.y === HOUSE_CELL.y) ||
      (plot.cropId === null) !== (plot.plantedAt === null) ||
      (plot.kind === 'tree' && plot.cropId !== 'apple') ||
      (plot.kind === 'bed' && (plot.cropId === 'apple' || plot.harvests !== 0))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid plot state', path: ['plots', index] });
    }
    cells.add(cell);
    ids.add(plot.id);
  });
});
export type FarmState = z.infer<typeof FarmStateSchema>;
export function upgradeFarmState(input: unknown): FarmState {
  if (typeof input === 'object' && input !== null && 'version' in input && input.version === 1) {
    const legacy = LegacyFarmStateSchema.parse(input);
    return FarmStateSchema.parse({
      ...legacy,
      version: 2,
      nextPlotId: legacy.plots.length,
      plots: legacy.plots.map((plot, index) => ({
        ...plot,
        x: 29 + (index % 6),
        y: 31 + Math.floor(index / 6),
        kind: plot.cropId === 'apple' ? 'tree' : 'bed',
      })),
    });
  }
  const compatible = FarmStateBase.extend({ nextPlotId: integer.optional() }).parse(input);
  return FarmStateSchema.parse({
    ...compatible,
    nextPlotId:
      compatible.nextPlotId ??
      compatible.plots.reduce((next, plot) => Math.max(next, plot.id + 1), 0),
  });
}
export type CropPhase = 'empty' | 'growing' | 'ready' | 'withered';
export function cropPhase(plot: FarmState['plots'][number], now: number): CropPhase {
  integer.parse(now);
  if (plot.cropId === null || plot.plantedAt === null) return 'empty';
  const crop = CROPS.find((item) => item.id === plot.cropId)!;
  const elapsed = now - plot.plantedAt;
  if (elapsed < crop.growSeconds * 1000) return 'growing';
  return elapsed < (crop.growSeconds + crop.harvestWindowSeconds) * 1000 ? 'ready' : 'withered';
}
export const FarmCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('expand') }).strict(),
  z.object({ type: z.literal('recover') }).strict(),
  z.object({ type: z.literal('plant'), plotId: integer, cropId: CropIdSchema }).strict(),
  z
    .object({
      type: z.literal('harvest'),
      plotId: integer,
      destination: z.enum(['sell', 'storage']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('sell'), cropId: CropIdSchema, quantity: bounded.min(1) }).strict(),
  z
    .object({
      type: z.literal('fulfill'),
      orderId: z.enum(['vegetable-basket', 'berry-basket', 'flower-basket']),
    })
    .strict(),
  z.object({ type: z.literal('buyPlot'), x: coordinate, y: coordinate }).strict(),
  z
    .object({
      type: z.literal('buyTree'),
      x: coordinate,
      y: coordinate,
      cropId: z.literal('apple'),
    })
    .strict(),
  z.object({ type: z.literal('movePlot'), plotId: integer, x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('clear'), plotId: integer }).strict(),
  z.object({ type: z.literal('removePlot'), plotId: integer }).strict(),
]);
export type FarmCommand = z.infer<typeof FarmCommandSchema>;
export class FarmGameError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'FarmGameError';
  }
}
function requireRule(condition: boolean, code: string): asserts condition {
  if (!condition) throw new FarmGameError(code);
}
export function levelForXp(xp: number): number {
  return Math.min(10, 1 + Math.floor(Math.sqrt(bounded.parse(xp) / 100)));
}
export function createFarm(now: number): FarmState {
  integer.parse(now);
  return {
    version: 2,
    revision: 0,
    nextPlotId: 0,
    coins: 500,
    xp: 0,
    plots: [],
    inventory: { carrot: 0, tomato: 0, strawberry: 0, sunflower: 0, tulip: 0, apple: 0 },
    completedOrders: 0,
  };
}
/** Per-cycle profit excludes bed acquisition; apple planting cost is the full first tree purchase. */
export function cropEconomics(cropId: CropId) {
  const crop = CROPS.find((item) => item.id === CropIdSchema.parse(cropId))!;
  const revenue = crop.sellPrice * crop.harvestYield;
  const tree = crop.kind === 'tree';
  const profit = revenue - crop.seedCost;
  return {
    revenue,
    plantingCost: tree ? TREE_COST : crop.seedCost,
    profit,
    growthSeconds: crop.growSeconds,
    paybackHarvests: Math.ceil((tree ? TREE_COST : BED_COST) / profit),
  };
}
/** Lifetime placement counter prevents removal/rebuy from resetting expansion prices. */
export function nextLandCost(input: FarmState, kind: 'bed' | 'tree'): number {
  const state = upgradeFarmState(input);
  const parsedKind = z.enum(['bed', 'tree']).parse(kind);
  const count = BigInt(state.nextPlotId);
  const price = BigInt(parsedKind === 'tree' ? TREE_COST : BED_COST) + 25n * count * count;
  // Representability ceiling only: balances are bounded far below this price.
  return Number(price > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : price);
}
/** Recovery gives one normal carrot cycle, never currency or instant rewards. */
export function canRecoverFarm(input: FarmState, now: number): boolean {
  integer.parse(now);
  const state = upgradeFarmState(input);
  return (
    Object.values(state.inventory).every((quantity) => quantity === 0) &&
    state.plots.every(
      (plot) => plot.kind === 'bed' && ['empty', 'withered'].includes(cropPhase(plot, now)),
    ) &&
    state.coins <
      (state.plots.length ? CROPS[0].seedCost : nextLandCost(state, 'bed') + CROPS[0].seedCost)
  );
}
/** Pure transition. Only the trusted server supplies now; persistence handles idempotency. Coins are fictional game currency. */
export function applyFarmCommand(
  input: FarmState,
  rawCommand: FarmCommand,
  now: number,
): FarmState {
  integer.parse(now);
  const parsed = upgradeFarmState(input);
  const command = FarmCommandSchema.parse(rawCommand);
  requireRule(command.type !== 'expand', 'LEGACY_COMMAND');
  requireRule(
    parsed.plots.every((plot) => plot.plantedAt === null || plot.plantedAt <= now),
    'CLOCK_BEFORE_PLANTING',
  );
  const state: FarmState = {
    ...parsed,
    plots: parsed.plots.map((plot) => ({ ...plot })),
    inventory: { ...parsed.inventory },
  };
  if (command.type === 'recover') {
    requireRule(canRecoverFarm(state, now), 'RECOVERY_NOT_AVAILABLE');
    let plot = state.plots[0];
    if (!plot) {
      plot = {
        id: state.nextPlotId,
        x: HOUSE_CELL.x,
        y: HOUSE_CELL.y + 2,
        kind: 'bed',
        cropId: null,
        plantedAt: null,
        harvests: 0,
      };
      state.plots.push(plot);
      state.nextPlotId += 1;
    }
    plot.cropId = 'carrot';
    plot.plantedAt = now;
    plot.harvests = 0;
  } else if (
    command.type === 'plant' ||
    command.type === 'harvest' ||
    command.type === 'clear' ||
    command.type === 'movePlot' ||
    command.type === 'removePlot'
  ) {
    const plot = state.plots.find((candidate) => candidate.id === command.plotId);
    requireRule(!!plot, 'PLOT_NOT_FOUND');
    if (command.type === 'removePlot') {
      state.plots = state.plots.filter((candidate) => candidate.id !== plot.id);
    } else if (command.type === 'movePlot') {
      requireRule(!(command.x === HOUSE_CELL.x && command.y === HOUSE_CELL.y), 'CELL_RESERVED');
      requireRule(
        !state.plots.some(
          (other) => other.id !== plot.id && other.x === command.x && other.y === command.y,
        ),
        'CELL_OCCUPIED',
      );
      plot.x = command.x;
      plot.y = command.y;
    } else if (command.type === 'clear') {
      requireRule(cropPhase(plot, now) === 'withered', 'CROP_NOT_WITHERED');
      plot.harvests = 0;
      plot.cropId = plot.kind === 'tree' ? 'apple' : null;
      plot.plantedAt = plot.kind === 'tree' ? now : null;
    } else if (command.type === 'plant') {
      const crop = CROPS.find((item) => item.id === command.cropId)!;
      requireRule(plot.kind === 'bed' && crop.kind !== 'tree', 'CROP_REQUIRES_TREE');
      requireRule(plot.cropId === null, 'PLOT_OCCUPIED');
      requireRule(levelForXp(state.xp) >= crop.unlockLevel, 'CROP_LOCKED');
      requireRule(state.coins >= crop.seedCost, 'INSUFFICIENT_COINS');
      state.coins -= crop.seedCost;
      plot.cropId = crop.id;
      plot.plantedAt = now;
      plot.harvests = 0;
    } else {
      requireRule(plot.cropId !== null && plot.plantedAt !== null, 'PLOT_EMPTY');
      const crop = CROPS.find((item) => item.id === plot.cropId)!;
      requireRule(cropPhase(plot, now) !== 'withered', 'CROP_WITHERED');
      requireRule(cropPhase(plot, now) === 'ready', 'CROP_NOT_READY');
      if (command.destination === 'sell') state.coins += crop.sellPrice * crop.harvestYield;
      else state.inventory[crop.id] += crop.harvestYield;
      state.xp += 10;
      if (plot.kind === 'tree') {
        plot.harvests = (plot.harvests + 1) % 3;
        plot.plantedAt = now;
      } else {
        plot.cropId = null;
        plot.plantedAt = null;
        plot.harvests = 0;
      }
    }
  } else if (command.type === 'sell') {
    requireRule(state.inventory[command.cropId] >= command.quantity, 'INSUFFICIENT_INVENTORY');
    state.inventory[command.cropId] -= command.quantity;
    state.coins += CROPS.find((crop) => crop.id === command.cropId)!.sellPrice * command.quantity;
  } else if (command.type === 'fulfill') {
    const order = ORDERS.find((item) => item.id === command.orderId)!;
    const requirements = Object.entries(order.requires) as [CropId, number][];
    requireRule(
      requirements.every(([crop, quantity]) => state.inventory[crop] >= quantity),
      'ORDER_NOT_READY',
    );
    for (const [crop, quantity] of requirements) state.inventory[crop] -= quantity;
    state.coins += order.rewardCoins;
    state.xp += order.rewardXp;
    state.completedOrders += 1;
  } else {
    requireRule(state.plots.length < FIELD_SIZE * FIELD_SIZE - 1, 'MAX_PLOTS');
    requireRule(!(command.x === HOUSE_CELL.x && command.y === HOUSE_CELL.y), 'CELL_RESERVED');
    requireRule(
      !state.plots.some((plot) => plot.x === command.x && plot.y === command.y),
      'CELL_OCCUPIED',
    );
    const tree = command.type === 'buyTree';
    const cost = nextLandCost(state, tree ? 'tree' : 'bed');
    requireRule(state.coins >= cost, 'INSUFFICIENT_COINS');
    state.coins -= cost;
    state.plots.push({
      id: state.nextPlotId,
      x: command.x,
      y: command.y,
      kind: tree ? 'tree' : 'bed',
      cropId: tree ? 'apple' : null,
      plantedAt: tree ? now : null,
      harvests: 0,
    });
  }
  if (command.type === 'buyPlot' || command.type === 'buyTree') state.nextPlotId += 1;
  state.revision += 1;
  requireRule(FarmStateSchema.safeParse(state).success, 'PROGRESSION_LIMIT');
  return state;
}
