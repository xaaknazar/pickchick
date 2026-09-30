/** Local practice only. Fixed-step world units keep difficulty equal on every screen. */
export const RUN_WIDTH = 360;
export const RUN_DURATION = 45_000;
const STEP = 1000 / 120;
const GRAVITY = 1450;
const JUMP_SPEED = 610;
export type RunState = {
  elapsed: number;
  remainder: number;
  distance: number;
  y: number;
  velocity: number;
  buffer: number;
  lives: number;
  score: number;
  bestCombo: number;
  combo: number;
  shield: number;
  x: number;
  obstacle: number;
  passed: boolean;
  collected: boolean;
  seed: number;
  event: number;
  notice: string;
  over: boolean;
};
export function createRun(seed = 1): RunState {
  return {
    elapsed: 0,
    remainder: 0,
    distance: 0,
    y: 0,
    velocity: 0,
    buffer: 0,
    lives: 3,
    score: 0,
    bestCombo: 0,
    combo: 0,
    shield: 0,
    x: 440,
    obstacle: 0,
    passed: false,
    collected: false,
    seed: seed >>> 0,
    event: 0,
    notice: '',
    over: false,
  };
}
export function jumpRun(game: RunState): RunState {
  if (game.over) return game;
  return game.y === 0 ? { ...game, velocity: JUMP_SPEED, buffer: 0 } : { ...game, buffer: 120 };
}
function step(before: RunState): RunState {
  const g = { ...before };
  g.elapsed = Math.min(RUN_DURATION, g.elapsed + STEP);
  g.shield = Math.max(0, g.shield - STEP);
  g.buffer = Math.max(0, g.buffer - STEP);
  const speed = 205 + (75 * g.elapsed) / RUN_DURATION;
  const travel = (speed * STEP) / 1000;
  g.distance += travel;
  g.x -= travel;
  if (g.y > 0 || g.velocity > 0) {
    g.velocity -= (GRAVITY * STEP) / 1000;
    g.y = Math.max(0, g.y + (g.velocity * STEP) / 1000);
    if (g.y === 0) {
      g.velocity = g.buffer > 0 ? JUMP_SPEED : 0;
      g.buffer = 0;
    }
  }
  // Forgiving inner hit boxes. The feet, rather than the sprite's square, hit obstacles.
  const obstacleHeight = [32, 43, 37][g.obstacle % 3]!;
  if (!g.passed && !g.shield && g.x < 83 && g.x + 29 > 51 && g.y < obstacleHeight - 8) {
    g.lives--;
    g.combo = 0;
    g.shield = 1100;
    g.passed = true;
    g.event++;
    g.notice = g.lives ? 'Ещё шанс. Лови ритм!' : 'Новый пик впереди';
  }
  const foodX = g.x + 12;
  if (!g.collected && foodX < 94 && foodX > 40 && Math.abs(g.y + 22 - 103) < 31) {
    g.collected = true;
    g.combo++;
    g.bestCombo = Math.max(g.bestCombo, g.combo);
    const points = 10 + Math.min(3, Math.floor(g.combo / 3)) * 5;
    g.score += points;
    g.event++;
    g.notice = g.combo >= 3 ? `Серия ${g.combo} · +${points}` : `Вкусно! +${points}`;
  }
  if (!g.passed && g.x + 30 < 49) {
    g.passed = true;
    g.score += 5;
  }
  if (g.x < -55) {
    if (!g.collected) g.combo = 0;
    g.seed = (Math.imul(g.seed, 1664525) + 1013904223) >>> 0;
    g.x = RUN_WIDTH + 40 + (g.seed % 55);
    g.obstacle++;
    g.passed = false;
    g.collected = false;
  }
  g.over = g.lives <= 0 || g.elapsed >= RUN_DURATION - 0.001;
  return g;
}
export function advanceRun(game: RunState, delta: number): RunState {
  if (game.over || !Number.isFinite(delta) || delta <= 0) return game;
  let remaining = game.remainder + Math.min(100, delta),
    result = game;
  while (remaining + 0.000001 >= STEP && !result.over) {
    result = step(result);
    remaining -= STEP;
  }
  return { ...result, remainder: result.over ? 0 : Math.max(0, remaining) };
}
export function parseRunBest(raw: string | null): number {
  if (!raw || !/^[0-9]{1,7}$/.test(raw)) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= 1_000_000 ? value : 0;
}
