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
    growSeconds: 30,
    seedCost: 4,
    sellPrice: 3,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'tomato',
    name: 'Томат',
    kind: 'vegetable',
    growSeconds: 60,
    seedCost: 6,
    sellPrice: 4,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'strawberry',
    name: 'Клубника',
    kind: 'berry',
    growSeconds: 90,
    seedCost: 8,
    sellPrice: 5,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'sunflower',
    name: 'Подсолнух',
    kind: 'flower',
    growSeconds: 120,
    seedCost: 10,
    sellPrice: 6,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'tulip',
    name: 'Тюльпан',
    kind: 'flower',
    growSeconds: 150,
    seedCost: 12,
    sellPrice: 7,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 1,
  },
  {
    id: 'apple',
    name: 'Яблоня',
    kind: 'tree',
    growSeconds: 180,
    seedCost: 20,
    sellPrice: 5,
    harvestYield: 3,
    unlockLevel: 1,
    maxHarvests: 3,
  },
] as const satisfies readonly {
  id: CropId;
  name: string;
  kind: string;
  growSeconds: number;
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
    rewardCoins: 25,
    rewardXp: 30,
  },
  {
    id: 'berry-basket',
    name: 'Фруктовая корзина',
    requires: { strawberry: 3, apple: 3 },
    rewardCoins: 35,
    rewardXp: 40,
  },
  {
    id: 'flower-basket',
    name: 'Букет',
    requires: { sunflower: 3, tulip: 3 },
    rewardCoins: 45,
    rewardXp: 50,
  },
] as const;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bounded = z.number().int().min(0).max(1_000_000_000);
export const FarmStateSchema = z
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
  .strict()
  .superRefine((state, ctx) => {
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
export type FarmState = z.infer<typeof FarmStateSchema>;
export const FarmCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plant'), plotId: integer, cropId: CropIdSchema }).strict(),
  z.object({ type: z.literal('harvest'), plotId: integer }).strict(),
  z.object({ type: z.literal('sell'), cropId: CropIdSchema, quantity: bounded.min(1) }).strict(),
  z
    .object({
      type: z.literal('fulfill'),
      orderId: z.enum(['vegetable-basket', 'berry-basket', 'flower-basket']),
    })
    .strict(),
  z.object({ type: z.literal('expand') }).strict(),
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
    version: 1,
    revision: 0,
    coins: 100,
    xp: 0,
    plots: Array.from({ length: 12 }, (_, id) => ({
      id,
      cropId: null,
      plantedAt: null,
      harvests: 0,
    })),
    inventory: { carrot: 0, tomato: 0, strawberry: 0, sunflower: 0, tulip: 0, apple: 0 },
    completedOrders: 0,
  };
}
export const expansionCost = (plotCount: number): number => 50 + Math.max(0, plotCount - 12) * 10;
/** Pure transition. Only the trusted server supplies now; persistence handles idempotency. Coins are fictional game currency. */
export function applyFarmCommand(
  input: FarmState,
  rawCommand: FarmCommand,
  now: number,
): FarmState {
  integer.parse(now);
  const parsed = FarmStateSchema.parse(input);
  const command = FarmCommandSchema.parse(rawCommand);
  requireRule(
    parsed.plots.every((plot) => plot.plantedAt === null || plot.plantedAt <= now),
    'CLOCK_BEFORE_PLANTING',
  );
  const state: FarmState = {
    ...parsed,
    plots: parsed.plots.map((plot) => ({ ...plot })),
    inventory: { ...parsed.inventory },
  };
  if (command.type === 'plant' || command.type === 'harvest') {
    const plot = state.plots[command.plotId];
    requireRule(!!plot, 'PLOT_NOT_FOUND');
    if (command.type === 'plant') {
      const crop = CROPS.find((item) => item.id === command.cropId)!;
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
      requireRule(now - plot.plantedAt >= crop.growSeconds * 1000, 'CROP_NOT_READY');
      state.inventory[crop.id] += crop.harvestYield;
      state.xp += 10;
      plot.harvests += 1;
      if (plot.harvests >= crop.maxHarvests) {
        plot.cropId = null;
        plot.plantedAt = null;
        plot.harvests = 0;
      } else plot.plantedAt = now;
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
    requireRule(state.plots.length < 24, 'MAX_PLOTS');
    const cost = expansionCost(state.plots.length);
    requireRule(state.coins >= cost + CROPS[0].seedCost, 'INSUFFICIENT_COINS');
    state.coins -= cost;
    state.plots.push({ id: state.plots.length, cropId: null, plantedAt: null, harvests: 0 });
  }
  state.revision += 1;
  requireRule(FarmStateSchema.safeParse(state).success, 'PROGRESSION_LIMIT');
  return state;
}
