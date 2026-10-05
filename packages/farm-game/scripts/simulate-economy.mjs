import { pathToFileURL } from 'node:url';
import {
  createFarm,
  applyFarmCommand,
  canRecoverFarm,
  cropPhase,
  CROPS,
  nextLandCost,
} from '../dist/index.js';

/** Deterministic sessions, not a forecast of player retention or final economy acceptance. */
export function simulateEconomy({ days, intervalHours, cropId, reinvest = false }) {
  let state = createFarm(0);
  const crop = CROPS.find((item) => item.id === cropId);
  const stats = { harvests: 0, losses: 0, recoveries: 0, landSpend: 0 };
  const command = (input, now) => {
    state = applyFarmCommand(state, input, now);
  };
  const purchase = (now) => {
    const price = nextLandCost(state, 'bed');
    const id = state.nextPlotId;
    command({ type: 'buyPlot', x: 16 + (id % 32), y: 16 + Math.floor(id / 32) }, now);
    stats.landSpend += price;
    command({ type: 'plant', plotId: id, cropId }, now);
  };
  // Both strategies start with the same two working beds and retain a seed reserve.
  purchase(0);
  purchase(0);
  const interval = intervalHours * 3600000;
  for (let now = interval; now <= days * 86400000; now += interval) {
    for (const plot of [...state.plots]) {
      const phase = cropPhase(plot, now);
      if (phase === 'ready') {
        command({ type: 'harvest', plotId: plot.id, destination: 'sell' }, now);
        stats.harvests++;
      } else if (phase === 'withered') {
        command({ type: 'clear', plotId: plot.id }, now);
        stats.losses++;
      }
      const current = state.plots.find((item) => item.id === plot.id);
      if (current.cropId === null && state.coins >= crop.seedCost)
        command({ type: 'plant', plotId: plot.id, cropId }, now);
    }
    if (reinvest)
      while (state.coins >= nextLandCost(state, 'bed') + crop.seedCost * (state.plots.length + 1))
        purchase(now);
    if (canRecoverFarm(state, now)) {
      command({ type: 'recover' }, now);
      stats.recoveries++;
    }
  }
  return {
    days,
    intervalHours,
    cropId,
    reinvest,
    coins: state.coins,
    plots: state.plots.length,
    xp: state.xp,
    ...stats,
  };
}
export function economyScenarios() {
  return [1, 7, 30].flatMap((days) => [
    simulateEconomy({ days, intervalHours: 1, cropId: 'carrot' }),
    simulateEconomy({ days, intervalHours: 6, cropId: 'tulip' }),
    simulateEconomy({ days, intervalHours: 1, cropId: 'carrot', reinvest: true }),
    simulateEconomy({ days, intervalHours: 24, cropId: 'carrot', reinvest: true }),
  ]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${JSON.stringify(economyScenarios(), null, 2)}\n`);
