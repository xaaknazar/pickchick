export const COLORS = ['yellow', 'ivory', 'taupe', 'orange', 'rose', 'wine'] as const;
export const ACTIVE_COLORS = ['yellow', 'ivory', 'orange', 'wine'] as const;
export type Color = (typeof COLORS)[number];
export const BOTTLE_COUNT = 24;
export const SMALL_CAPACITY = 4;
export const COLLECTOR_CAPACITY = 16;
export const COLLECTOR_INDEX = 24;
export const MAX_MOVES = 1024;
export type Move = { from: number; to: number };
export type GameState = {
  version: 1 | 2;
  seed: number;
  bottles: Color[][];
  collector: Color[];
  history: Move[];
  witness: Move[];
};
export function isSealed(bottle: readonly Color[]): boolean {
  return (
    bottle.length === SMALL_CAPACITY &&
    bottle[0] !== 'yellow' &&
    bottle.every((c) => c === bottle[0])
  );
}
function transfer(state: GameState, from: number, to: number): GameState | null {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= BOTTLE_COUNT ||
    to < 0 ||
    to > COLLECTOR_INDEX ||
    from === to
  )
    return null;
  const source = state.bottles[from]!;
  const target = to === COLLECTOR_INDEX ? state.collector : state.bottles[to]!;
  if (!source.length || isSealed(source) || (to !== COLLECTOR_INDEX && isSealed(target)))
    return null;
  const color = source[source.length - 1]!;
  if (
    to === COLLECTOR_INDEX
      ? color !== 'yellow'
      : target.length > 0 && target[target.length - 1] !== color
  )
    return null;
  const space = (to === COLLECTOR_INDEX ? COLLECTOR_CAPACITY : SMALL_CAPACITY) - target.length;
  if (space <= 0) return null;
  let run = 1;
  while (run < source.length && source[source.length - 1 - run] === color) run++;
  const count = Math.min(run, space);
  const bottles = state.bottles.map((b) => [...b]);
  bottles[from]!.splice(source.length - count, count);
  const collector = [...state.collector];
  (to === COLLECTOR_INDEX ? collector : bottles[to]!).push(...Array<Color>(count).fill(color));
  return { ...state, bottles, collector };
}
export function pour(state: GameState, from: number, to: number): GameState | null {
  if (state.history.length >= MAX_MOVES) return null;
  const next = transfer(state, from, to);
  return next ? { ...next, history: [...state.history, { from, to }] } : null;
}
export type BottleTap =
  | { kind: 'select'; index: number }
  | { kind: 'deselect' }
  | { kind: 'blocked' }
  | { kind: 'pour'; from: number; to: number; next: GameState };

export function resolveBottleTap(
  state: GameState,
  selected: number | null,
  index: number,
): BottleTap {
  if (selected === index) return { kind: 'deselect' };
  if (selected !== null) {
    const next = pour(state, selected, index);
    if (next) return { kind: 'pour', from: selected, to: index, next };
  }
  const bottle = state.bottles[index];
  if (Number.isInteger(index) && bottle?.length && !isSealed(bottle))
    return { kind: 'select', index };
  return { kind: 'blocked' };
}

function generateV1(seed: number): GameState {
  seed = Number.isSafeInteger(seed) ? seed >>> 0 : 1;
  let random = seed || 0x9e3779b9;
  const next = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return random >>> 0;
  };
  // Construct independently solvable crossing pairs. Each pair uses one buffer:
  // A=[c,c,d,d], B=[d,d,c,c]; A→buffer, B→A, B→buffer.
  const edges: [Color, Color][] = [
    ['ivory', 'taupe'],
    ['taupe', 'orange'],
    ['orange', 'rose'],
    ['rose', 'wine'],
    ['wine', 'ivory'],
    ['ivory', 'orange'],
    ['orange', 'rose'],
    ['rose', 'wine'],
    ['wine', 'ivory'],
  ];
  const bottles: Color[][] = [];
  for (const edge of edges) {
    const [c, d] = next() % 2 ? edge : ([edge[1], edge[0]] as [Color, Color]);
    bottles.push([c, c, d, d], [d, d, c, c]);
  }
  for (let i = 0; i < 4; i++) bottles.push(['yellow', 'yellow', 'yellow', 'yellow']);
  bottles.push([], []);
  const permutation = Array.from({ length: BOTTLE_COUNT }, (_, i) => i);
  for (let i = BOTTLE_COUNT - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [permutation[i], permutation[j]] = [permutation[j]!, permutation[i]!];
  }
  const location = (original: number) => permutation.indexOf(original);
  const witness: Move[] = [];
  for (let i = 18; i < 22; i++) witness.push({ from: location(i), to: COLLECTOR_INDEX });
  let buffer = location(22);
  for (let i = 0; i < 18; i += 2) {
    const a = location(i),
      b = location(i + 1);
    witness.push({ from: a, to: buffer }, { from: b, to: a }, { from: b, to: buffer });
    buffer = b;
  }
  let state: GameState = {
    version: 1,
    seed,
    bottles: permutation.map((i) => bottles[i]!),
    collector: [],
    history: [],
    witness,
  };
  // Reverse a legal forward pour, accepting only exact maximal-run inverses.
  // Unlike an arbitrary shuffle, every accepted board retains a solution.
  const inverse: Move[] = [];
  // Establish a buried yellow before random scrambling, using exact inverse checks.
  for (const [donor, receiver] of [
    [location(18), location(22)],
    [location(0), location(22)],
  ]) {
    const mixed = state.bottles.map((b) => [...b]);
    const color = mixed[donor!]!.pop()!;
    mixed[receiver!]!.push(color);
    const candidate = { ...state, bottles: mixed };
    const restored = transfer(candidate, receiver!, donor!);
    if (!restored || JSON.stringify(restored.bottles) !== JSON.stringify(state.bottles))
      throw new Error('Invalid initial scramble');
    inverse.push({ from: receiver!, to: donor! });
    state = candidate;
  }
  const buriedYellow = (board: Color[][]) =>
    board.some((b) => b.includes('yellow') && b[b.length - 1] !== 'yellow');
  const target = 90 + (next() % 51);
  const seen = new Set([JSON.stringify(state.bottles)]);
  for (let attempt = 0; attempt < 30_000 && inverse.length < target; attempt++) {
    const donor = next() % BOTTLE_COUNT,
      receiver = next() % BOTTLE_COUNT;
    if (donor === receiver) continue;
    const source = state.bottles[donor]!,
      destination = state.bottles[receiver]!;
    if (!source.length || destination.length >= SMALL_CAPACITY) continue;
    const color = source[source.length - 1]!;
    let run = 1;
    while (run < source.length && source[source.length - 1 - run] === color) run++;
    const count = 1 + (next() % Math.min(run, SMALL_CAPACITY - destination.length));
    const remaining = source.slice(0, -count);
    if (remaining.length && remaining[remaining.length - 1] !== color) continue;
    const mixed = state.bottles.map((b) => [...b]);
    mixed[donor] = remaining;
    mixed[receiver]!.push(...Array<Color>(count).fill(color));
    if (!buriedYellow(mixed)) continue;
    const signature = JSON.stringify(mixed);
    if (seen.has(signature)) continue;
    const candidate = { ...state, bottles: mixed };
    const restored = transfer(candidate, receiver, donor);
    if (!restored || JSON.stringify(restored.bottles) !== JSON.stringify(state.bottles)) continue;
    seen.add(signature);
    inverse.push({ from: receiver, to: donor });
    state = candidate;
  }
  state = { ...state, witness: [...inverse.reverse(), ...witness] };
  let verified = state;
  for (const move of state.witness) {
    const result = transfer(verified, move.from, move.to);
    if (!result) throw new Error('Invalid level witness');
    verified = result;
  }
  if (!isWon(verified)) throw new Error('Unsolved level witness');
  return state;
}
// Version1 is frozen above so existing saves retain their exact seeded board.
function generateV2(seed: number): GameState {
  seed = Number.isSafeInteger(seed) ? seed >>> 0 : 1;
  let random = seed || 0x9e3779b9;
  const next = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return random >>> 0;
  };
  // Construct independently solvable crossing pairs. Each pair uses one buffer:
  // A=[c,c,d,d], B=[d,d,c,c]; A→buffer, B→A, B→buffer.
  const edges: [Color, Color][] = Array.from(
    { length: 3 },
    () =>
      [
        ['ivory', 'orange'],
        ['orange', 'wine'],
        ['wine', 'ivory'],
      ] as [Color, Color][],
  ).flat();
  const bottles: Color[][] = [];
  for (const edge of edges) {
    const [c, d] = next() % 2 ? edge : ([edge[1], edge[0]] as [Color, Color]);
    bottles.push([c, c, d, d], [d, d, c, c]);
  }
  for (let i = 0; i < 4; i++) bottles.push(['yellow', 'yellow', 'yellow', 'yellow']);
  bottles.push([], []);
  const permutation = Array.from({ length: BOTTLE_COUNT }, (_, i) => i);
  for (let i = BOTTLE_COUNT - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [permutation[i], permutation[j]] = [permutation[j]!, permutation[i]!];
  }
  const location = (original: number) => permutation.indexOf(original);
  const witness: Move[] = [];
  for (let i = 18; i < 22; i++) witness.push({ from: location(i), to: COLLECTOR_INDEX });
  let buffer = location(22);
  for (let i = 0; i < 18; i += 2) {
    const a = location(i),
      b = location(i + 1);
    witness.push({ from: a, to: buffer }, { from: b, to: a }, { from: b, to: buffer });
    buffer = b;
  }
  let state: GameState = {
    version: 2,
    seed,
    bottles: permutation.map((i) => bottles[i]!),
    collector: [],
    history: [],
    witness,
  };
  // Reverse a legal forward pour, accepting only exact maximal-run inverses.
  // Unlike an arbitrary shuffle, every accepted board retains a solution.
  const inverse: Move[] = [];
  // Establish a buried yellow before random scrambling, using exact inverse checks.
  for (const [donor, receiver] of [
    [location(18), location(22)],
    [location(0), location(22)],
  ]) {
    const mixed = state.bottles.map((b) => [...b]);
    const color = mixed[donor!]!.pop()!;
    mixed[receiver!]!.push(color);
    const candidate = { ...state, bottles: mixed };
    const restored = transfer(candidate, receiver!, donor!);
    if (!restored || JSON.stringify(restored.bottles) !== JSON.stringify(state.bottles))
      throw new Error('Invalid initial scramble');
    inverse.push({ from: receiver!, to: donor! });
    state = candidate;
  }
  const buriedYellow = (board: Color[][]) =>
    board.some((b) => b.includes('yellow') && b[b.length - 1] !== 'yellow');
  const target = 90 + (next() % 51);
  const seen = new Set([JSON.stringify(state.bottles)]);
  for (let attempt = 0; attempt < 30_000 && inverse.length < target; attempt++) {
    const donor = next() % BOTTLE_COUNT,
      receiver = next() % BOTTLE_COUNT;
    if (donor === receiver) continue;
    const source = state.bottles[donor]!,
      destination = state.bottles[receiver]!;
    if (!source.length || destination.length >= SMALL_CAPACITY) continue;
    const color = source[source.length - 1]!;
    let run = 1;
    while (run < source.length && source[source.length - 1 - run] === color) run++;
    const count = 1 + (next() % Math.min(run, SMALL_CAPACITY - destination.length));
    const remaining = source.slice(0, -count);
    if (remaining.length && remaining[remaining.length - 1] !== color) continue;
    const mixed = state.bottles.map((b) => [...b]);
    mixed[donor] = remaining;
    mixed[receiver]!.push(...Array<Color>(count).fill(color));
    if (!buriedYellow(mixed)) continue;
    const signature = JSON.stringify(mixed);
    if (seen.has(signature)) continue;
    const candidate = { ...state, bottles: mixed };
    const restored = transfer(candidate, receiver, donor);
    if (!restored || JSON.stringify(restored.bottles) !== JSON.stringify(state.bottles)) continue;
    seen.add(signature);
    inverse.push({ from: receiver, to: donor });
    state = candidate;
  }
  state = { ...state, witness: [...inverse.reverse(), ...witness] };
  let verified = state;
  for (const move of state.witness) {
    const result = transfer(verified, move.from, move.to);
    if (!result) throw new Error('Invalid level witness');
    verified = result;
  }
  if (!isWon(verified)) throw new Error('Unsolved level witness');
  return state;
}
// Small immutable cache avoids regenerating the witness on every save and undo.
const levelCache = new Map<string, GameState>();
function copyLevel(state: GameState): GameState {
  return {
    ...state,
    bottles: state.bottles.map((b) => [...b]),
    collector: [...state.collector],
    history: state.history.map((m) => ({ ...m })),
    witness: state.witness.map((m) => ({ ...m })),
  };
}
export function createLevel(seed = 1, version: 1 | 2 = 2): GameState {
  const normalized = Number.isSafeInteger(seed) ? seed >>> 0 : 1;
  const key = version + ':' + normalized;
  let state = levelCache.get(key);
  if (!state) {
    state = version === 1 ? generateV1(normalized) : generateV2(normalized);
    levelCache.set(key, state);
    if (levelCache.size > 8) levelCache.delete(levelCache.keys().next().value!);
  }
  return copyLevel(state);
}
export function isWon(state: GameState): boolean {
  return (
    state.collector.length === COLLECTOR_CAPACITY &&
    state.bottles.every((b) => b.length === 0 || isSealed(b))
  );
}
export function resetLevel(state: GameState): GameState {
  return createLevel(state.seed, state.version);
}
export function newLevel(state: GameState, seed = (state.seed + 1) >>> 0): GameState {
  return createLevel(seed);
}
export function undo(state: GameState): GameState {
  let result = createLevel(state.seed, state.version);
  for (const move of state.history.slice(0, -1)) result = pour(result, move.from, move.to)!;
  return result;
}
export function legalMoves(state: GameState): Move[] {
  const moves: Move[] = [];
  for (let from = 0; from < BOTTLE_COUNT; from++)
    for (let to = 0; to <= COLLECTOR_INDEX; to++)
      if (transfer(state, from, to)) moves.push({ from, to });
  return moves;
}
export function hasMoves(state: GameState): boolean {
  return state.history.length < MAX_MOVES && legalMoves(state).length > 0;
}
export function getHint(state: GameState): { move: Move; source: 'witness' | 'suggestion' } | null {
  if (isWon(state) || state.history.length >= MAX_MOVES) return null;
  const prefix = state.history.every(
    (m, i) => m.from === state.witness[i]?.from && m.to === state.witness[i]?.to,
  );
  const next = prefix ? state.witness[state.history.length] : undefined;
  if (next && transfer(state, next.from, next.to)) return { move: next, source: 'witness' };
  const moves = legalMoves(state);
  const move =
    moves.find((m) => m.to === COLLECTOR_INDEX) ??
    moves.find((m) => isSealed(transfer(state, m.from, m.to)!.bottles[m.to]!)) ??
    moves[0];
  return move ? { move, source: 'suggestion' } : null;
}
/** Saves must be reachable from their seeded level, including sealed-bottle rules. */
export function parseGame(value: unknown): GameState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).sort().join(',') !== 'bottles,collector,history,seed,version,witness' ||
    (raw.version !== 1 && raw.version !== 2) ||
    !Number.isInteger(raw.seed) ||
    (raw.seed as number) < 0 ||
    (raw.seed as number) > 0xffffffff ||
    !Array.isArray(raw.history) ||
    raw.history.length > MAX_MOVES
  )
    return null;
  let state = createLevel(raw.seed as number, raw.version as 1 | 2);
  if (JSON.stringify(raw.witness) !== JSON.stringify(state.witness)) return null;
  for (const move of raw.history) {
    if (
      typeof move !== 'object' ||
      move === null ||
      Object.keys(move).sort().join(',') !== 'from,to'
    )
      return null;
    const next = pour(state, move.from, move.to);
    if (!next) return null;
    state = next;
  }
  if (
    JSON.stringify(raw.bottles) !== JSON.stringify(state.bottles) ||
    JSON.stringify(raw.collector) !== JSON.stringify(state.collector)
  )
    return null;
  return state;
}
