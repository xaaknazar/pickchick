/** Deterministic, local-only Pick Blocks rules. Scores are not loyalty balances. */
export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;
export const LOCK_DELAY_MS = 500;
export const MAX_LOCK_RESETS = 15;

export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
export type Point = { x: number; y: number };
export type Piece = Point & { kind: PieceKind; rotation: number };
export type GameState = {
  version: 1;
  board: (PieceKind | null)[][];
  active: Piece | null;
  next: PieceKind[];
  score: number;
  lines: number;
  level: number;
  over: boolean;
  piecesPlaced: number;
  lastClear: { id: number; count: number; rows: number[] } | null;
  rng: number;
  bag: PieceKind[];
  gravityMs: number;
  lockMs: number;
  lockResets: number;
};

const KINDS: readonly PieceKind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
const SHAPES: Record<PieceKind, readonly (readonly [number, number])[]> = {
  I: [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
  ],
  O: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  T: [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  S: [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
  ],
  Z: [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
  ],
  J: [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  L: [
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
};

// Clockwise SRS kick offsets; screen coordinates have positive Y downward.
// Each row is the transition from its rotation index to (index + 1) % 4.
// O does not rotate. Two hidden rows allow kicks at the ceiling.
const KICKS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [0, 0],
    [-1, 0],
    [-1, -1],
    [0, 2],
    [-1, 2],
  ],
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, -2],
    [1, -2],
  ],
  [
    [0, 0],
    [1, 0],
    [1, -1],
    [0, 2],
    [1, 2],
  ],
  [
    [0, 0],
    [-1, 0],
    [-1, 1],
    [0, -2],
    [-1, -2],
  ],
];
const I_KICKS: typeof KICKS = [
  [
    [0, 0],
    [-2, 0],
    [1, 0],
    [-2, 1],
    [1, -2],
  ],
  [
    [0, 0],
    [-1, 0],
    [2, 0],
    [-1, -2],
    [2, 1],
  ],
  [
    [0, 0],
    [2, 0],
    [-1, 0],
    [2, -1],
    [-1, 2],
  ],
  [
    [0, 0],
    [1, 0],
    [-2, 0],
    [1, 2],
    [-2, -1],
  ],
];

export function cells(piece: Piece): Point[] {
  const size = piece.kind === 'I' ? 4 : piece.kind === 'O' ? 2 : 3;
  return SHAPES[piece.kind].map(([column, row]) => {
    let x = column;
    let y = row;
    for (let turn = 0; turn < piece.rotation; turn += 1) {
      [x, y] = [size - 1 - y, x];
    }
    return { x: x + piece.x, y: y + piece.y };
  });
}

function fits(board: GameState['board'], piece: Piece): boolean {
  return cells(piece).every(
    ({ x, y }) =>
      x >= 0 && x < BOARD_WIDTH && y >= -2 && y < BOARD_HEIGHT && (y < 0 || board[y]?.[x] === null),
  );
}

function grounded(state: GameState): boolean {
  return state.active !== null && !fits(state.board, { ...state.active, y: state.active.y + 1 });
}

export function gravityIntervalMs(level: number): number {
  return Math.max(90, Math.round(850 * 0.82 ** (level - 1)));
}

function random(rng: number): number {
  let value = rng;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function draw(bag: PieceKind[], rng: number) {
  const remaining = [...bag];
  let nextRng = rng;
  if (remaining.length === 0) {
    remaining.push(...KINDS);
    for (let index = remaining.length - 1; index > 0; index -= 1) {
      nextRng = random(nextRng);
      const swap = Math.floor((nextRng / 0x1_0000_0000) * (index + 1));
      [remaining[index], remaining[swap]] = [remaining[swap]!, remaining[index]!];
    }
  }
  return { kind: remaining.shift()!, bag: remaining, rng: nextRng };
}

function spawn(state: GameState): GameState {
  const next = [...state.next];
  let bag = state.bag;
  let rng = state.rng;
  while (next.length < 4) {
    const drawn = draw(bag, rng);
    next.push(drawn.kind);
    bag = drawn.bag;
    rng = drawn.rng;
  }
  const kind = next.shift()!;
  const piece: Piece = { kind, rotation: 0, x: kind === 'O' ? 4 : 3, y: 0 };
  const over = !fits(state.board, piece);
  return {
    ...state,
    next,
    bag,
    rng,
    active: over ? null : piece,
    over,
    gravityMs: 0,
    lockMs: 0,
    lockResets: 0,
  };
}

export function createGame(seed: number): GameState {
  return spawn({
    version: 1,
    board: Array.from({ length: BOARD_HEIGHT }, () =>
      Array<PieceKind | null>(BOARD_WIDTH).fill(null),
    ),
    active: null,
    next: [],
    score: 0,
    lines: 0,
    level: 1,
    over: false,
    piecesPlaced: 0,
    lastClear: null,
    rng: (Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0) || 0x5049434b,
    bag: [],
    gravityMs: 0,
    lockMs: 0,
    lockResets: 0,
  });
}

export function ghostPiece(state: GameState): Piece | null {
  if (state.over || !state.active) return null;
  let piece = { ...state.active };
  while (fits(state.board, { ...piece, y: piece.y + 1 })) {
    piece = { ...piece, y: piece.y + 1 };
  }
  return piece;
}

function reposition(state: GameState, active: Piece): GameState {
  const reset = grounded(state) && state.lockResets < MAX_LOCK_RESETS;
  return {
    ...state,
    active,
    lockMs: reset ? 0 : state.lockMs,
    lockResets: state.lockResets + (reset ? 1 : 0),
  };
}

export function move(state: GameState, dx: -1 | 1): GameState {
  if (state.over || !state.active || (dx !== -1 && dx !== 1)) return state;
  const active = { ...state.active, x: state.active.x + dx };
  return fits(state.board, active) ? reposition(state, active) : state;
}

export function rotate(state: GameState): GameState {
  if (state.over || !state.active || state.active.kind === 'O') return state;
  const kicks = state.active.kind === 'I' ? I_KICKS : KICKS;
  for (const [x, y] of kicks[state.active.rotation]!) {
    const active = {
      ...state.active,
      rotation: (state.active.rotation + 1) % 4,
      x: state.active.x + x,
      y: state.active.y + y,
    };
    if (fits(state.board, active)) return reposition(state, active);
  }
  return state;
}

export function softDrop(state: GameState): GameState {
  if (state.over || !state.active) return state;
  const active = { ...state.active, y: state.active.y + 1 };
  return fits(state.board, active)
    ? { ...state, active, score: state.score + 1, gravityMs: 0 }
    : state;
}

function lock(state: GameState): GameState {
  if (!state.active) return state;
  const points = cells(state.active);
  // A piece locked above the visible well ends the game without partial writes.
  if (points.some(({ y }) => y < 0)) {
    return { ...state, over: true, active: null, gravityMs: 0, lockMs: 0, lockResets: 0 };
  }
  const board = state.board.map((row) => [...row]);
  for (const { x, y } of points) board[y]![x] = state.active.kind;
  const rows: number[] = [];
  const remaining = board.filter((row, index) => {
    const full = row.every((cell) => cell !== null);
    if (full) rows.push(index);
    return !full;
  });
  const count = rows.length;
  const lines = state.lines + count;
  const piecesPlaced = state.piecesPlaced + 1;
  const pointsForLines = [0, 100, 300, 500, 800][count]!;
  return spawn({
    ...state,
    board: [
      ...Array.from({ length: count }, () => Array<PieceKind | null>(BOARD_WIDTH).fill(null)),
      ...remaining,
    ],
    score: state.score + pointsForLines * state.level,
    lines,
    level: 1 + Math.floor(lines / 10),
    piecesPlaced,
    lastClear: count > 0 ? { id: piecesPlaced, count, rows } : state.lastClear,
  });
}

export function hardDrop(state: GameState): GameState {
  const active = ghostPiece(state);
  if (!active || !state.active) return state;
  return lock({ ...state, active, score: state.score + 2 * (active.y - state.active.y) });
}

/** Simulate at most one second; controller must pause when app/screen loses focus. */
export function tick(state: GameState, deltaMs: number): GameState {
  if (state.over || !state.active || !Number.isFinite(deltaMs) || deltaMs <= 0) return state;
  let remaining = Math.min(1000, deltaMs);
  let result = state;
  while (remaining > 0 && !result.over && result.active) {
    const onFloor = grounded(result);
    const interval = gravityIntervalMs(result.level);
    const step = Math.min(
      remaining,
      interval - result.gravityMs,
      onFloor ? LOCK_DELAY_MS - result.lockMs : Infinity,
    );
    result = {
      ...result,
      gravityMs: result.gravityMs + step,
      lockMs: result.lockMs + (onFloor ? step : 0),
    };
    remaining -= step;
    if (onFloor && result.lockMs >= LOCK_DELAY_MS) {
      result = lock(result);
    } else if (result.gravityMs >= interval && result.active) {
      const active = { ...result.active, y: result.active.y + 1 };
      result = {
        ...result,
        gravityMs: 0,
        active: fits(result.board, active) ? active : result.active,
      };
    }
  }
  return result;
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every(
      (key) =>
        typeof key === 'string' &&
        keys.includes(key) &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}

function array(value: unknown, min: number, max = min): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < min ||
    value.length > max
  )
    return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === value.length + 1 &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        (key === 'length' || /^(0|[1-9]\d*)$/.test(key)) &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function kind(value: unknown): value is PieceKind {
  return typeof value === 'string' && KINDS.includes(value as PieceKind);
}

function timer(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < max;
}

/** Reject incompatible/corrupt snapshots, including extra keys, prototypes and accessors. */
export function parseGame(value: unknown): GameState | null {
  try {
    if (
      !record(value, [
        'version',
        'board',
        'active',
        'next',
        'score',
        'lines',
        'level',
        'over',
        'piecesPlaced',
        'lastClear',
        'rng',
        'bag',
        'gravityMs',
        'lockMs',
        'lockResets',
      ]) ||
      value.version !== 1 ||
      !array(value.board, BOARD_HEIGHT) ||
      !value.board.every(
        (row) =>
          array(row, BOARD_WIDTH) &&
          row.some((cell) => cell === null) &&
          row.every((cell) => cell === null || kind(cell)),
      ) ||
      !array(value.next, 3) ||
      !value.next.every(kind) ||
      !array(value.bag, 0, 7) ||
      !value.bag.every(kind) ||
      new Set(value.bag).size !== value.bag.length ||
      // Even multi-year sessions remain far below these bounds. Leave ample
      // safe-integer headroom for arithmetic on untrusted persisted counters.
      !integer(value.score, 0, 1_000_000_000_000) ||
      !integer(value.lines, 0, 4_000_000_000) ||
      !integer(value.level, 1) ||
      value.level !== 1 + Math.floor(value.lines / 10) ||
      !integer(value.piecesPlaced, 0, 1_000_000_000) ||
      value.lines > value.piecesPlaced * 4 ||
      typeof value.over !== 'boolean' ||
      !integer(value.rng, 1, 0xffff_ffff) ||
      !timer(value.gravityMs, gravityIntervalMs(value.level)) ||
      !timer(value.lockMs, LOCK_DELAY_MS) ||
      !integer(value.lockResets, 0, MAX_LOCK_RESETS)
    )
      return null;
    const board = (value.board as GameState['board']).map((row) => [...row]);
    let active: Piece | null = null;
    if (value.active !== null) {
      const piece = value.active;
      if (
        !record(piece, ['kind', 'rotation', 'x', 'y']) ||
        !kind(piece.kind) ||
        !integer(piece.rotation, 0, 3) ||
        (piece.kind === 'O' && piece.rotation !== 0) ||
        !integer(piece.x, -4, BOARD_WIDTH - 1) ||
        !integer(piece.y, -4, BOARD_HEIGHT - 1)
      )
        return null;
      active = { kind: piece.kind, rotation: piece.rotation, x: piece.x, y: piece.y };
      if (!fits(board, active)) return null;
    }
    if (value.over !== (active === null)) return null;
    let lastClear: GameState['lastClear'] = null;
    if (value.lines > 0 && value.lastClear === null) return null;
    if (value.lastClear !== null) {
      const clear = value.lastClear;
      if (
        !record(clear, ['id', 'count', 'rows']) ||
        !integer(clear.id, 1, value.piecesPlaced) ||
        !integer(clear.count, 1, 4) ||
        clear.count > value.lines ||
        !array(clear.rows, clear.count) ||
        !clear.rows.every((row) => integer(row, 0, BOARD_HEIGHT - 1))
      )
        return null;
      const rows = clear.rows as number[];
      if (rows.some((row, index) => index > 0 && row <= rows[index - 1]!)) return null;
      lastClear = { id: clear.id, count: clear.count, rows: [...rows] };
    }
    return {
      version: 1,
      board,
      active,
      next: [...value.next],
      score: value.score,
      lines: value.lines,
      level: value.level,
      over: value.over,
      piecesPlaced: value.piecesPlaced,
      lastClear,
      rng: value.rng,
      bag: [...value.bag],
      gravityMs: value.gravityMs,
      lockMs: value.lockMs,
      lockResets: value.lockResets,
    };
  } catch {
    return null;
  }
}
