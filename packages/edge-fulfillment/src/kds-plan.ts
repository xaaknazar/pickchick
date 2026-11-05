import type { DatabaseClient } from '@pickchick/database';
import { taskPlan } from './model.js';
import type { Routing, Snapshot, TaskPlan } from './model.js';

export type KitchenPlan = { plan: TaskPlan[]; assemblyStationId: string };
/**
 * Cutover seam (contracts section 5.2): the one place both admission paths get their task plan
 * and finishing station. Signature frozen; owner after D0: KDS lane. Without an enabled KDS
 * layout the result is exactly taskPlan(snapshot, routing) and routing.assemblyStationId.
 */
export async function buildKitchenPlan(
  client: DatabaseClient,
  input: { branchId: string; snapshot: Snapshot; routing: Routing },
): Promise<KitchenPlan> {
  void client;
  return {
    plan: taskPlan(input.snapshot, input.routing),
    assemblyStationId: input.routing.assemblyStationId,
  };
}
