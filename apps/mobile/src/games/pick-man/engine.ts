/** Original PickChick maze. Pure fixed-step simulation; no rewards or network effects. */
export const MAZE = [
  '#################',
  '#...#.......#...#',
  '#.#.#.#####.#.#.#',
  '#.#...#...#...#.#',
  '#.###.#.#.#.###.#',
  '#.....#.#.#.....#',
  '###.#...#...#.###',
  '#...###...###...#',
  '#.#.....#.....#.#',
  '#.#.###.#.###.#.#',
  '#...............#',
  '#.#.###.#.###.#.#',
  '#.#.....#.....#.#',
  '#...###...###...#',
  '###.#...#...#.###',
  '#.....#.#.#.....#',
  '#.###.#.#.#.###.#',
  '#...#.......#...#',
  '#################',
] as const;
export const COLS = 17;
export const ROWS = MAZE.length;
export type Direction = 'up' | 'right' | 'down' | 'left';
export type Point = { x: number; y: number };
export type Actor = Point & { direction: Direction };
export type Food = 'burger' | 'fingers' | 'cola' | 'power';
export type MazeGame = {
  version: 1;
  player: Actor;
  desired: Direction;
  enemies: Actor[];
  remaining: number[];
  score: number;
  lives: number;
  level: number;
  ticks: number;
  remainder: number;
  power: number;
  shield: number;
  seed: number;
  status: 'playing' | 'won' | 'over';
};
export const VECTORS: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};
const DIRECTIONS = Object.keys(VECTORS) as Direction[];
const REVERSE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};
export const START: Actor = { x: 8, y: 10, direction: 'left' };
export const ENEMIES: Actor[] = [
  { x: 1, y: 1, direction: 'right' },
  { x: 15, y: 1, direction: 'left' },
  { x: 8, y: 17, direction: 'up' },
];
const powerIds = [3 * COLS + 1, 3 * COLS + 15, 17 * COLS + 1, 17 * COLS + 15];
export const cellId = ({ x, y }: Point) => y * COLS + x;
export const walkable = ({ x, y }: Point) =>
  Number.isInteger(x) && Number.isInteger(y) && MAZE[y]?.[x] === '.';
export const FOOD_IDS = MAZE.flatMap((row, y) =>
  [...row].flatMap((v, x) => (v === '.' && cellId(START) !== y * COLS + x ? [y * COLS + x] : [])),
);
export function foodKind(id: number): Food {
  return powerIds.includes(id) ? 'power' : (['burger', 'fingers', 'cola'] as const)[id % 3]!;
}
export const stepDuration = (level: number) => Math.max(115, 205 - (level - 1) * 9);
const nextPoint = (point: Point, direction: Direction): Actor => ({
  x: point.x + VECTORS[direction].x,
  y: point.y + VECTORS[direction].y,
  direction,
});
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
export function createMaze(seed = 1, level = 1, score = 0, lives = 3): MazeGame {
  return {
    version: 1,
    player: { ...START },
    desired: 'left',
    enemies: ENEMIES.map((e) => ({ ...e })),
    remaining: [...FOOD_IDS],
    score,
    lives,
    level,
    ticks: 0,
    remainder: 0,
    power: 0,
    shield: 14,
    seed: seed >>> 0,
    status: 'playing',
  };
}
export function turn(game: MazeGame, direction: Direction): MazeGame {
  return game.status === 'playing' && DIRECTIONS.includes(direction)
    ? { ...game, desired: direction }
    : game;
}

/** Shortest-path distances make enemies navigate corridors rather than slide through walls. */
function distances(target: Point): Map<number, number> {
  const result = new Map([[cellId(target), 0]]);
  const queue = [target];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    for (const d of DIRECTIONS) {
      const n = nextPoint(p, d),
        id = cellId(n);
      if (walkable(n) && !result.has(id)) {
        result.set(id, result.get(cellId(p))! + 1);
        queue.push(n);
      }
    }
  }
  return result;
}
function enemyStep(enemy: Actor, target: Point, scared: boolean, offset: number): Actor {
  const options = DIRECTIONS.map((d) => nextPoint(enemy, d)).filter(walkable);
  const forward = options.filter((p) => p.direction !== REVERSE[enemy.direction]);
  const choices = forward.length ? forward : options;
  const distance = distances(target);
  const rotated = choices
    .slice(offset % choices.length)
    .concat(choices.slice(0, offset % choices.length));
  return (
    rotated.sort(
      (a, b) =>
        (scared ? -1 : 1) * ((distance.get(cellId(a)) ?? 999) - (distance.get(cellId(b)) ?? 999)),
    )[0] ?? enemy
  );
}
export function step(game: MazeGame): MazeGame {
  if (game.status !== 'playing') return game;
  const wanted = nextPoint(game.player, game.desired);
  const straight = nextPoint(game.player, game.player.direction);
  const player = walkable(wanted) ? wanted : walkable(straight) ? straight : game.player;
  const eaten = game.remaining.includes(cellId(player));
  const remaining = eaten ? game.remaining.filter((id) => id !== cellId(player)) : game.remaining;
  const kind = foodKind(cellId(player));
  const power = eaten && kind === 'power' ? 42 : Math.max(0, game.power - 1);
  let score =
    game.score +
    (eaten ? (kind === 'power' ? 50 : kind === 'burger' ? 30 : kind === 'fingers' ? 20 : 10) : 0);
  const ticks = game.ticks + 1;
  const seed = (Math.imul(game.seed, 1664525) + 1013904223) >>> 0;
  const enemies = game.enemies.map((enemy, i) => {
    // Each rival gets regular rest steps; frightened rivals are slower still.
    if ((ticks + i) % (power ? 2 : game.level < 4 ? 3 : 4) === 0) return enemy;
    const ahead = nextPoint(player, player.direction);
    const target = i === 1 && walkable(ahead) ? ahead : i === 2 && ticks % 40 < 12 ? START : player;
    return enemyStep(enemy, target, power > 0, seed + i);
  });
  let hit = false;
  for (let i = 0; i < enemies.length; i++) {
    const collision =
      same(player, enemies[i]!) ||
      same(player, game.enemies[i]!) ||
      (same(game.player, enemies[i]!) && same(player, game.enemies[i]!));
    if (!collision) continue;
    if (power) {
      enemies[i] = { ...ENEMIES[i]! };
      score += 200;
    } else if (!game.shield) hit = true;
  }
  const lives = game.lives - (hit ? 1 : 0);
  return {
    ...game,
    player: hit ? { ...START } : player,
    desired: hit ? 'left' : game.desired,
    enemies: hit ? ENEMIES.map((e) => ({ ...e })) : enemies,
    remaining,
    score,
    lives,
    ticks,
    power: hit ? 0 : power,
    shield: hit ? 14 : Math.max(0, game.shield - 1),
    seed,
    status: lives <= 0 ? 'over' : remaining.length === 0 ? 'won' : 'playing',
  };
}
export function advance(game: MazeGame, delta: number): MazeGame {
  if (!Number.isFinite(delta) || delta <= 0 || game.status !== 'playing') return game;
  let remainder = game.remainder + Math.min(delta, 500),
    result = game;
  const duration = stepDuration(game.level);
  while (remainder >= duration && result.status === 'playing') {
    result = step(result);
    remainder -= duration;
  }
  return { ...result, remainder: result.status === 'playing' ? remainder : 0 };
}
export function nextLevel(game: MazeGame): MazeGame {
  return game.status === 'won'
    ? createMaze(game.seed, Math.min(99, game.level + 1), game.score + 500, game.lives)
    : game;
}
export function parseMaze(value: unknown): MazeGame | null {
  if (!value || typeof value !== 'object') return null;
  const g = value as MazeGame;
  const integer = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  const actor = (v: unknown): v is Actor =>
    Boolean(
      v &&
      typeof v === 'object' &&
      walkable(v as Point) &&
      DIRECTIONS.includes((v as Actor).direction),
    );
  if (
    g.version !== 1 ||
    !actor(g.player) ||
    !DIRECTIONS.includes(g.desired) ||
    !Array.isArray(g.enemies) ||
    g.enemies.length !== 3 ||
    !g.enemies.every(actor) ||
    !Array.isArray(g.remaining) ||
    g.remaining.length > FOOD_IDS.length ||
    new Set(g.remaining).size !== g.remaining.length ||
    !g.remaining.every((id) => FOOD_IDS.includes(id)) ||
    !integer(g.level, 1, 99) ||
    !integer(g.score, 0, 100000000) ||
    !integer(g.lives, 0, 3) ||
    !integer(g.ticks, 0, 100000000) ||
    !integer(g.seed, 0, 0xffffffff) ||
    !integer(g.power, 0, 42) ||
    !integer(g.shield, 0, 14) ||
    typeof g.remainder !== 'number' ||
    !Number.isFinite(g.remainder) ||
    g.remainder < 0 ||
    g.remainder >= stepDuration(g.level) ||
    !['playing', 'won', 'over'].includes(g.status) ||
    (g.status === 'over') !== (g.lives === 0) ||
    (g.status === 'won' && g.remaining.length !== 0) ||
    (g.status === 'playing' && !g.remaining.length)
  )
    return null;
  return {
    version: 1,
    player: { ...g.player },
    desired: g.desired,
    enemies: g.enemies.map((e) => ({ ...e })),
    remaining: [...g.remaining],
    score: g.score,
    lives: g.lives,
    level: g.level,
    ticks: g.ticks,
    remainder: g.remainder,
    power: g.power,
    shield: g.shield,
    seed: g.seed,
    status: g.status,
  };
}
