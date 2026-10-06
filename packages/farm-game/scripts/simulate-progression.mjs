import {
  createFarm,
  applyFarmCommand as run,
  cropPhase,
  CROPS,
  ORDERS,
  RECIPES,
  DECORATIONS,
  questProgress,
  goalProgress,
  levelForXp,
  nextLandCost,
  nextLandExpansion,
} from '../dist/index.js';
/** Server transitions for a modest mixed garden; no fabricated XP or money injections. */
export function simulateProgression({
  days = 90,
  intervalHours = 24,
  prioritizeProduction = false,
  absenceDay = null,
} = {}) {
  let state = createFarm(0);
  const milestones = {};
  let losses = 0,
    harvests = 0;
  const act = (c, now) => {
    try {
      state = run(state, c, now);
      return true;
    } catch {
      return false;
    }
  };
  for (let now = 0; now <= days * 86400000; now += intervalHours * 3600000) {
    if (absenceDay !== null && now >= absenceDay * 86400000 && now < (absenceDay + 3) * 86400000)
      continue;
    for (const s of [...(state.progression?.stations ?? [])])
      for (const j of [...s.queue])
        act({ type: 'collectProduction', stationId: s.id, jobId: j.id }, now);
    for (const p of [...state.plots]) {
      const phase = cropPhase(p, now);
      if (phase === 'ready') {
        act({ type: 'harvest', plotId: p.id }, now);
        harvests++;
      } else if (phase === 'withered') {
        act({ type: 'clear', plotId: p.id }, now);
        losses++;
      }
    }
    for (const q of questProgress(state))
      if (q.available && !q.claimed && q.progress >= q.target)
        act({ type: 'claimQuest', questId: q.id }, now);
    if (prioritizeProduction)
      for (const r of RECIPES) act({ type: 'startProduction', recipeId: r.id }, now);
    for (const o of ORDERS)
      while (Object.entries(o.requires).every(([id, n]) => state.inventory[id] >= n))
        act({ type: 'fulfill', orderId: o.id }, now);
    for (const id of ['kitchen', 'florist']) act({ type: 'buyStation', stationId: id }, now);
    for (const r of RECIPES) act({ type: 'startProduction', recipeId: r.id }, now);
    for (const r of RECIPES) {
      const n = state.progression.products[r.id];
      if (n) act({ type: 'sellProduct', recipeId: r.id, quantity: n }, now);
    }
    for (const c of CROPS) {
      const excess = Math.max(0, state.inventory[c.id] - 6);
      if (excess) act({ type: 'sell', cropId: c.id, quantity: excess }, now);
    }
    // v3 loop: daily reward, land, coop and chickens, the order board.
    act({ type: 'claimDaily' }, now);
    act({ type: 'collectAnimals', kind: 'chicken' }, now);
    act({ type: 'feedAnimals', kind: 'chicken' }, now);
    for (let slot = 0; slot < 3; slot++) act({ type: 'fulfillBoard', slot }, now);
    const land = nextLandExpansion(state);
    if (land && state.coins > land.cost + 300) act({ type: 'expandLand' }, now);
    if (state.coins > 400) act({ type: 'buyPen', pen: 'coop' }, now);
    if (state.coins > 300) act({ type: 'buyAnimal', kind: 'chicken' }, now);
    if (state.progression.goods?.egg > 6)
      act({ type: 'sellGood', good: 'egg', quantity: state.progression.goods.egg - 6 }, now);
    for (const g of goalProgress(state, now))
      if (!g.claimed && g.progress >= g.target) act({ type: 'claimGoal', goalId: g.id }, now);
    while (state.plots.length < 8 && state.coins >= nextLandCost(state, 'bed') + 80)
      if (!act({ type: 'buyPlot', x: 26 + state.nextPlotId, y: 26 }, now)) break;
    for (const p of state.plots)
      if (!p.cropId)
        act(
          {
            type: 'plant',
            plotId: p.id,
            cropId: ['carrot', 'tomato', 'strawberry', 'sunflower', 'tulip'][p.id % 5],
          },
          now,
        );
    while (state.progression.decorations.length < 8 && state.coins > 80) {
      const d = DECORATIONS[0];
      if (
        !act(
          {
            type: 'buyDecoration',
            decorationId: d.id,
            x: 26 + state.progression.decorations.length,
            y: 28,
          },
          now,
        )
      )
        break;
    }
    const level = levelForXp(state.xp);
    for (let i = 1; i <= level; i++) milestones[i] ??= now / 86400000;
  }
  return {
    days,
    intervalHours,
    prioritizeProduction,
    absenceDay,
    coins: state.coins,
    xp: state.xp,
    level: levelForXp(state.xp),
    plots: state.plots.length,
    harvests,
    losses,
    orders: state.completedOrders,
    produced: state.progression.produced,
    chapters: state.progression.claimedQuests.length,
    land: state.progression.land,
    chickens: state.progression.animals?.length ?? 0,
    eggs: state.progression.goods?.egg ?? 0,
    milestones,
  };
}
if (process.argv[1]?.endsWith('simulate-progression.mjs'))
  console.log(
    JSON.stringify(
      [
        simulateProgression({ intervalHours: 6 }),
        simulateProgression({ intervalHours: 24 }),
        simulateProgression({ intervalHours: 24, prioritizeProduction: true }),
        simulateProgression({ intervalHours: 24, prioritizeProduction: true, absenceDay: 10 }),
      ],
      null,
      2,
    ),
  );
