#!/usr/bin/env node
/**
 * Read-only gate before the first back-office publication to the cashier edge.
 *
 *   node scripts/catalog-edge-parity.mjs --catalog <cloud.json> --edge <edge-menu.json> [--routing <routing.json>]
 *
 * --catalog  the back-office catalog: the admin GET /v1/admin/catalog/branches/:id response
 *            (its published payload is used), the public GET /v1/catalog/branches/:id
 *            response, or a bare catalog payload.
 * --edge     the active edge snapshot from GET http://127.0.0.1:<edge port>/edge/v1/menu.
 * --routing  optional active kitchen routing ({version, assemblyStationId, routes}, the
 *            fulfillment_routing payload), or {routing, stations:[{id, kind}]} to also run the
 *            exact edge derivation and prove the first publication cannot be ROUTING_UNRESOLVED.
 * --allow    optional reviewed list of expected cutover changes (expected-edge-changes.json of
 *            scripts/catalog-menu-import.mjs build). The comparison then runs in detailed form
 *            and passes only when the differences are exactly that list, for the same edge menu
 *            and the same payload: an extra or a missing difference fails. PROJECTION_FAILED,
 *            ROUTING_UNRESOLVED and PRODUCT_ID_CHANGED are never allowed; ROUTE_DERIVED_ON_APPLY
 *            stays a warning outside the list.
 * --aggregator-prices
 *            optional (cutover CC-3, with CATALOG_AGGREGATOR_PRICES_ENABLED on the cloud): project
 *            the catalog as the cloud then publishes it (yandex_eda/glovo channel prices become
 *            aggregator_prices_minor) and compare those prices item by item for an edge that
 *            advertises the aggregator_prices menu feature. Any difference, including a price
 *            the edge does not have yet, is AGGREGATOR_PRICE_CHANGED (a failure, like
 *            PRICE_CHANGED; with --allow it must be in the reviewed list). Without the flag no
 *            aggregator price is compared and the report is exactly the previous one.
 *
 * The catalog is projected with the same projectCatalogMenu the cloud publishes with, then
 * compared item by item. Exit 0: no failure (with --allow: exactly the reviewed changes).
 * Exit 1: a price changed, or an installed item, modifier group or option would disappear, or
 * routing cannot be derived (with --allow: the differences are not the reviewed list).
 * Exit 2: invalid input. Without --allow the report is byte-identical to the one before --allow.
 * No database connection, no network and no secrets.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MenuSnapshotSchema } from '@pickchick/contracts';
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import { projectCatalogMenu, deriveRouting, MenuRoutingError } from '@pickchick/menu-sync';

const PROJECTION_RELEASE = '00000000-0000-4000-8000-000000000000';
/** Aggregator channels of MenuItem.aggregator_prices_minor (contracts 5.3). */
const AGGREGATOR_CHANNELS = Object.freeze(['yandex_eda', 'glovo']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ParityInputError extends Error {}

/** Accepts the admin state, the public publication or a bare payload. */
export function catalogInput(value) {
  if (!isRecord(value)) throw new ParityInputError('Catalog JSON must be an object');
  let raw = value,
    branchId = null,
    version = null,
    publishedAt = null;
  if ('published' in value && 'branch' in value) {
    if (!isRecord(value.published)) throw new ParityInputError('Catalog has no publication');
    ({ payload: raw, version, published_at: publishedAt } = value.published);
    branchId = value.branch?.id ?? null;
  } else if ('payload' in value && 'branch_id' in value) {
    ({ payload: raw, version, published_at: publishedAt, branch_id: branchId } = value);
  }
  const parsed = CatalogPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new ParityInputError('Catalog payload is invalid');
  return { payload: parsed.data, branchId, version, publishedAt };
}

function routingInput(value) {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new ParityInputError('Routing JSON must be an object');
  const routing = 'routing' in value ? value.routing : value;
  const stations = 'routing' in value ? value.stations : undefined;
  if (
    !isRecord(routing) ||
    !Array.isArray(routing.routes) ||
    routing.routes.some((route) => !isRecord(route) || typeof route.productId !== 'string') ||
    (stations !== undefined &&
      (!Array.isArray(stations) ||
        stations.some(
          (s) => !isRecord(s) || typeof s.id !== 'string' || typeof s.kind !== 'string',
        )))
  )
    throw new ParityInputError('Routing JSON is invalid');
  return { routing, stations: stations ?? null };
}

const name = (item) => item.name?.ru ?? '';
const optionsOf = (item) =>
  new Map(
    (item.modifier_groups ?? []).flatMap((group) =>
      group.options.map((option) => [option.id, { group, option }]),
    ),
  );

const limits = (group) => ({ min_selected: group.min_selected, max_selected: group.max_selected });
const optionRule = (option) => ({
  default_quantity: option.default_quantity ?? null,
  max_quantity: option.max_quantity ?? null,
  available: option.available ?? null,
});

/**
 * Compares one installed edge item with its projected publication item. `detailed` (--allow only)
 * adds the before/after values to entries that otherwise carry just the identity, so a reviewed
 * list pins every value; off, the entries are exactly the historical ones.
 */
function compareItem(edge, next, failures, warnings, detailed, aggregatorPrices) {
  const at = { variant_id: edge.variant_id, name: name(edge) };
  if (edge.price_minor !== next.price_minor)
    failures.push({
      code: 'PRICE_CHANGED',
      ...at,
      edge_minor: edge.price_minor,
      catalog_minor: next.price_minor,
    });
  // Only with --aggregator-prices; null = not sold in that channel (no key).
  if (aggregatorPrices)
    for (const channel of AGGREGATOR_CHANNELS) {
      const before = edge.aggregator_prices_minor?.[channel] ?? null,
        after = next.aggregator_prices_minor?.[channel] ?? null;
      if (before !== after)
        failures.push({
          code: 'AGGREGATOR_PRICE_CHANGED',
          ...at,
          channel,
          edge_minor: before,
          catalog_minor: after,
        });
    }
  if (edge.product_id !== next.product_id) failures.push({ code: 'PRODUCT_ID_CHANGED', ...at });
  if (name(edge) !== name(next))
    warnings.push({ code: 'NAME_CHANGED', ...at, catalog_name: name(next) });
  if (edge.category_id !== next.category_id)
    warnings.push({
      code: 'CATEGORY_CHANGED',
      ...at,
      ...(detailed
        ? { edge_category_id: edge.category_id, catalog_category_id: next.category_id }
        : {}),
    });
  if ((edge.image_url ?? null) !== (next.image_url ?? null))
    warnings.push({
      code: 'IMAGE_CHANGED',
      ...at,
      edge_image: edge.image_url ?? null,
      catalog_image: next.image_url ?? null,
    });
  const nextGroups = new Map((next.modifier_groups ?? []).map((group) => [group.id, group]));
  for (const group of edge.modifier_groups ?? []) {
    const candidate = nextGroups.get(group.id);
    if (!candidate) {
      failures.push({ code: 'GROUP_REMOVED', ...at, group_id: group.id, group: group.name.ru });
      continue;
    }
    if (
      group.min_selected !== candidate.min_selected ||
      group.max_selected !== candidate.max_selected
    )
      warnings.push({
        code: 'GROUP_LIMITS_CHANGED',
        ...at,
        group_id: group.id,
        ...(detailed ? { edge: limits(group), catalog: limits(candidate) } : {}),
      });
  }
  for (const group of next.modifier_groups ?? [])
    if (!(edge.modifier_groups ?? []).some((g) => g.id === group.id))
      warnings.push({
        code: 'GROUP_ADDED',
        ...at,
        group_id: group.id,
        group: group.name.ru,
        ...(detailed ? { catalog: limits(group) } : {}),
      });
  const before = optionsOf(edge),
    after = optionsOf(next);
  for (const [id, { group, option }] of before) {
    const candidate = after.get(id)?.option;
    const where = { ...at, group_id: group.id, option_id: id, option: option.name.ru };
    if (!candidate) {
      failures.push({ code: 'OPTION_REMOVED', ...where });
      continue;
    }
    if (option.price_minor !== candidate.price_minor)
      failures.push({
        code: 'OPTION_PRICE_CHANGED',
        ...where,
        edge_minor: option.price_minor,
        catalog_minor: candidate.price_minor,
      });
    if (
      option.default_quantity !== candidate.default_quantity ||
      option.max_quantity !== candidate.max_quantity ||
      option.available !== candidate.available
    )
      warnings.push({
        code: 'OPTION_CHANGED',
        ...where,
        ...(detailed ? { edge: optionRule(option), catalog: optionRule(candidate) } : {}),
      });
  }
  for (const [id, { group, option }] of after)
    if (!before.has(id))
      warnings.push({
        code: 'OPTION_ADDED',
        ...at,
        group_id: group.id,
        option_id: id,
        option: option.name.ru,
        ...(detailed ? { catalog_minor: option.price_minor, catalog: optionRule(option) } : {}),
      });
}

/**
 * Pure comparison; the CLI only reads the input files and prints this report. `detailed` is the
 * --allow form (see compareItem); without it the report is the historical one.
 */
export function catalogEdgeParity(
  { catalog, snapshot, routing },
  { detailed = false, aggregatorPrices = false } = {},
) {
  const source = catalogInput(catalog);
  const parsedSnapshot = MenuSnapshotSchema.safeParse(snapshot);
  if (!parsedSnapshot.success) throw new ParityInputError('Edge snapshot is invalid');
  const edge = parsedSnapshot.data;
  if (source.branchId !== null && source.branchId !== edge.branch_id)
    throw new ParityInputError('Catalog and edge snapshot belong to different branches');
  const kitchen = routingInput(routing);
  const failures = [],
    warnings = [];
  let projected;
  try {
    projected = projectCatalogMenu(
      source.payload,
      edge.branch_id,
      edge.version + 1,
      source.publishedAt ?? edge.published_at,
      PROJECTION_RELEASE,
      ...(aggregatorPrices ? [{ aggregatorPrices: true }] : []),
    );
  } catch (error) {
    // The cloud would refuse to publish this catalog to the edge at all.
    failures.push({ code: 'PROJECTION_FAILED', reason: error?.code ?? 'INVALID_MENU' });
  }
  const nextItems = new Map((projected?.items ?? []).map((item) => [item.variant_id, item]));
  const edgeIds = new Set(edge.items.map((item) => item.variant_id));
  const items = [];
  for (const item of edge.items) {
    const next = nextItems.get(item.variant_id);
    if (!next) {
      if (projected)
        failures.push({ code: 'ITEM_REMOVED', variant_id: item.variant_id, name: name(item) });
      items.push({ variant_id: item.variant_id, name: name(item), status: 'removed' });
      continue;
    }
    compareItem(item, next, failures, warnings, detailed, aggregatorPrices);
    items.push({
      variant_id: item.variant_id,
      source_id: next.source_id,
      sku: next.sku,
      name: name(next),
      status: 'matched',
      edge_minor: item.price_minor,
      catalog_minor: next.price_minor,
    });
  }
  for (const next of projected?.items ?? [])
    if (!edgeIds.has(next.variant_id)) {
      warnings.push({
        code: 'ITEM_ADDED',
        variant_id: next.variant_id,
        name: name(next),
        ...(detailed ? { source_id: next.source_id ?? null, catalog_minor: next.price_minor } : {}),
        ...(detailed && aggregatorPrices
          ? { catalog_aggregator_prices_minor: next.aggregator_prices_minor ?? null }
          : {}),
      });
      items.push({
        variant_id: next.variant_id,
        source_id: next.source_id,
        sku: next.sku,
        name: name(next),
        status: 'added',
        catalog_minor: next.price_minor,
      });
    }
  let routingReport = null;
  if (kitchen && projected) {
    const routes = new Map(kitchen.routing.routes.map((route) => [route.productId, route]));
    let missing = 0;
    for (const entry of items) {
      const next = nextItems.get(entry.variant_id);
      if (!next) continue;
      const pos = routes.has(next.product_id),
        cloud = next.source_id !== undefined && routes.has(next.source_id);
      entry.routing = { pos, cloud, kitchen_route: next.kitchen?.route ?? null };
      if (!pos || !cloud) {
        missing += 1;
        // Not a failure: the edge derives these routes from kitchen.route during apply.
        warnings.push({
          code: 'ROUTE_DERIVED_ON_APPLY',
          variant_id: next.variant_id,
          name: name(next),
          missing: [...(pos ? [] : ['pos']), ...(cloud ? [] : ['cloud'])],
          kitchen_route: next.kitchen?.route ?? null,
        });
      }
    }
    routingReport = {
      active_version: kitchen.routing.version ?? null,
      items_needing_routes: missing,
    };
    if (kitchen.stations) {
      try {
        const next = deriveRouting(projected, kitchen.routing, kitchen.stations);
        routingReport.derived_version = next ? next.version : null;
      } catch (error) {
        if (!(error instanceof MenuRoutingError)) throw error;
        failures.push({ code: 'ROUTING_UNRESOLVED', detail: error.detail });
      }
    }
  }
  const count = (list, code) => list.filter((entry) => entry.code === code).length;
  return {
    ok: failures.length === 0,
    ...(aggregatorPrices ? { aggregator_prices: true } : {}),
    branch_id: edge.branch_id,
    catalog_version: source.version,
    edge_release_id: edge.release_id,
    edge_version: edge.version,
    summary: {
      edge_items: edge.items.length,
      catalog_items: projected?.items.length ?? null,
      matched: items.filter((item) => item.status === 'matched').length,
      removed: items.filter((item) => item.status === 'removed').length,
      added: items.filter((item) => item.status === 'added').length,
      price_changes: count(failures, 'PRICE_CHANGED'),
      option_price_changes: count(failures, 'OPTION_PRICE_CHANGED'),
      removed_options: count(failures, 'OPTION_REMOVED') + count(failures, 'GROUP_REMOVED'),
      ...(aggregatorPrices
        ? { aggregator_price_changes: count(failures, 'AGGREGATOR_PRICE_CHANGED') }
        : {}),
      warnings: warnings.length,
    },
    routing: routingReport,
    failures,
    warnings,
    items,
  };
}

/** Schema tag of the reviewed expected-changes file written by catalog-menu-import build. */
export const EXPECTED_CHANGES_SCHEMA = 'pickchick.catalog-edge-expected/v1';
/** A publication with any of these can never be the reviewed cutover change. */
export const NEVER_ALLOWED = Object.freeze([
  'PROJECTION_FAILED',
  'ROUTING_UNRESOLVED',
  'PRODUCT_ID_CHANGED',
]);
/** Depends on the routing input only; reported as a warning, never part of the list. */
const OUTSIDE_LIST = new Set(['ROUTE_DERIVED_ON_APPLY']);
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const changeKey = (entry) => JSON.stringify(canonical(entry));

/**
 * Identity of the catalog the edge would receive, apart from the editor's review flag: the same
 * schema-ordered encoding as the cloud draft payload_hash, with content_reviewed set to false, so
 * the built (unreviewed) and the saved (reviewed) copy of one payload share it.
 */
export function edgePayloadHash(payload) {
  const parsed = CatalogPayloadSchema.safeParse({ ...payload, content_reviewed: false });
  if (!parsed.success) throw new ParityInputError('Catalog payload is invalid');
  return sha256(JSON.stringify(parsed.data));
}

/** The differences a detailed report shows, in report order, as the reviewed list stores them. */
export function reportChanges(report) {
  return [...report.failures, ...report.warnings].filter((entry) => !OUTSIDE_LIST.has(entry.code));
}

/** The reviewed-list document for a detailed report of one payload (catalog-menu-import build). */
export function expectedEdgeChanges(report, payloadSha256) {
  const changes = reportChanges(report);
  if (changes.some((entry) => NEVER_ALLOWED.includes(entry.code)))
    throw new ParityInputError('The edge would reject this publication');
  const counts = {};
  for (const entry of changes) counts[entry.code] = (counts[entry.code] ?? 0) + 1;
  return {
    schema: EXPECTED_CHANGES_SCHEMA,
    branch_id: report.branch_id,
    edge_release_id: report.edge_release_id,
    edge_version: report.edge_version,
    payload_sha256: payloadSha256,
    counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))),
    changes,
  };
}

function expectedInput(value) {
  if (
    !isRecord(value) ||
    value.schema !== EXPECTED_CHANGES_SCHEMA ||
    typeof value.branch_id !== 'string' ||
    !UUID.test(value.branch_id) ||
    typeof value.edge_release_id !== 'string' ||
    !UUID.test(value.edge_release_id) ||
    !Number.isInteger(value.edge_version) ||
    typeof value.payload_sha256 !== 'string' ||
    !HEX64.test(value.payload_sha256) ||
    !Array.isArray(value.changes) ||
    value.changes.length > 20000 ||
    value.changes.some((entry) => !isRecord(entry) || typeof entry.code !== 'string') ||
    value.changes.some(
      (entry) => NEVER_ALLOWED.includes(entry.code) || OUTSIDE_LIST.has(entry.code),
    )
  )
    throw new ParityInputError('Expected changes file is invalid');
  return value;
}

/**
 * --allow gate over a detailed report: passes only when the differences are exactly the reviewed
 * list (as a multiset), for the same branch, edge menu and payload, and nothing is never-allowed.
 */
export function allowReviewedChanges(report, expected, { payloadSha256, fileSha256 }) {
  const list = expectedInput(expected);
  const remaining = new Map();
  for (const entry of list.changes) {
    const key = changeKey(entry);
    remaining.set(key, [...(remaining.get(key) ?? []), entry]);
  }
  const actual = reportChanges(report);
  const unexpected = [];
  let matched = 0;
  for (const entry of actual) {
    const key = changeKey(entry);
    const left = remaining.get(key);
    if (left?.length) {
      left.pop();
      matched += 1;
    } else unexpected.push(entry);
  }
  const missing = [...remaining.values()].flat();
  const blocking = actual.filter((entry) => NEVER_ALLOWED.includes(entry.code));
  const stale = [
    ...(list.branch_id !== report.branch_id ? ['BRANCH_MISMATCH'] : []),
    ...(list.edge_release_id !== report.edge_release_id || list.edge_version !== report.edge_version
      ? ['EDGE_MENU_CHANGED']
      : []),
    ...(list.payload_sha256 !== payloadSha256 ? ['PAYLOAD_CHANGED'] : []),
  ];
  return {
    file_sha256: fileSha256,
    payload_sha256: payloadSha256,
    expected: list.changes.length,
    actual: actual.length,
    matched,
    unexpected,
    missing,
    blocking,
    stale,
    ok: !unexpected.length && !missing.length && !blocking.length && !stale.length,
  };
}

/** One CLI run: the historical report, or with an --allow list the gated detailed report. */
export function parityRun({ catalog, snapshot, routing, allow, aggregatorPrices = false }) {
  const options = aggregatorPrices ? { aggregatorPrices: true } : {};
  if (!allow) return catalogEdgeParity({ catalog, snapshot, routing }, options);
  const report = catalogEdgeParity({ catalog, snapshot, routing }, { detailed: true, ...options });
  const result = allowReviewedChanges(report, allow.expected, {
    payloadSha256: edgePayloadHash(catalogInput(catalog).payload),
    fileSha256: allow.sha256,
  });
  return { ...report, ok: result.ok, allow: result };
}

async function readBytes(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 5_000_000) throw new ParityInputError('Unreadable input file');
  return readFile(path);
}

function jsonOf(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ParityInputError('Input file is not JSON');
  }
}

const readJson = async (path) => jsonOf(await readBytes(path));

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index],
      value = argv[index + 1];
    // The only switch without a value (cutover CC-3).
    if (flag === '--aggregator-prices' && !('aggregatorPrices' in options)) {
      options.aggregatorPrices = true;
      index -= 1;
      continue;
    }
    const key = {
      '--catalog': 'catalog',
      '--edge': 'edge',
      '--routing': 'routing',
      '--allow': 'allow',
    }[flag];
    if (!key || !value || value.startsWith('--') || key in options)
      throw new ParityInputError(
        'Usage: catalog-edge-parity.mjs --catalog <file> --edge <file> [--routing <file>] [--allow <expected.json>] [--aggregator-prices]',
      );
    options[key] = value;
  }
  if (!options.catalog || !options.edge)
    throw new ParityInputError('--catalog and --edge are required');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const allowBytes = options.allow ? await readBytes(options.allow) : null;
  const report = parityRun({
    catalog: await readJson(options.catalog),
    snapshot: await readJson(options.edge),
    routing: options.routing ? await readJson(options.routing) : undefined,
    allow: allowBytes ? { expected: jsonOf(allowBytes), sha256: sha256(allowBytes) } : undefined,
    aggregatorPrices: options.aggregatorPrices === true,
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'catalog_edge_parity_failed',
        detail: error instanceof ParityInputError ? error.message : 'Unexpected error',
      }),
    );
    process.exitCode = 2;
  });
