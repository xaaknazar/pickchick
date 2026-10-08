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
 *
 * The catalog is projected with the same projectCatalogMenu the cloud publishes with, then
 * compared item by item. Exit 0: no failure. Exit 1: a price changed, or an installed item,
 * modifier group or option would disappear, or routing cannot be derived. Exit 2: invalid input.
 * No database connection, no network and no secrets.
 */
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MenuSnapshotSchema } from '@pickchick/contracts';
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import { projectCatalogMenu, deriveRouting, MenuRoutingError } from '@pickchick/menu-sync';

const PROJECTION_RELEASE = '00000000-0000-4000-8000-000000000000';
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

/** Compares one installed edge item with its projected publication item. */
function compareItem(edge, next, failures, warnings) {
  const at = { variant_id: edge.variant_id, name: name(edge) };
  if (edge.price_minor !== next.price_minor)
    failures.push({
      code: 'PRICE_CHANGED',
      ...at,
      edge_minor: edge.price_minor,
      catalog_minor: next.price_minor,
    });
  if (edge.product_id !== next.product_id) failures.push({ code: 'PRODUCT_ID_CHANGED', ...at });
  if (name(edge) !== name(next))
    warnings.push({ code: 'NAME_CHANGED', ...at, catalog_name: name(next) });
  if (edge.category_id !== next.category_id) warnings.push({ code: 'CATEGORY_CHANGED', ...at });
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
      warnings.push({ code: 'GROUP_LIMITS_CHANGED', ...at, group_id: group.id });
  }
  for (const group of next.modifier_groups ?? [])
    if (!(edge.modifier_groups ?? []).some((g) => g.id === group.id))
      warnings.push({ code: 'GROUP_ADDED', ...at, group_id: group.id, group: group.name.ru });
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
      warnings.push({ code: 'OPTION_CHANGED', ...where });
  }
  for (const [id, { group, option }] of after)
    if (!before.has(id))
      warnings.push({
        code: 'OPTION_ADDED',
        ...at,
        group_id: group.id,
        option_id: id,
        option: option.name.ru,
      });
}

/** Pure comparison; the CLI only reads the three files and prints this report. */
export function catalogEdgeParity({ catalog, snapshot, routing }) {
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
    compareItem(item, next, failures, warnings);
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
      warnings.push({ code: 'ITEM_ADDED', variant_id: next.variant_id, name: name(next) });
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
      warnings: warnings.length,
    },
    routing: routingReport,
    failures,
    warnings,
    items,
  };
}

async function readJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 5_000_000) throw new ParityInputError('Unreadable input file');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new ParityInputError('Input file is not JSON');
  }
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index],
      value = argv[index + 1];
    const key = { '--catalog': 'catalog', '--edge': 'edge', '--routing': 'routing' }[flag];
    if (!key || !value || value.startsWith('--') || key in options)
      throw new ParityInputError(
        'Usage: catalog-edge-parity.mjs --catalog <file> --edge <file> [--routing <file>]',
      );
    options[key] = value;
  }
  if (!options.catalog || !options.edge)
    throw new ParityInputError('--catalog and --edge are required');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = catalogEdgeParity({
    catalog: await readJson(options.catalog),
    snapshot: await readJson(options.edge),
    routing: options.routing ? await readJson(options.routing) : undefined,
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
