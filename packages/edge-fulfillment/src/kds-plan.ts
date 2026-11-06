import type { DatabaseClient } from '@pickchick/database';
import { taskPlan } from './model.js';
import type { Routing, Snapshot, TaskPlan } from './model.js';
import { cloudKdsSlugs, kdsTaskPlan, noKdsSlugs } from './kds.js';
import { readKdsLayout, readMenuKdsSlugs } from './kds-layout.js';

export type KitchenPlan = { plan: TaskPlan[]; assemblyStationId: string };
/**
 * Cutover seam (contracts section 5.2): the one place both admission paths get their task plan
 * and finishing station. Signature frozen; owner after D0: KDS lane. Without an enabled KDS
 * layout the result is exactly taskPlan(snapshot, routing) and routing.assemblyStationId.
 *
 * taskPlan always runs first: its ROUTING_MISSING and INVALID stay the only reasons to refuse.
 * With the layout enabled (edge 027 readable, kds_settings.layout_enabled, a usable active
 * layout) the tasks follow the layout (kdsTaskPlan); a plan the layout cannot build within the
 * legacy bounds falls back to the legacy plan, so the layout never refuses an order.
 */
export async function buildKitchenPlan(
  client: DatabaseClient,
  input: { branchId: string; snapshot: Snapshot; routing: Routing },
): Promise<KitchenPlan> {
  const legacy: KitchenPlan = {
    plan: taskPlan(input.snapshot, input.routing),
    assemblyStationId: input.routing.assemblyStationId,
  };
  const kds = await readKdsLayout(client, input.branchId);
  if (!kds.enabled) return legacy;
  // Cashier lines name hashed menu ids: their slugs come from the active menu. Cloud lines
  // already name slugs, so the fulfillment worker never needs to read the menu.
  const slugs =
    input.snapshot.channel === 'pos'
      ? ((await readMenuKdsSlugs(client, input.branchId)) ?? noKdsSlugs)
      : cloudKdsSlugs;
  return (
    kdsTaskPlan({ snapshot: input.snapshot, legacy: legacy.plan, layout: kds.layout, slugs }) ??
    legacy
  );
}
