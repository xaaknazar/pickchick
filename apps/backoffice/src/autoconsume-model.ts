/*
 * «Списание по продажам» (lane bo-ui step 5; design-bo-ui 5.3, 5.5; design-backoffice 5): pure
 * helpers of the cabinet. Menu-stock links come with capabilities.stock_p1 (GET .../ops/
 * menu-links), the branch mode, the queue and the coverage with capabilities.stock_autoconsume
 * (GET .../ops/consumption). Every text is Russian, quantities in the base unit of the stock item.
 */
import { almatyDateTime } from './ui-fixes.js';

/** «2 шт», «0,24 кг», «1,5 л» (the inventory-model format; kept here so the models stay acyclic). */
export function displayQuantity(value: unknown, base: unknown) {
  const n = BigInt(String(value ?? 0));
  if (base !== 'g' && base !== 'ml') return `${n.toLocaleString('ru-RU')} шт`;
  const a = n < 0n ? -n : n;
  const fraction = (a % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${(a / 1000n).toLocaleString('ru-RU')}${fraction ? ',' + fraction : ''} ${base === 'g' ? 'кг' : 'л'}`;
}

type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.map(object) : []);

export type AutoconsumeMode = 'off' | 'dry_run' | 'on';
export type ConsumptionSettings = {
  autoconsume_mode: AutoconsumeMode;
  start_at: string | null;
  revision: number;
  updated_by_name: string | null;
  updated_at: string | null;
};
export type Coverage = {
  days: number;
  sold_lines: number;
  linked_lines: number;
  share_bp: number | null;
  missing: { catalog_key: string; name: string | null; lines: number }[];
  truncated: boolean;
};
/**
 * Review BOUI-R2: sales the worker should have handled and has not (GET .../ops/consumption and
 * stock_settings of GET branches/:id). Absent on an older server.
 */
export type ConsumptionBacklog = {
  not_queued: number;
  waiting: number;
  since: string | null;
  stalled: boolean;
};
export function backlogOf(value: unknown): ConsumptionBacklog | null {
  const b = object(value);
  if (typeof b['stalled'] !== 'boolean') return null;
  return {
    not_queued: Number(b['not_queued'] ?? 0),
    waiting: Number(b['waiting'] ?? 0),
    since: typeof b['since'] === 'string' ? b['since'] : null,
    stalled: b['stalled'],
  };
}
const almatyDay = (value: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date(value));
/** «14:05» on the same Almaty day as `asOf`, otherwise «18.11.2026 23:40». */
function sinceText(since: string, asOf: string) {
  const full = almatyDateTime(since);
  return almatyDay(since) === almatyDay(asOf) ? full.slice(-5) : full;
}
const sales = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? 'продажа не обработана'
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)
      ? 'продажи не обработаны'
      : 'продаж не обработаны';
/**
 * «Списание по продажам не работает: 3 продажи не обработаны с 14:05. …» while the worker does
 * not keep up, or null. Shown on the stock page, in «Списание по продажам» and in the manager
 * shift check, so a quiet queue never reads as a healthy one.
 */
export function stallText(
  backlog: ConsumptionBacklog | null,
  mode: AutoconsumeMode,
  asOf: string,
): string | null {
  if (!backlog?.stalled || mode === 'off') return null;
  const n = backlog.not_queued + backlog.waiting;
  const since = backlog.since ? ` с ${sinceText(backlog.since, asOf)}` : '';
  return mode === 'dry_run'
    ? `Проверка продаж по связям не работает: ${n} ${sales(n)}${since}. Сообщите владельцу: служба списания на сервере не запущена.`
    : `Списание по продажам не работает: ${n} ${sales(n)}${since}. Остатки по этим продажам не уменьшаются. Сообщите владельцу: служба списания на сервере не запущена.`;
}
export type ConsumptionView = {
  settings: ConsumptionSettings;
  /** Review BOUI-R2; null from an older server. */
  backlog: ConsumptionBacklog | null;
  /** GET .../ops/consumption as_of (the moment the backlog was computed). */
  as_of: string;
  items: Data[];
  counts: Record<string, number>;
  coverage: Coverage;
  truncated: boolean;
};
export const CONSUMPTION_STATES = [
  'blocked',
  'pending',
  'previewed',
  'applied',
  'skipped',
  'not_required',
] as const;
const MODES: readonly AutoconsumeMode[] = ['off', 'dry_run', 'on'];
/** GET .../ops/consumption of this branch, checked before the screen trusts it. */
export function consumptionView(value: unknown, branch: string): ConsumptionView {
  const o = object(value);
  const s = object(o['settings']);
  const c = object(o['coverage']);
  if (
    o['schema_version'] !== 1 ||
    o['branch_id'] !== branch ||
    !MODES.includes(s['autoconsume_mode'] as AutoconsumeMode) ||
    !Array.isArray(o['items'])
  )
    throw new Error('INVALID_RESPONSE');
  const counts = object(o['counts']);
  return {
    settings: {
      autoconsume_mode: s['autoconsume_mode'] as AutoconsumeMode,
      start_at: typeof s['start_at'] === 'string' ? s['start_at'] : null,
      revision: Number(s['revision'] ?? 0),
      updated_by_name: typeof s['updated_by_name'] === 'string' ? s['updated_by_name'] : null,
      updated_at: typeof s['updated_at'] === 'string' ? s['updated_at'] : null,
    },
    backlog: backlogOf(o['backlog']),
    as_of: typeof o['as_of'] === 'string' ? o['as_of'] : new Date().toISOString(),
    items: list(o['items']),
    counts: Object.fromEntries(CONSUMPTION_STATES.map((k) => [k, Number(counts[k] ?? 0)])),
    coverage: {
      days: Number(c['days'] ?? 7),
      sold_lines: Number(c['sold_lines'] ?? 0),
      linked_lines: Number(c['linked_lines'] ?? 0),
      share_bp: typeof c['share_bp'] === 'number' ? c['share_bp'] : null,
      missing: list(c['missing']).map((m) => ({
        catalog_key: String(m['catalog_key']),
        name: typeof m['name'] === 'string' ? m['name'] : null,
        lines: Number(m['lines'] ?? 0),
      })),
      truncated: c['truncated'] === true,
    },
    truncated: object(o['truncated'])['items'] === true,
  };
}
export type MenuLinksView = {
  catalog: { version: number; published_at: string } | null;
  items: Data[];
  orphans: Data[];
  coverage: { items: number; linked: number; approved: number; without_link: number };
};
/** GET .../ops/menu-links of this branch. */
export function menuLinksView(value: unknown, branch: string): MenuLinksView {
  const o = object(value);
  if (o['schema_version'] !== 1 || o['branch_id'] !== branch || !Array.isArray(o['items']))
    throw new Error('INVALID_RESPONSE');
  const c = object(o['catalog']);
  const k = object(o['coverage']);
  return {
    catalog:
      o['catalog'] === null
        ? null
        : { version: Number(c['version']), published_at: String(c['published_at']) },
    items: list(o['items']),
    orphans: list(o['orphans']),
    coverage: {
      items: Number(k['items'] ?? 0),
      linked: Number(k['linked'] ?? 0),
      approved: Number(k['approved'] ?? 0),
      without_link: Number(k['without_link'] ?? 0),
    },
  };
}

// --------------------------------------------------------------------------- mode ----

export const MODE_LABELS: Record<AutoconsumeMode, string> = {
  off: 'Выключено',
  dry_run: 'Проверка без списания',
  on: 'Включено',
};
/** «Выключено», «Проверка без списания с 18.11.2026 21:00», «Включено с 19.11.2026 00:00». */
export function modeText(settings: Pick<ConsumptionSettings, 'autoconsume_mode' | 'start_at'>) {
  const mode = settings.autoconsume_mode;
  return mode === 'off' || !settings.start_at
    ? MODE_LABELS[mode]
    : `${MODE_LABELS[mode]} с ${almatyDateTime(settings.start_at)}`;
}
/** ISO time as the value of an <input type="datetime-local"> in Almaty time (UTC+5). */
export function almatyInput(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t + 5 * 3600000).toISOString().slice(0, 16);
}
/** An Almaty datetime-local value back to ISO UTC; Kazakhstan keeps UTC+5 all year since 2024. */
export function fromAlmatyInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const t = Date.parse(value + ':00+05:00');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
/** The stock_settings command of the mode dialog, or a Russian error. */
export function settingsCommand(
  current: Pick<ConsumptionSettings, 'revision'>,
  mode: AutoconsumeMode,
  startLocal: string,
): Data {
  const start = startLocal ? fromAlmatyInput(startLocal) : null;
  if (startLocal && !start) throw new Error('Проверьте дату и время начала.');
  if (mode !== 'off' && !start)
    throw new Error('Укажите, с какого момента продажи списываются (дата и время по Алматы).');
  return {
    type: 'stock_settings',
    autoconsume_mode: mode,
    start_at: start,
    expected_revision: current.revision,
  };
}
/** What the mode dialog says will happen. */
export function modeConsequence(mode: AutoconsumeMode, startLocal: string): string {
  const start = fromAlmatyInput(startLocal);
  const from = start ? ` с ${almatyDateTime(start)}` : '';
  if (mode === 'off')
    return 'Продажи перестанут списываться со склада. Уже проведённые документы останутся, их исправляют сторно.';
  if (mode === 'dry_run')
    return `Продажи${from} будут проверяться по связям без списания: остатки не меняются, в очереди видно, что списалось бы.`;
  return `Продажи${from} будут списываться со склада по утверждённым связям, по одному документу на заказ. Продажи до этого момента не списываются.`;
}

// ------------------------------------------------------------------------- coverage ----

/** «96,5 %» from basis points (10000 = 100 %). */
export const shareText = (bp: number | null) =>
  bp === null ? '-' : `${(Math.floor(bp / 10) / 10).toFixed(1).replace('.', ',')} %`;
export const COVERAGE_MIN_BP = 9500;
export const coverageLow = (coverage: Coverage) =>
  coverage.share_bp !== null && coverage.share_bp < COVERAGE_MIN_BP;
export function coverageText(coverage: Coverage): string {
  if (coverage.sold_lines === 0)
    return `За ${coverage.days} дней продаж нет: покрытие не посчитать.`;
  return `Покрытие за ${coverage.days} дней: ${shareText(coverage.share_bp)} строк продаж со связью (${coverage.linked_lines} из ${coverage.sold_lines}).`;
}
export function coverageWarning(coverage: Coverage): string | null {
  if (!coverageLow(coverage)) return null;
  const top = coverage.missing
    .slice(0, 5)
    .map((m) => `${m.name ?? m.catalog_key} (${m.lines})`)
    .join(', ');
  return `Покрытие ниже 95 %: включать списание рано${top ? `. Без связи чаще всего: ${top}` : ''}.`;
}

// ---------------------------------------------------------------------------- queue ----

export const STATE_LABELS: Record<string, string> = {
  pending: 'Ждёт списания',
  previewed: 'Проверено, не списано',
  applied: 'Списано',
  blocked: 'Не списано',
  skipped: 'Пропущено',
  not_required: 'Списывать не нужно',
};
export const stateLabel = (state: unknown) => STATE_LABELS[String(state)] ?? String(state);
/** «Касса №12», «Приложение №41», «Заказ 1a2b3c4d». */
export function saleLabel(item: Data): string {
  const n = item['display_number'];
  if (item['source'] === 'pos') return n ? `Касса №${String(n)}` : 'Касса';
  return n ? `Приложение и киоск №${String(n)}` : `Заказ ${String(item['order_id']).slice(0, 8)}`;
}
const REASONS: Record<string, string> = {
  MENU_VERSION_UNKNOWN: 'версия меню кассы не найдена в каталоге',
  ORDER_UNKNOWN: 'продажа не найдена',
  CANCELLED_BEFORE_KITCHEN: 'отменён до начала приготовления',
  MANUAL_CONSUMPTION: 'уже списан вручную по техкартам',
  ABSORBED_BY_COUNT: 'учтено инвентаризацией после продажи',
  NOTHING_TO_CONSUME: 'по связям списывать нечего',
};
function problemText(p: Data): string {
  const name = p['name'] ?? p['catalog_key'];
  switch (p['code']) {
    case 'NO_LINK':
      return `нет связи: ${String(name)}`;
    case 'LINK_NOT_APPROVED':
      return `связь не утверждена: ${String(name)}`;
    case 'ITEM_UNKNOWN':
      return p['catalog_key']
        ? `позиции нет в меню продажи: ${String(p['catalog_key'])}`
        : 'позиция продажи не найдена в меню';
    case 'COMBO_TOO_DEEP':
      return `комбо вложено глубже 5 уровней: ${String(name)}`;
    case 'INGREDIENT_UNKNOWN':
      return 'в связи указана удалённая позиция склада';
    case 'RECIPE_NOT_FOUND':
      return 'у выхода ТТК нет техкарты';
    case 'RECIPE_AMBIGUOUS':
      return 'у выхода ТТК несколько техкарт';
    case 'RECIPE_CYCLE':
      return `техкарты ссылаются друг на друга: ${String(p['name'] ?? '')}`.trim();
    case 'RECIPE_TOO_DEEP':
      return 'техкарты вложены глубже 6 уровней';
    case 'RECIPE_POLICY_UNSET':
      return `в техкарте ${p['name'] ? `«${String(p['name'])}» ` : ''}не выбран «Выход техкарты при продаже»`;
    default:
      return String(p['code']);
  }
}
/**
 * Why the item is (not) written off, in words: «нет связи: Бургер Острый · не хватает: Булка
 * (нужно 2 шт, есть 0 шт)». A skip shows the manager's reason.
 */
export function itemReason(item: Data): string {
  const detail = object(item['detail']);
  if (item['state'] === 'skipped') return `Причина: ${String(item['reason'] ?? '')}`;
  const parts: string[] = [];
  for (const p of list(detail['problems'])) parts.push(problemText(p));
  if (item['state'] === 'blocked' || item['state'] === 'previewed')
    for (const s of list(detail['shortages']))
      parts.push(
        `не хватает: ${String(s['name'] ?? 'позиция')} (нужно ${displayQuantity(s['need'], s['unit'])}, есть ${displayQuantity(s['have'], s['unit'])})`,
      );
  const code = typeof item['reason'] === 'string' ? item['reason'] : null;
  if (!parts.length && code && REASONS[code]) parts.push(REASONS[code]!);
  return parts.length ? parts.join(' · ') : '-';
}
/** What was written off (or would be in dry_run): «Булка 2 шт, Мясо 0,24 кг». */
export function itemNeeds(item: Data): string {
  const needs = list(object(item['detail'])['needs']);
  if (!needs.length) return '-';
  return needs
    .map(
      (n) =>
        `${String(n['name'] ?? 'позиция')} ${displayQuantity(n['quantity'], n['unit'])}${n['absorbed_by_count'] ? ' (учтено подсчётом)' : ''}`,
    )
    .join(', ');
}
/** The document column: storno and refunds after the kitchen started are shown, never hidden. */
export function itemDocument(item: Data): string {
  const parts: string[] = [];
  if (item['state'] === 'applied')
    parts.push(item['reversed'] ? 'Списано, затем сторно' : 'Документ проведён');
  if (item['refunded'] === true && item['state'] === 'applied')
    parts.push('Возврат после начала приготовления: остатки не возвращены, при ошибке - сторно');
  return parts.length ? parts.join('. ') : '-';
}
/** Retry and skip are offered for open items while the mode is not off. */
export function queueActions(item: Data, mode: AutoconsumeMode) {
  const open = ['pending', 'previewed', 'blocked'].includes(String(item['state']));
  return { retry: open && mode !== 'off', skip: open };
}
export function queueSummary(view: ConsumptionView): string {
  const c = view.counts;
  return `Не списано: ${c['blocked'] ?? 0} · ждёт: ${c['pending'] ?? 0} · проверено без списания: ${c['previewed'] ?? 0} · списано: ${c['applied'] ?? 0} · пропущено: ${c['skipped'] ?? 0}`;
}

// ---------------------------------------------------------------------------- links ----

const unitLabel = (unit: unknown) => (unit === 'g' ? 'г' : unit === 'ml' ? 'мл' : 'шт');
/** «Булка 1 шт, Котлета (выход ТТК) 1 шт» or «Без списания». */
export function linkText(link: Data | null): string {
  if (!link) return '-';
  if (link['effect'] === 'none') return 'Без списания';
  return list(link['lines'])
    .map(
      (l) =>
        `${String(l['name'] ?? 'позиция')}${'recipe_output_id' in l ? ' (по ТТК)' : ''} ${String(l['quantity'])} ${unitLabel(l['unit'])}`,
    )
    .join(', ');
}
/** Status of one product or option in words; never by colour alone. */
export function linkStatus(item: Data, products: Map<string, string>): string {
  const link = item['link'] ? object(item['link']) : null;
  if (link) return link['status'] === 'approved' ? 'Утверждено' : 'Черновик';
  if (item['from_combo']) return 'Из состава комбо';
  if (item['linked_product_id'])
    return `Из товара: ${products.get(String(item['linked_product_id'])) ?? String(item['linked_product_id'])}`;
  return 'Нет связи';
}
export function itemTitle(item: Data): string {
  return item['kind'] === 'option'
    ? `${String(item['product_name_ru'])} · ${String(item['group_name_ru'] ?? '')}: ${String(item['name_ru'])}`
    : String(item['name_ru']);
}
export type LinkFilter = 'all' | 'missing' | 'draft';
export const needsLink = (item: Data) =>
  item['listed'] === true && !item['link'] && item['covered_without_link'] !== true;
export const isDraft = (item: Data) => object(item['link'])['status'] === 'draft';
export function filterLinks(items: Data[], filter: LinkFilter): Data[] {
  if (filter === 'missing') return items.filter(needsLink);
  if (filter === 'draft') return items.filter(isDraft);
  return items;
}
/** How a TTK output is written off at the sale (the recipe's stock_policy), null = not chosen. */
export type OutputPolicy = 'explode' | 'stock' | null;
/** «на сырьё», «сам выход», «способ не выбран»: the link editor's words for a TTK output. */
export const outputPolicyText = (policy: OutputPolicy) =>
  policy === 'explode' ? 'на сырьё' : policy === 'stock' ? 'сам выход' : 'способ не выбран';
/**
 * Stock items for the link editor: every ingredient, and those that are a TTK output, with the
 * stock_policy and the name of their recipe.
 */
export function linkTargets(records: { kind: string; id: string; payload: Data }[]) {
  const ingredients = records
    .filter((r) => r.kind === 'ingredient')
    .map((r) => ({ id: r.id, name: String(r.payload['name']), unit: String(r.payload['unit']) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const outputs = new Map<string, Data[]>();
  for (const r of records)
    if (r.kind === 'recipe' && typeof r.payload['output_ingredient_id'] === 'string')
      outputs.set(r.payload['output_ingredient_id'], [
        ...(outputs.get(r.payload['output_ingredient_id']) ?? []),
        r.payload,
      ]);
  return {
    ingredients,
    // A TTK output names exactly one production recipe (the server refuses others).
    outputs: ingredients
      .filter((i) => outputs.get(i.id)?.length === 1)
      .map((i) => {
        const recipe = outputs.get(i.id)![0]!;
        const policy = recipe['stock_policy'];
        return {
          ...i,
          recipe: String(recipe['name'] ?? ''),
          policy: (policy === 'explode' || policy === 'stock' ? policy : null) as OutputPolicy,
        };
      }),
  };
}
/**
 * Review BOUI-R1: a TTK output whose recipe has no stock_policy is never written off at the sale
 * (the queue blocks it with RECIPE_POLICY_UNSET). The editor says so for each such line.
 */
export function unsetPolicyWarnings(
  outputs: { id: string; recipe: string; policy: OutputPolicy }[],
  lines: LinkDraftLine[],
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.target.startsWith('r:')) continue;
    const output = outputs.find((o) => o.id === line.target.slice(2));
    if (output && output.policy === null)
      out.push(
        `В техкарте «${output.recipe}» не выбран «Выход техкарты при продаже». Пока его не выберут, продажи по этой связи не спишутся: очередь покажет «Не списано».`,
      );
  }
  return out;
}
export type LinkDraftLine = { target: string; quantity: string };
/** `i:<id>` stock item as is, `r:<id>` TTK output by its recipe. */
export const lineKey = (line: Data) =>
  'recipe_output_id' in line
    ? `r:${String(line['recipe_output_id'])}`
    : `i:${String(line['ingredient_id'])}`;
/** The menu_link_save command of the editor, or a Russian error. */
export function linkCommand(item: Data, effect: 'consume' | 'none', lines: LinkDraftLine[]): Data {
  const link = item['link'] ? object(item['link']) : null;
  const filled = lines.filter((l) => l.target || l.quantity);
  if (effect === 'none' && filled.length)
    throw new Error('Для «Без списания» уберите строки склада.');
  if (effect === 'consume' && !filled.length)
    throw new Error('Добавьте хотя бы одну строку склада или выберите «Без списания».');
  if (filled.length > 50) throw new Error('В связи не больше 50 строк.');
  const seen = new Set<string>();
  const out = filled.map((l) => {
    if (!/^[ir]:[0-9a-f-]{36}$/.test(l.target))
      throw new Error('Выберите позицию склада в каждой строке.');
    if (!/^[1-9][0-9]{0,8}$/.test(l.quantity.trim()))
      throw new Error('Количество - целое число больше нуля в единице позиции (г, мл или шт).');
    const id = l.target.slice(2);
    if (seen.has(id)) throw new Error('Позиция склада повторяется. Объедините строки.');
    seen.add(id);
    return l.target.startsWith('r:')
      ? { recipe_output_id: id, quantity: l.quantity.trim() }
      : { ingredient_id: id, quantity: l.quantity.trim() };
  });
  return {
    type: 'menu_link_save',
    catalog_ref: object(item['catalog_ref']),
    effect,
    lines: out,
    expected_revision: link ? Number(link['revision']) : 0,
  };
}
/** menu_links_approve of the draft links shown (at most 200 at once). */
export function approveCommand(items: Data[]): Data {
  const drafts = items.filter(isDraft).slice(0, 200);
  if (!drafts.length) throw new Error('Нет черновиков для утверждения.');
  return {
    type: 'menu_links_approve',
    keys: drafts.map((i) => String(i['catalog_key'])),
    expected_revisions: Object.fromEntries(
      drafts.map((i) => [String(i['catalog_key']), Number(object(i['link'])['revision'])]),
    ),
  };
}
