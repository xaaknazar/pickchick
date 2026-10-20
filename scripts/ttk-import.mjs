/** Import source TTK as production BOMs through audited backoffice commands.
 * Does not publish menu, create stock, change prices or enable sales consumption.
 * Preserve the private extractor JSON alongside the original workbooks.
 */
import { createHash } from 'node:crypto';
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const digest = (v) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const uuid = (v) => {
  const h = digest(v);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const norm = (v) => v.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
const units = { кг: ['g', 3], л: ['ml', 3], шт: ['pcs', 0], порц: ['pcs', 0] };
const assert = (value, message) => {
  if (!value) throw Error(message);
};
const text = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 200;
/** Exact decimal conversion. Never round an ingredient or infer a density. */
export function quantity(value, unit) {
  assert(Object.hasOwn(units, unit), 'Unknown unit');
  const s = String(value).replace(',', '.');
  assert(/^\d+(\.\d+)?$/.test(s), 'Invalid quantity');
  const [whole, fraction = ''] = s.split('.');
  const scale = units[unit][1];
  assert(!/[1-9]/.test(fraction.slice(scale)), 'Fractional minimal unit');
  const n =
    BigInt(whole) * 10n ** BigInt(scale) +
    BigInt(fraction.slice(0, scale).padEnd(scale, '0') || '0');
  assert(n <= 999999999999999n, 'Quantity exceeds API limit');
  return n.toString();
}
const key = (name, unit) => JSON.stringify([norm(name), unit]);
const finishedBatch = (value) => {
  const s = String(value);
  assert(/^\d+(\.\d+)?$/.test(s), 'Invalid finished mass');
  const [whole, fraction = ''] = s.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = (BigInt(whole) * denominator + BigInt(fraction || '0')) * 1000n;
  assert(numerator > 0n, 'Empty finished mass');
  const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
  const multiplier = denominator / gcd(numerator, denominator);
  assert(multiplier <= 1000n, 'Finished mass precision requires explicit review');
  return {
    multiplier,
    yieldQuantity: quantity(((numerator * multiplier) / denominator).toString(), 'шт'),
  };
};

export function prepare(input) {
  assert(
    input?.version === 1 && Array.isArray(input.sources) && input.sources.length > 0,
    'Invalid source',
  );
  assert(
    Array.isArray(input.recipes) && input.recipes.length > 0 && input.recipes.length <= 500,
    'Invalid cards',
  );
  assert(
    input.mass_yield_policy === undefined || input.mass_yield_policy === 'finished_weight',
    'Unknown mass yield policy',
  );
  const sources = new Map();
  for (const s of input.sources) {
    assert(
      text(s.file) && /^[a-f0-9]{64}$/.test(s.sha256) && !sources.has(s.file),
      'Invalid source hash',
    );
    sources.set(s.file, s.sha256);
  }
  const cards = [],
    codes = new Set(),
    outputs = new Map(),
    issues = [];
  for (const r of input.recipes) {
    assert(/^\d{1,12}$/.test(r.code) && !codes.has(r.code), 'Duplicate/invalid card code');
    codes.add(r.code);
    assert(
      text(r.name) && text(r.sheet) && Number.isInteger(r.row) && r.row > 0,
      'Invalid source location',
    );
    assert(sources.get(r.file) === r.sha256, 'Card source mismatch');
    assert(Array.isArray(r.lines) && r.lines.length <= 100, 'Invalid lines');
    const match = /^(\d+(?:[.,]\d+)?) (кг|л|шт|порц)$/.exec(r.batch);
    assert(match, 'Unknown batch format');
    const unit = match[2],
      yieldQuantity = quantity(match[1], unit);
    assert(BigInt(yieldQuantity) > 0n, 'Empty batch');
    assert(
      r.output?.unit === 'кг' && Number.isFinite(r.output.value) && r.output.value >= 0,
      'Invalid finished weight',
    );
    const card = { ...r, unit, yieldQuantity, multiplier: 1n, blocked: false };
    if (!r.lines.length) {
      issues.push({ code: r.code, reason: 'empty_card', file: r.file, row: r.row });
      continue;
    }
    // The source contains both a nominal batch and a finished weight. Do not choose silently.
    if (unit === 'кг' && Number(match[1].replace(',', '.')) !== r.output.value) {
      card.blocked = input.mass_yield_policy !== 'finished_weight';
      if (!card.blocked) Object.assign(card, finishedBatch(r.output.value));
      issues.push({
        code: r.code,
        reason: card.blocked ? 'yield_mismatch' : 'finished_weight_selected',
        batch: r.batch,
        output: r.output,
        source_batches: card.multiplier.toString(),
        file: r.file,
        row: r.row,
      });
    }
    assert(!outputs.has(key(r.name, unit)), 'Duplicate recipe output');
    outputs.set(key(r.name, unit), card);
    cards.push(card);
  }
  const ingredients = new Map();
  for (const card of cards) {
    ingredients.set('card:' + card.code, {
      key: 'card:' + card.code,
      name: `ТТК ${card.code}: ${card.name}`,
      unit: units[card.unit][0],
      active: !card.blocked,
      source: card,
    });
  }
  for (const card of cards) {
    card.dependencies = [];
    card.resolved = new Map();
    for (const line of card.lines) {
      assert(
        text(line.name) && Number.isInteger(line.row) && line.row > card.row,
        'Invalid ingredient source',
      );
      const q = quantity(line.quantity, line.unit);
      if (q === '0') {
        issues.push({
          code: card.code,
          reason: 'zero_line_omitted',
          row: line.row,
          name: line.name,
        });
        continue;
      }
      // Original unit is part of identity: one bottled water is not a prepared portion.
      const child = outputs.get(key(line.name, line.unit));
      assert(child || line.unit !== 'порц', 'Missing portion recipe');
      const k = child ? 'card:' + child.code : 'raw:' + key(line.name, line.unit);
      if (child) card.dependencies.push(child);
      if (!ingredients.has(k))
        ingredients.set(k, {
          key: k,
          name: line.name,
          unit: units[line.unit][0],
          active: true,
          source: card,
        });
      card.resolved.set(k, (card.resolved.get(k) ?? 0n) + BigInt(q));
    }
    assert(card.resolved.size > 0, 'No positive ingredient lines');
  }
  const visiting = new Set(),
    visited = new Set();
  const visit = (c) => {
    assert(!visiting.has(c.code), 'Recipe cycle');
    if (visited.has(c.code)) return;
    visiting.add(c.code);
    c.dependencies.forEach(visit);
    visiting.delete(c.code);
    visited.add(c.code);
  };
  cards.forEach(visit);
  return { cards, ingredients, issues };
}

export function planImport(input, snapshot, branch) {
  assert(snapshot.branch_id === branch && snapshot.role === 'manager', 'Scope mismatch');
  assert(
    Array.isArray(snapshot.records) && snapshot.records.length < (snapshot.limits?.records ?? 2000),
    'Incomplete snapshot',
  );
  const prepared = prepare(input),
    operations = [];
  const id = (k) => uuid([branch, 'ttk-v1', k]);
  const put = (kind, key, payload, source) => {
    assert(text(payload.name), 'Name exceeds API limit');
    const recordId = id(key);
    const old = snapshot.records.find((r) => r.id === recordId);
    assert(
      !old || (old.kind === kind && old.revision === 1 && digest(old.payload) === digest(payload)),
      'Imported record changed; explicit reconciliation required',
    );
    assert(
      !snapshot.records.some(
        (r) => r.id !== recordId && r.kind === kind && norm(r.payload.name) === norm(payload.name),
      ),
      'Existing name requires explicit mapping',
    );
    const reason = `ТТК ${source.code}; ${source.file}; ${source.sheet}!A${source.row}; SHA256 ${source.sha256}. Импорт состава, без остатков и цен.${input.mass_yield_policy === 'finished_weight' ? ` Массовый выход по итогу ТТК. Исходных партий: ${source.multiplier}.` : ''}`;
    const command = { type: 'save', kind, id: recordId, expected_revision: 0, payload };
    operations.push({
      body: { request_id: uuid([branch, digest(input), command]), reason, command },
      existing: Boolean(old),
    });
  };
  for (const [k, ingredient] of prepared.ingredients)
    put(
      'ingredient',
      k,
      {
        name: ingredient.name,
        unit: ingredient.unit,
        minimum: '0',
        active: ingredient.active,
      },
      ingredient.source,
    );
  for (const c of prepared.cards) {
    if (c.blocked) continue;
    put(
      'recipe',
      'recipe:' + c.code,
      {
        name: `ТТК ${c.code}: ${c.name}${c.multiplier > 1n ? ` (${c.multiplier} исходных партий)` : ''}`,
        product_id: 'ttk:' + c.code,
        output_ingredient_id: id('card:' + c.code),
        yield_quantity: c.yieldQuantity,
        lines: [...c.resolved].map(([k, n]) => ({
          ingredient_id: id(k),
          quantity: quantity((n * c.multiplier).toString(), 'шт'),
        })),
      },
      c,
    );
  }
  const summary = {
    source_cards: input.recipes.length,
    ingredients: prepared.ingredients.size,
    recipes: prepared.cards.filter((c) => !c.blocked).length,
    held: prepared.cards.filter((c) => c.blocked).map((c) => c.code),
    pending: operations.filter((o) => !o.existing).length,
  };
  return {
    hash: digest(operations.map((o) => o.body)),
    operations,
    summary,
    issues: prepared.issues,
  };
}

export async function runImport({ input, branch, request, apply = false, expectedPlan }) {
  const snapshot = await request(`branches/${branch}`);
  const plan = planImport(input, snapshot, branch);
  if (!apply) return { plan: plan.hash, ...plan.summary, issues: plan.issues };
  assert(plan.hash === expectedPlan, 'Plan changed; inspect preview');
  let saved = 0;
  for (const o of plan.operations) {
    if (o.existing) continue;
    await request(`branches/${branch}/commands`, o.body);
    saved++;
  }
  const after = await request(`branches/${branch}`);
  const verification = planImport(input, after, branch);
  assert(
    verification.hash === plan.hash && verification.summary.pending === 0,
    'Incomplete verification',
  );
  for (const r of snapshot.records) {
    const current = after.records.find((v) => v.id === r.id);
    assert(
      current && current.revision === r.revision && digest(current.payload) === digest(r.payload),
      'Pre-existing record changed; inspect audit',
    );
  }
  return { plan: plan.hash, saved, verified: true, ...verification.summary, issues: plan.issues };
}
