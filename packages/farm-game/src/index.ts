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
    growSeconds: 300,
    harvestWindowSeconds: 129600,
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
    harvestWindowSeconds: 129600,
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
    growSeconds: 1800,
    harvestWindowSeconds: 129600,
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
    harvestWindowSeconds: 129600,
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
    harvestWindowSeconds: 129600,
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
    harvestWindowSeconds: 129600,
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
    id: 'welcome-basket',
    name: 'Первая морковь',
    requires: { carrot: 3 },
    rewardCoins: 14,
    rewardXp: 12,
  },
  {
    id: 'tomato-box',
    name: 'Томаты к обеду',
    requires: { tomato: 6 },
    rewardCoins: 68,
    rewardXp: 24,
  },
  {
    id: 'garden-berries',
    name: 'Ягоды из сада',
    requires: { strawberry: 6 },
    rewardCoins: 48,
    rewardXp: 16,
  },
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
export const DECORATIONS = [
  { id: 'path', name: 'Дорожка', cost: 5, unlockLevel: 1 },
  { id: 'fence', name: 'Забор', cost: 12, unlockLevel: 2 },
  { id: 'flowerpot', name: 'Цветочный горшок', cost: 30, unlockLevel: 2 },
  { id: 'bench', name: 'Скамья', cost: 75, unlockLevel: 3 },
  { id: 'lantern', name: 'Фонарь', cost: 60, unlockLevel: 3 },
  { id: 'birdhouse', name: 'Скворечник', cost: 90, unlockLevel: 4 },
  { id: 'fountain', name: 'Фонтан', cost: 240, unlockLevel: 5 },
  { id: 'arch', name: 'Арка', cost: 180, unlockLevel: 6 },
  { id: 'pond', name: 'Пруд', cost: 300, unlockLevel: 7 },
  { id: 'picnic', name: 'Пикник', cost: 220, unlockLevel: 8 },
  { id: 'statue', name: 'Садовая фигурка', cost: 400, unlockLevel: 9 },
  { id: 'gazebo', name: 'Беседка', cost: 600, unlockLevel: 10 },
] as const;
export const RECIPES = [
  {
    id: 'jam',
    name: 'Клубничное варенье',
    stationId: 'kitchen',
    unlockLevel: 4,
    seconds: 900,
    requires: { strawberry: 3 },
    sellPrice: 30,
    rewardXp: 4,
  },
  {
    id: 'juice',
    name: 'Яблочный сок',
    stationId: 'kitchen',
    unlockLevel: 6,
    seconds: 1800,
    requires: { apple: 3 },
    sellPrice: 42,
    rewardXp: 6,
  },
  {
    id: 'bouquet',
    name: 'Солнечный букет',
    stationId: 'florist',
    unlockLevel: 5,
    seconds: 1200,
    requires: { sunflower: 3 },
    sellPrice: 54,
    rewardXp: 5,
  },
  {
    id: 'spring-bouquet',
    name: 'Весенний букет',
    stationId: 'florist',
    unlockLevel: 8,
    seconds: 2400,
    requires: { tulip: 3, sunflower: 1 },
    sellPrice: 82,
    rewardXp: 8,
  },
] as const;
const decorationId = z.enum(DECORATIONS.map((d) => d.id));
const recipeId = z.enum(RECIPES.map((r) => r.id));
const stationId = z.enum(['kitchen', 'florist']);
const decorationSchema = z
  .object({
    id: integer,
    decorationId,
    x: integer.max(63).nullable(),
    y: integer.max(63).nullable(),
  })
  .strict();
const ProgressionSchema = z
  .object({
    reserveOrderId: z
      .enum(ORDERS.map((o) => o.id))
      .nullable()
      .optional(),
    tutorialPlantings: integer.max(2),
    harvested: bounded,
    orders: bounded,
    produced: bounded,
    harvestedCrops: z
      .object({
        carrot: bounded,
        tomato: bounded,
        strawberry: bounded,
        sunflower: bounded,
        tulip: bounded,
        apple: bounded,
      })
      .strict(),
    storedPlots: z
      .array(
        z
          .object({
            id: integer,
            kind: z.enum(['bed', 'tree']),
            cropId: CropIdSchema.nullable(),
            plantedAt: integer.nullable(),
            harvests: integer.max(2),
            timing: z
              .object({ growSeconds: integer, harvestWindowSeconds: integer, rewardXp: bounded })
              .optional(),
          })
          .strict(),
      )
      .max(1024),
    decorations: z.array(decorationSchema).max(1024),
    nextDecorationId: integer,
    houseStyle: z.enum(['classic', 'mint', 'sunshine']),
    stations: z
      .array(
        z
          .object({
            id: stationId,
            queue: z.array(z.object({ id: integer, recipeId, readyAt: integer }).strict()).max(3),
          })
          .strict(),
      )
      .max(2),
    nextJobId: integer,
    products: z.record(recipeId, bounded),
    claimedQuests: z.array(z.string()).max(20),
    claimedGoals: z.array(z.string()).max(12),
    goalPeriod: integer,
    weekPeriod: integer.optional(),
    weekHarvests: bounded.optional(),
    weekOrders: bounded.optional(),
    goalHarvests: bounded,
    goalOrders: bounded,
    goalProduced: bounded,
  })
  .strict();
function newProgression(): z.infer<typeof ProgressionSchema> {
  return {
    tutorialPlantings: 0,
    harvested: 0,
    orders: 0,
    produced: 0,
    harvestedCrops: { carrot: 0, tomato: 0, strawberry: 0, sunflower: 0, tulip: 0, apple: 0 },
    storedPlots: [],
    decorations: [],
    nextDecorationId: 0,
    houseStyle: 'classic',
    stations: [],
    nextJobId: 0,
    products: { jam: 0, juice: 0, bouquet: 0, 'spring-bouquet': 0 },
    claimedQuests: [],
    claimedGoals: [],
    goalPeriod: 0,
    goalHarvests: 0,
    goalOrders: 0,
    goalProduced: 0,
  };
}
const ProgressionCommands = [
  z
    .object({
      type: z.literal('setOrderReserve'),
      orderId: z.enum(ORDERS.map((o) => o.id)).nullable(),
    })
    .strict(),
  z.object({ type: z.literal('storePlot'), plotId: integer }).strict(),
  z
    .object({
      type: z.literal('placePlot'),
      plotId: integer,
      x: integer.max(63),
      y: integer.max(63),
    })
    .strict(),
  z
    .object({
      type: z.literal('buyDecoration'),
      decorationId,
      x: integer.max(63),
      y: integer.max(63),
    })
    .strict(),
  z
    .object({
      type: z.literal('moveDecoration'),
      instanceId: integer,
      x: integer.max(63),
      y: integer.max(63),
    })
    .strict(),
  z.object({ type: z.literal('storeDecoration'), instanceId: integer }).strict(),
  z
    .object({
      type: z.literal('placeDecoration'),
      instanceId: integer,
      x: integer.max(63),
      y: integer.max(63),
    })
    .strict(),
  z
    .object({ type: z.literal('setHouseStyle'), style: z.enum(['classic', 'mint', 'sunshine']) })
    .strict(),
  z.object({ type: z.literal('buyStation'), stationId }).strict(),
  z.object({ type: z.literal('startProduction'), recipeId }).strict(),
  z.object({ type: z.literal('collectProduction'), stationId, jobId: integer }).strict(),
  z.object({ type: z.literal('sellProduct'), recipeId, quantity: bounded.min(1) }).strict(),
  z.object({ type: z.literal('claimQuest'), questId: z.string().min(1).max(40) }).strict(),
  z
    .object({
      type: z.literal('claimGoal'),
      goalId: z.enum(['daily-harvest', 'daily-order', 'daily-production', 'weekly-garden']),
    })
    .strict(),
] as const;
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
/** Inclusive32×32 placement bounds; stored legacy coordinates still use FIELD_SIZE. */
export const PLANTING_BOUNDS = { minX: 16, maxX: 47, minY: 16, maxY: 47 } as const;
/** Fixed visual house outside planting bounds; historical beds are never relocated. */
export const HOUSE_DISPLAY_CELL = { x: 14, y: 14 } as const;
export function isPlantingCell(x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= PLANTING_BOUNDS.minX &&
    x <= PLANTING_BOUNDS.maxX &&
    y >= PLANTING_BOUNDS.minY &&
    y <= PLANTING_BOUNDS.maxY
  );
}
export const HOUSE_CELL = HOUSE_DISPLAY_CELL;
export const BED_COST = 150;
export const TREE_COST = 250;
const coordinate = z
  .number()
  .int()
  .min(0)
  .max(FIELD_SIZE - 1);
const TimingSchema = z
  .object({ growSeconds: integer.min(1), harvestWindowSeconds: integer.min(1), rewardXp: bounded })
  .strict();
const PlotSchema = z
  .object({
    id: integer,
    x: coordinate,
    y: coordinate,
    kind: z.enum(['bed', 'tree']),
    timing: TimingSchema.optional(),
    cropId: CropIdSchema.nullable(),
    plantedAt: integer.nullable(),
    harvests: z.number().int().min(0).max(2),
  })
  .strict();
const FarmStateBase = LegacyFarmStateBase.extend({
  version: z.literal(2),
  plots: z.array(PlotSchema).max(FIELD_SIZE * FIELD_SIZE - 1),
  nextPlotId: integer,
  progression: ProgressionSchema.optional(),
});
export const FarmStateSchema = FarmStateBase.superRefine((state, ctx) => {
  if (state.progression) {
    const p = state.progression;
    const objectIds = new Set(state.plots.map((v) => v.id));
    const cells = new Set(state.plots.map((v) => `${v.x},${v.y}`));
    const decorationIds = new Set<number>();
    const stationIds = new Set<string>();
    const jobs = new Set<number>();
    const invalid = () =>
      ctx.addIssue({ code: 'custom', message: 'Invalid progression state', path: ['progression'] });
    for (const v of p.storedPlots) {
      if (
        objectIds.has(v.id) ||
        v.id >= state.nextPlotId ||
        (v.cropId === null) !== (v.plantedAt === null) ||
        (v.kind === 'tree' && v.cropId !== 'apple') ||
        (v.kind === 'bed' && v.cropId !== null)
      )
        invalid();
      objectIds.add(v.id);
    }
    for (const v of p.decorations) {
      if (
        decorationIds.has(v.id) ||
        v.id >= p.nextDecorationId ||
        (v.x === null) !== (v.y === null)
      )
        invalid();
      decorationIds.add(v.id);
      if (v.x !== null) {
        const cell = `${v.x},${v.y}`;
        if (!isPlantingCell(v.x, v.y!) || cells.has(cell)) invalid();
        cells.add(cell);
      }
    }
    for (const v of p.stations) {
      if (stationIds.has(v.id)) invalid();
      stationIds.add(v.id);
      for (const j of v.queue) {
        if (
          jobs.has(j.id) ||
          j.id >= p.nextJobId ||
          RECIPES.find((r) => r.id === j.recipeId)?.stationId !== v.id
        )
          invalid();
        jobs.add(j.id);
      }
    }
    if (
      new Set(p.claimedQuests).size !== p.claimedQuests.length ||
      p.claimedQuests.some((id) => !QUESTS.some((q) => q.id === id))
    )
      invalid();
  }
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
  const crop = cropTiming(plot);
  const elapsed = now - plot.plantedAt;
  if (elapsed < crop.growSeconds * 1000) return 'growing';
  return elapsed < (crop.growSeconds + crop.harvestWindowSeconds) * 1000 ? 'ready' : 'withered';
}
export const FarmCommandSchema = z.discriminatedUnion('type', [
  ...ProgressionCommands,
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
      orderId: z.enum(ORDERS.map((o) => o.id)),
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
  z.object({ type: z.literal('removeCrop'), plotId: integer }).strict(),
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
  const amount = bounded.parse(xp);
  return LEVEL_XP.filter((threshold) => amount >= threshold).length;
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
    progression: newProgression(),
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
/** Linear acquisition prices count placed and stored objects independently by category. */
export function nextLandCost(input: FarmState, kind: 'bed' | 'tree'): number {
  const state = upgradeFarmState(input);
  const parsedKind = z.enum(['bed', 'tree']).parse(kind);
  const count = BigInt(
    state.plots.filter((p) => p.kind === parsedKind).length +
      (state.progression?.storedPlots.filter((p) => p.kind === parsedKind).length ?? 0),
  );
  const price = BigInt(parsedKind === 'tree' ? TREE_COST : BED_COST) + 25n * count;
  // Representability ceiling only: balances are bounded far below this price.
  return Number(price > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : price);
}
/** Recovery gives one normal carrot cycle, never currency or instant rewards. */
export function canRecoverFarm(input: FarmState, now: number): boolean {
  integer.parse(now);
  const state = upgradeFarmState(input);
  return (
    (!state.progression ||
      (state.progression.storedPlots.length === 0 &&
        state.progression.stations.every((station) => station.queue.length === 0) &&
        Object.values(state.progression.products).every((n) => n === 0))) &&
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
    progression: structuredClone(
      parsed.progression ?? { ...newProgression(), orders: parsed.completedOrders },
    ),
    plots: parsed.plots.map((plot) => ({ ...plot })),
    inventory: { ...parsed.inventory },
  };
  const period = Math.floor(now / 86400000);
  const progression = state.progression!;
  if (progression.goalPeriod !== period) {
    progression.goalPeriod = period;
    progression.claimedGoals = progression.claimedGoals.filter((v) => v.startsWith('weekly:'));
    progression.goalHarvests = progression.harvested;
    progression.goalOrders = progression.orders;
    progression.goalProduced = progression.produced;
  }
  const week = Math.floor(period / 7);
  if (progression.weekPeriod !== week) {
    progression.weekPeriod = week;
    progression.weekHarvests = progression.harvested;
    progression.weekOrders = progression.orders;
  }
  if (isProgressionCommand(command)) {
    applyProgression(state, command, now);
  } else if (command.type === 'recover') {
    requireRule(canRecoverFarm(state, now), 'RECOVERY_NOT_AVAILABLE');
    let plot = state.plots[0];
    if (!plot) {
      const freeCell = Array.from({ length: 1024 }, (_, i) => ({
        x: 16 + (i % 32),
        y: 16 + Math.floor(i / 32),
      })).find(
        (cell) => !state.progression!.decorations.some((d) => d.x === cell.x && d.y === cell.y),
      );
      requireRule(!!freeCell, 'MAX_PLOTS');
      const preferred = !state.progression!.decorations.some((d) => d.x === 32 && d.y === 30)
        ? { x: 32, y: 30 }
        : freeCell;
      plot = {
        id: state.nextPlotId,
        x: preferred.x,
        y: preferred.y,
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
    plot.timing = plantingTiming(state, 'carrot');
  } else if (
    command.type === 'plant' ||
    command.type === 'harvest' ||
    command.type === 'clear' ||
    command.type === 'removeCrop' ||
    command.type === 'movePlot' ||
    command.type === 'removePlot'
  ) {
    const plot = state.plots.find((candidate) => candidate.id === command.plotId);
    requireRule(!!plot, 'PLOT_NOT_FOUND');
    if (command.type === 'removePlot') {
      state.plots = state.plots.filter((candidate) => candidate.id !== plot.id);
    } else if (command.type === 'movePlot') {
      requireRule(isPlantingCell(command.x, command.y), 'CELL_OUTSIDE_FIELD');
      requireRule(!(command.x === HOUSE_CELL.x && command.y === HOUSE_CELL.y), 'CELL_RESERVED');
      requireRule(
        !state.plots.some(
          (other) => other.id !== plot.id && other.x === command.x && other.y === command.y,
        ),
        'CELL_OCCUPIED',
      );
      requireRule(
        !state.progression!.decorations.some((d) => d.x === command.x && d.y === command.y),
        'CELL_OCCUPIED',
      );
      plot.x = command.x;
      plot.y = command.y;
    } else if (command.type === 'removeCrop') {
      requireRule(plot.kind === 'bed', 'CROP_REQUIRES_BED');
      requireRule(plot.cropId !== null, 'PLOT_EMPTY');
      plot.cropId = null;
      plot.plantedAt = null;
      plot.harvests = 0;
    } else if (command.type === 'clear') {
      requireRule(cropPhase(plot, now) === 'withered', 'CROP_NOT_WITHERED');
      plot.harvests = 0;
      plot.cropId = plot.kind === 'tree' ? 'apple' : null;
      plot.plantedAt = plot.kind === 'tree' ? now : null;
      if (plot.kind === 'tree') plot.timing = plantingTiming(state, 'apple');
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
      plot.timing = plantingTiming(state, crop.id);
    } else {
      requireRule(plot.cropId !== null && plot.plantedAt !== null, 'PLOT_EMPTY');
      const crop = CROPS.find((item) => item.id === plot.cropId)!;
      requireRule(cropPhase(plot, now) !== 'withered', 'CROP_WITHERED');
      requireRule(cropPhase(plot, now) === 'ready', 'CROP_NOT_READY');
      const reserve = ORDERS.find((o) => o.id === state.progression!.reserveOrderId);
      const wanted = reserve
        ? ((reserve.requires as Partial<Record<CropId, number>>)[crop.id] ?? 0)
        : 0;
      const held =
        command.destination === 'sell'
          ? Math.min(crop.harvestYield, Math.max(0, wanted - state.inventory[crop.id]))
          : crop.harvestYield;
      state.inventory[crop.id] += held;
      state.coins += (crop.harvestYield - held) * crop.sellPrice;
      state.xp += cropTiming(plot).rewardXp;
      state.progression!.harvested += 1;
      state.progression!.harvestedCrops[crop.id] += crop.harvestYield;
      if (plot.kind === 'tree') {
        plot.harvests = (plot.harvests + 1) % 3;
        plot.plantedAt = now;
        plot.timing = plantingTiming(state, 'apple');
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
    state.progression!.orders += 1;
  } else {
    requireRule(state.plots.length + state.progression!.storedPlots.length < 1024, 'MAX_PLOTS');
    requireRule(isPlantingCell(command.x, command.y), 'CELL_OUTSIDE_FIELD');
    requireRule(!(command.x === HOUSE_CELL.x && command.y === HOUSE_CELL.y), 'CELL_RESERVED');
    requireRule(
      !state.plots.some((plot) => plot.x === command.x && plot.y === command.y) &&
        !state.progression!.decorations.some((d) => d.x === command.x && d.y === command.y),
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
      ...(tree ? { timing: plantingTiming(state, 'apple') } : {}),
      harvests: 0,
    });
  }
  if (command.type === 'buyPlot' || command.type === 'buyTree') state.nextPlotId += 1;
  state.revision += 1;
  requireRule(FarmStateSchema.safeParse(state).success, 'PROGRESSION_LIMIT');
  return state;
}

export function cropTiming(plot: FarmState['plots'][number]) {
  if (plot.timing) return plot.timing;
  const old = {
    carrot: 3600,
    strawberry: 7200,
    tomato: 10800,
    sunflower: 14400,
    tulip: 21600,
    apple: 28800,
  };
  const seconds = plot.cropId ? old[plot.cropId] : 3600;
  return { growSeconds: seconds, harvestWindowSeconds: seconds, rewardXp: 10 };
}
function plantingTiming(state: FarmState, cropId: CropId) {
  const p = state.progression!;
  const crop = CROPS.find((c) => c.id === cropId)!;
  const tutorial = cropId === 'carrot' && p.tutorialPlantings < 2;
  if (tutorial) p.tutorialPlantings++;
  return {
    growSeconds: tutorial ? 45 : crop.growSeconds,
    harvestWindowSeconds: 129600,
    rewardXp: tutorial ? 5 : Math.max(1, Math.min(20, Math.floor(crop.growSeconds / 900))),
  };
}
export const QUESTS = [
  {
    id: 'first-harvest',
    name: 'Первый урожай',
    metric: 'harvested',
    target: 1,
    rewardCoins: 25,
    rewardXp: 40,
  },
  {
    id: 'garden-path',
    name: 'Свой сад',
    metric: 'decorations',
    target: 2,
    rewardCoins: 30,
    rewardXp: 40,
  },
  {
    id: 'first-order',
    name: 'Корзина для Алекса',
    metric: 'orders',
    target: 1,
    rewardCoins: 40,
    rewardXp: 50,
  },
  {
    id: 'growing-garden',
    name: 'Большой огород',
    metric: 'harvested',
    target: 15,
    rewardCoins: 60,
    rewardXp: 80,
  },
  {
    id: 'workshop',
    name: 'Своя мастерская',
    metric: 'stations',
    target: 1,
    rewardCoins: 60,
    rewardXp: 100,
  },
  {
    id: 'first-recipe',
    name: 'Первый рецепт',
    metric: 'produced',
    target: 1,
    rewardCoins: 70,
    rewardXp: 120,
  },
  {
    id: 'flower-yard',
    name: 'Цветочный двор',
    metric: 'decorations',
    target: 8,
    rewardCoins: 90,
    rewardXp: 150,
  },
  {
    id: 'almaty-garden',
    name: 'Сад Алматы',
    metric: 'orders',
    target: 15,
    rewardCoins: 120,
    rewardXp: 200,
  },
  {
    id: 'master',
    name: 'Мастер сада',
    metric: 'produced',
    target: 20,
    rewardCoins: 150,
    rewardXp: 250,
  },
  {
    id: 'cozy-home',
    name: 'Уютный дом',
    metric: 'level',
    target: 10,
    rewardCoins: 200,
    rewardXp: 0,
  },
] as const;
export function levelUnlocks(level: number) {
  return {
    decorations: DECORATIONS.filter((d) => d.unlockLevel <= level),
    recipes: RECIPES.filter((r) => r.unlockLevel <= level),
    stations: level >= 5 ? ['kitchen', 'florist'] : level >= 4 ? ['kitchen'] : [],
    houseStyles:
      level >= 8 ? ['classic', 'mint', 'sunshine'] : level >= 6 ? ['classic', 'mint'] : ['classic'],
  };
}
export function getProgression(state: FarmState) {
  return state.progression ?? { ...newProgression(), orders: state.completedOrders };
}
export function tutorialProgress(state: FarmState) {
  const p = getProgression(state);
  return {
    plantings: p.tutorialPlantings,
    harvested: p.harvested,
    complete: p.claimedQuests.includes('first-order'),
  };
}
export function questProgress(state: FarmState) {
  const p = getProgression(state);
  return QUESTS.map((q, index) => {
    const value =
      q.metric === 'decorations'
        ? p.decorations.length
        : q.metric === 'stations'
          ? p.stations.length
          : q.metric === 'level'
            ? levelForXp(state.xp)
            : p[q.metric];
    return {
      ...q,
      progress: Math.min(q.target, value),
      claimed: p.claimedQuests.includes(q.id),
      available: index === 0 || p.claimedQuests.includes(QUESTS[index - 1]!.id),
    };
  });
}
type ProgressionCommand = z.infer<(typeof ProgressionCommands)[number]>;
function isProgressionCommand(c: FarmCommand): c is ProgressionCommand {
  return ProgressionCommands.some((s) => s.shape.type.value === c.type);
}
function applyProgression(state: FarmState, c: ProgressionCommand, now: number) {
  const p = state.progression!;
  const level = levelForXp(state.xp);
  const free = (x: number, y: number, ignore?: number) => {
    requireRule(isPlantingCell(x, y), 'CELL_OUTSIDE_FIELD');
    requireRule(
      !state.plots.some((v) => v.x === x && v.y === y) &&
        !p.decorations.some((v) => v.id !== ignore && v.x === x && v.y === y),
      'CELL_OCCUPIED',
    );
  };
  const pay = (cost: number) => {
    requireRule(state.coins >= cost, 'INSUFFICIENT_COINS');
    state.coins -= cost;
  };
  if (c.type === 'setOrderReserve') {
    p.reserveOrderId = c.orderId;
  } else if (c.type === 'storePlot') {
    const plot = state.plots.find((v) => v.id === c.plotId);
    requireRule(!!plot, 'PLOT_NOT_FOUND');
    requireRule(plot.kind === 'tree' || plot.cropId === null, 'PLOT_NOT_EMPTY');
    const stored = {
      id: plot.id,
      kind: plot.kind,
      cropId: plot.cropId,
      plantedAt: plot.plantedAt,
      harvests: plot.harvests,
      ...(plot.timing ? { timing: plot.timing } : {}),
    };
    p.storedPlots.push(stored);
    state.plots = state.plots.filter((v) => v.id !== plot.id);
  } else if (c.type === 'placePlot') {
    const plot = p.storedPlots.find((v) => v.id === c.plotId);
    requireRule(!!plot, 'PLOT_NOT_STORED');
    free(c.x, c.y);
    state.plots.push({ ...plot, x: c.x, y: c.y });
    p.storedPlots = p.storedPlots.filter((v) => v.id !== plot.id);
  } else if (c.type === 'buyDecoration') {
    const d = DECORATIONS.find((v) => v.id === c.decorationId)!;
    requireRule(level >= d.unlockLevel, 'DECORATION_LOCKED');
    requireRule(p.decorations.length < 1024, 'MAX_DECORATIONS');
    free(c.x, c.y);
    pay(d.cost);
    p.decorations.push({ id: p.nextDecorationId++, decorationId: d.id, x: c.x, y: c.y });
  } else if (
    c.type === 'moveDecoration' ||
    c.type === 'placeDecoration' ||
    c.type === 'storeDecoration'
  ) {
    const d = p.decorations.find((v) => v.id === c.instanceId);
    requireRule(!!d, 'DECORATION_NOT_FOUND');
    if (c.type === 'storeDecoration') {
      requireRule(d.x !== null, 'DECORATION_NOT_PLACED');
      d.x = null;
      d.y = null;
    } else {
      if (c.type === 'placeDecoration') requireRule(d.x === null, 'DECORATION_ALREADY_PLACED');
      free(c.x, c.y, d.id);
      d.x = c.x;
      d.y = c.y;
    }
  } else if (c.type === 'setHouseStyle') {
    requireRule(
      c.style === 'classic' || level >= (c.style === 'mint' ? 6 : 8),
      'HOUSE_STYLE_LOCKED',
    );
    p.houseStyle = c.style;
  } else if (c.type === 'buyStation') {
    requireRule(level >= (c.stationId === 'kitchen' ? 4 : 5), 'STATION_LOCKED');
    requireRule(!p.stations.some((v) => v.id === c.stationId), 'STATION_OWNED');
    pay(c.stationId === 'kitchen' ? 120 : 150);
    p.stations.push({ id: c.stationId, queue: [] });
  } else if (c.type === 'startProduction') {
    const recipe = RECIPES.find((v) => v.id === c.recipeId)!;
    const station = p.stations.find((v) => v.id === recipe.stationId);
    requireRule(!!station, 'STATION_NOT_OWNED');
    requireRule(level >= recipe.unlockLevel, 'RECIPE_LOCKED');
    requireRule(station.queue.length < 3, 'QUEUE_FULL');
    const needs = Object.entries(recipe.requires) as [CropId, number][];
    requireRule(
      needs.every(([id, n]) => state.inventory[id] >= n),
      'INSUFFICIENT_INVENTORY',
    );
    for (const [id, n] of needs) state.inventory[id] -= n;
    station.queue.push({
      id: p.nextJobId++,
      recipeId: recipe.id,
      readyAt: Math.max(now, station.queue.at(-1)?.readyAt ?? now) + recipe.seconds * 1000,
    });
  } else if (c.type === 'collectProduction') {
    const station = p.stations.find((v) => v.id === c.stationId);
    const job = station?.queue.find((v) => v.id === c.jobId);
    requireRule(!!station && !!job, 'JOB_NOT_FOUND');
    requireRule(now >= job.readyAt, 'PRODUCTION_NOT_READY');
    const recipe = RECIPES.find((v) => v.id === job.recipeId)!;
    p.products[job.recipeId]++;
    p.produced++;
    state.xp += recipe.rewardXp;
    station.queue = station.queue.filter((v) => v.id !== job.id);
  } else if (c.type === 'sellProduct') {
    requireRule(p.products[c.recipeId] >= c.quantity, 'INSUFFICIENT_INVENTORY');
    p.products[c.recipeId] -= c.quantity;
    state.coins += RECIPES.find((v) => v.id === c.recipeId)!.sellPrice * c.quantity;
  } else if (c.type === 'claimQuest') {
    const q = questProgress(state).find((v) => v.id === c.questId);
    requireRule(!!q, 'QUEST_NOT_FOUND');
    requireRule(!q.claimed, 'REWARD_CLAIMED');
    requireRule(q.available && q.progress >= q.target, 'QUEST_NOT_READY');
    p.claimedQuests.push(q.id);
    state.coins += q.rewardCoins;
    state.xp += q.rewardXp;
    if (q.id === 'first-harvest')
      p.decorations.push({ id: p.nextDecorationId++, decorationId: 'path', x: null, y: null });
  } else if (c.type === 'claimGoal') {
    const day = Math.floor(now / 86400000);
    if (p.goalPeriod !== day) {
      p.goalPeriod = day;
      p.claimedGoals = p.claimedGoals.filter((v) => v.startsWith('weekly:'));
      p.goalHarvests = p.harvested;
      p.goalOrders = p.orders;
      p.goalProduced = p.produced;
    }
    const weekly = c.goalId === 'weekly-garden';
    const key = weekly ? `weekly:${Math.floor(day / 7)}` : c.goalId;
    requireRule(!p.claimedGoals.includes(key), 'REWARD_CLAIMED');
    const ready =
      c.goalId === 'daily-harvest'
        ? p.harvested - p.goalHarvests >= 3
        : c.goalId === 'daily-order'
          ? p.orders - p.goalOrders >= 1
          : c.goalId === 'daily-production'
            ? p.produced - p.goalProduced >= 1
            : p.harvested - (p.weekHarvests ?? 0) >= 20 && p.orders - (p.weekOrders ?? 0) >= 3;
    requireRule(ready, 'GOAL_NOT_READY');
    p.claimedGoals.push(key);
    if (weekly)
      p.claimedGoals = p.claimedGoals.filter((v) => !v.startsWith('weekly:') || v === key);
    state.coins += weekly ? 50 : 10;
    state.xp += weekly ? 60 : 20;
  }
}

export const LEVEL_XP = [0, 40, 100, 200, 350, 550, 800, 1100, 1500, 2000] as const;
export function goalProgress(state: FarmState, now: number) {
  integer.parse(now);
  const p = getProgression(state);
  const day = Math.floor(now / 86400000);
  const same = p.goalPeriod === day;
  const week = Math.floor(day / 7);
  const sameWeek = p.weekPeriod === week;
  return [
    {
      id: 'daily-harvest',
      name: 'Собрать 3 урожая',
      progress: same ? p.harvested - p.goalHarvests : 0,
      target: 3,
    },
    {
      id: 'daily-order',
      name: 'Выполнить заказ',
      progress: same ? p.orders - p.goalOrders : 0,
      target: 1,
    },
    {
      id: 'daily-production',
      name: 'Приготовить продукт',
      progress: same ? p.produced - p.goalProduced : 0,
      target: 1,
    },
    {
      id: 'weekly-garden',
      name: '20 урожаев и 3 заказа',
      progress: sameWeek
        ? Math.min(20, p.harvested - (p.weekHarvests ?? 0)) +
          Math.min(3, p.orders - (p.weekOrders ?? 0))
        : 0,
      target: 23,
    },
  ].map((g) => ({
    ...g,
    progress: Math.min(g.progress, g.target),
    claimed:
      p.claimedGoals.includes(g.id === 'weekly-garden' ? `weekly:${week}` : g.id) &&
      (g.id === 'weekly-garden' || same),
    rewardCoins: g.id === 'weekly-garden' ? 50 : 10,
    rewardXp: g.id === 'weekly-garden' ? 60 : 20,
  }));
}
