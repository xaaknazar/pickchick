import type { MenuSnapshot } from '@pickchick/contracts';

/**
 * Structural mirror of @pickchick/edge-fulfillment RoutingSchema. menu-sync cannot import
 * that package: edge-fulfillment -> local-orders -> menu-sync would form a workspace cycle.
 * tests/integration/menu-routing.test.mjs parses every derived routing with the real
 * RoutingSchema and runs the real taskPlan for every item on both admission paths.
 */
export interface KitchenRoute {
  productId: string;
  stationId: string;
  kind: 'prep' | 'assembly_item';
  unexpandedCombo?: 'whole_product';
}
export interface KitchenRouting {
  version: number;
  assemblyStationId: string;
  routes: KitchenRoute[];
}
export interface KitchenStation {
  id: string;
  kind: 'prep' | 'assembly';
}

export class MenuRoutingError extends Error {
  readonly code = 'ROUTING_UNRESOLVED' as const;
  constructor(readonly detail: string) {
    super('ROUTING_UNRESOLVED');
    this.name = 'MenuRoutingError';
  }
}

const MAX_ROUTES = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameRoute(a: KitchenRoute | undefined, b: KitchenRoute) {
  return (
    a !== undefined &&
    a.productId === b.productId &&
    a.stationId === b.stationId &&
    a.kind === b.kind &&
    a.unexpandedCombo === b.unexpandedCombo
  );
}

function checkedRouting(routing: KitchenRouting, stations: Map<string, KitchenStation['kind']>) {
  if (
    routing === null ||
    typeof routing !== 'object' ||
    !Number.isSafeInteger(routing.version) ||
    routing.version < 1 ||
    stations.get(routing.assemblyStationId) !== 'assembly' ||
    !Array.isArray(routing.routes) ||
    routing.routes.length < 1 ||
    routing.routes.length > MAX_ROUTES
  )
    throw new MenuRoutingError('invalid routing');
  const seen = new Set<string>();
  for (const route of routing.routes) {
    if (
      route === null ||
      typeof route !== 'object' ||
      typeof route.productId !== 'string' ||
      route.productId.length < 1 ||
      route.productId.length > 160 ||
      seen.has(route.productId) ||
      !UUID.test(route.stationId) ||
      !['prep', 'assembly_item'].includes(route.kind) ||
      stations.get(route.stationId) !== (route.kind === 'prep' ? 'prep' : 'assembly') ||
      (route.unexpandedCombo !== undefined && route.unexpandedCombo !== 'whole_product')
    )
      throw new MenuRoutingError('invalid route');
    seen.add(route.productId);
  }
}

/**
 * Derives the kitchen routing for a new menu on the edge, inside the menu apply transaction.
 *
 * - Every existing route is kept with its station. Routes for products that left the menu
 *   are kept as well: the snapshot does not carry combo components, so the edge cannot prove
 *   that a cloud combo no longer expands into them, and an unused route is inert.
 * - A product key (hashed POS product_id or catalog slug source_id) without a route copies the
 *   station of its sibling key, else follows the published kitchen field: 'prep' maps to the
 *   single prep station, 'assembly_item' to routing.assemblyStationId. No default is inferred.
 * - A published unexpanded_combo adds the explicit whole-product flag to the slug route.
 * - Coverage is then checked for a synthetic POS line and a synthetic cloud line of every item.
 *
 * Returns null when the routes are unchanged (no new routing version is needed).
 */
export function deriveRouting(
  snapshot: Pick<MenuSnapshot, 'items'>,
  active: KitchenRouting,
  stationList: readonly KitchenStation[],
): KitchenRouting | null {
  const stations = new Map(stationList.map((station) => [station.id, station.kind]));
  if (stations.size !== stationList.length) throw new MenuRoutingError('duplicate station');
  checkedRouting(active, stations);
  const prepStations = stationList.filter((station) => station.kind === 'prep');
  const prepStation = () => {
    if (prepStations.length !== 1) throw new MenuRoutingError('prep station is not unique');
    return prepStations[0]!.id;
  };
  const routes = new Map(active.routes.map((route) => [route.productId, { ...route }]));
  const set = (route: KitchenRoute) => routes.set(route.productId, route);
  for (const item of snapshot.items) {
    const slug = item.source_id;
    const keys = slug === undefined ? [item.product_id] : [item.product_id, slug];
    const anchor =
      routes.get(item.product_id) ?? (slug === undefined ? undefined : routes.get(slug));
    const whole = item.kitchen?.unexpanded_combo;
    for (const key of keys) {
      if (routes.has(key)) continue;
      if (anchor) {
        set({
          productId: key,
          stationId: anchor.stationId,
          kind: anchor.kind,
          ...((whole ?? anchor.unexpandedCombo) ? { unexpandedCombo: 'whole_product' } : {}),
        });
      } else if (item.kitchen) {
        set({
          productId: key,
          stationId: item.kitchen.route === 'prep' ? prepStation() : active.assemblyStationId,
          kind: item.kitchen.route,
          ...(whole ? { unexpandedCombo: whole } : {}),
        });
      } else {
        throw new MenuRoutingError('item without kitchen route');
      }
    }
    // Cloud orders route an unexpanded combo by slug and require the explicit flag.
    const slugRoute = slug === undefined ? undefined : routes.get(slug);
    if (whole && slugRoute && slugRoute.unexpandedCombo !== whole)
      set({ ...slugRoute, unexpandedCombo: whole });
  }
  // Coverage: POS lines are kind 'item' by hashed id; cloud lines are by slug and keep the
  // item kind, so an unexpanded combo needs the whole-product route.
  for (const item of snapshot.items) {
    if (!routes.has(item.product_id)) throw new MenuRoutingError('POS line not covered');
    if (item.source_id === undefined) continue;
    const cloud = routes.get(item.source_id);
    if (!cloud) throw new MenuRoutingError('cloud line not covered');
    if (
      (item.kind ?? 'item') !== 'item' &&
      item.kitchen?.unexpanded_combo === 'whole_product' &&
      cloud.unexpandedCombo !== 'whole_product'
    )
      throw new MenuRoutingError('unexpanded combo not covered');
  }
  const next: KitchenRouting = {
    version: active.version + 1,
    assemblyStationId: active.assemblyStationId,
    routes: [...routes.values()],
  };
  if (
    next.routes.length === active.routes.length &&
    active.routes.every((route) => sameRoute(routes.get(route.productId), route))
  )
    return null;
  if (!Number.isSafeInteger(next.version) || next.version > 2147483647)
    throw new MenuRoutingError('routing version overflow');
  checkedRouting(next, stations);
  return next;
}
