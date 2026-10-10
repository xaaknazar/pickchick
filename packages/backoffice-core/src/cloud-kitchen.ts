import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import { KITCHEN_PRESENCE_SECONDS, digest } from '@pickchick/commerce-core';
import {
  CloudKitchenError,
  createScreenInTransaction,
  issuePairingCodeInTransaction,
  listScreens,
  revokeScreenInTransaction,
} from '@pickchick/cloud-kitchen';
import { BackofficeError } from './model.js';

/**
 * Back-office management of the cloud kitchen channel (ADR-0014 S4): kitchen screens and their
 * one-time pairing codes, and the branch mode switch edge <-> cloud. Same manager token and
 * branch grant as the rest of the back office; every write needs a reason and is audited in
 * bo_audit (and the screen journal of cloud 056). Off unless BACKOFFICE_ENABLED and
 * BACKOFFICE_CLOUD_KITCHEN_ENABLED are both true. Nothing here touches devices (051) or the
 * cashier.
 *
 * The runtime kitchen service is re-exported for the API, which reaches
 * @pickchick/cloud-kitchen through this package.
 */
export {
  CloudKitchen,
  CloudKitchenError,
  KitchenScreens,
  authenticateScreen,
  exchangePairingCode,
  provisionCloudKitchen,
} from '@pickchick/cloud-kitchen';
export type { KitchenActor, KitchenScreen } from '@pickchick/cloud-kitchen';

export interface CloudKitchenBackofficeOptions {
  /** BACKOFFICE_ENABLED */
  enabled: boolean;
  /** BACKOFFICE_CLOUD_KITCHEN_ENABLED */
  cloudKitchenEnabled: boolean;
}
export function cloudKitchenBackofficeOptions(
  env: Record<string, string | undefined> = process.env,
): CloudKitchenBackofficeOptions {
  const flag = (name: string) => {
    const value = env[name] ?? 'false';
    if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
    return value === 'true';
  };
  return {
    // Validated by the platform configuration; only the new flag is strict here.
    enabled: env['BACKOFFICE_ENABLED'] === 'true',
    cloudKitchenEnabled: flag('BACKOFFICE_CLOUD_KITCHEN_ENABLED'),
  };
}

interface Actor {
  id: string;
  organization_id: string;
  role: 'manager' | 'analyst';
}
const Reason = z.string().trim().min(3).max(300);
const CreateScreen = z.strictObject({
  role: z.enum(['prep', 'assembly', 'display']),
  stationIds: z.array(z.uuid()).max(20),
  name: z.string().trim().min(1).max(100),
  reason: Reason,
});
const ScreenWrite = z.strictObject({ reason: Reason });
const Revoke = z.strictObject({ requestId: z.uuid(), reason: Reason });
const ModeSwitch = z.strictObject({
  requestId: z.uuid(),
  owner: z.enum(['edge', 'cloud']),
  expectedEpoch: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: Reason,
});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BackofficeError('INVALID_REQUEST');
  return result.data;
}
const KITCHEN_CODES: Record<CloudKitchenError['code'], BackofficeError['code']> = {
  INVALID: 'INVALID_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  NOT_READY: 'NOT_READY',
  ROUTING_MISSING: 'NOT_READY',
};

async function audit(
  db: DatabaseClient,
  actor: Actor,
  branchId: string,
  requestId: string,
  action: string,
  entityId: string | null,
  reason: string,
  before: unknown,
  after: unknown,
) {
  await db.query(
    'INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      randomUUID(),
      branchId,
      actor.organization_id,
      actor.id,
      requestId,
      action,
      entityId,
      reason,
      before,
      after,
    ],
  );
}
/** bo_commands journal: the same request replays its first result, another body conflicts. */
async function once<T>(
  db: DatabaseClient,
  actor: Actor,
  branchId: string,
  requestId: string,
  body: unknown,
  run: () => Promise<T>,
): Promise<T> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'bo_command:' + actor.id + ':' + requestId,
  ]);
  const hash = digest(body);
  const old = (
    await db.query<{ digest: string; result: T; branch_id: string }>(
      'SELECT digest,result,branch_id FROM bo_commands WHERE actor_id=$1 AND request_id=$2',
      [actor.id, requestId],
    )
  ).rows[0];
  if (old) {
    if (old.digest !== hash || old.branch_id !== branchId) throw new BackofficeError('CONFLICT');
    return old.result;
  }
  const result = await run();
  await db.query(
    'INSERT INTO bo_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
    [actor.id, requestId, branchId, hash, result],
  );
  return result;
}
async function modeOf(db: Pick<DatabaseClient, 'query'>, branchId: string) {
  const row = (
    await db.query<{
      cloud_channels_owner: 'edge' | 'cloud';
      epoch: string;
      changed_by: string;
      reason: string;
      changed_at: Date;
    }>(
      'SELECT cloud_channels_owner,epoch::text,changed_by,reason,changed_at FROM branch_channel_modes WHERE branch_id=$1',
      [branchId],
    )
  ).rows[0];
  return {
    owner: row?.cloud_channels_owner ?? ('edge' as const),
    epoch: Number(row?.epoch ?? 0),
    changedBy: row?.changed_by ?? null,
    reason: row?.reason ?? null,
    changedAt: row?.changed_at.toISOString() ?? null,
  };
}

export class CloudKitchenBackoffice {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: CloudKitchenBackofficeOptions,
  ) {}
  private async scope(db: DatabaseClient, token: string, branch: string, write = false) {
    if (this.options.enabled !== true || this.options.cloudKitchenEnabled !== true)
      throw new BackofficeError('SERVICE_UNAVAILABLE');
    parse(z.uuid(), branch);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new BackofficeError('UNAUTHORIZED');
    const actor = (
      await db.query<{ id: string; organization_id: string }>(
        'SELECT id,organization_id FROM catalog_managers WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE',
        [catalogHash(token)],
      )
    ).rows[0];
    if (!actor) throw new BackofficeError('UNAUTHORIZED');
    const grant = (
      await db.query<{ role: Actor['role'] }>(
        'SELECT g.role FROM bo_access_grants g JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id WHERE g.actor_id=$1 AND g.branch_id=$2 AND s.organization_id=$3 FOR SHARE OF g,s',
        [actor.id, branch, actor.organization_id],
      )
    ).rows[0];
    if (!grant || (write && grant.role !== 'manager')) throw new BackofficeError('FORBIDDEN');
    return { ...actor, role: grant.role } satisfies Actor;
  }
  private async run<T>(
    token: string,
    branch: string,
    write: boolean,
    fn: (db: DatabaseClient, actor: Actor) => Promise<T>,
  ) {
    try {
      return await transaction(this.pool, async (db) =>
        fn(db, await this.scope(db, token, branch, write)),
      );
    } catch (error) {
      if (error instanceof BackofficeError) throw error;
      if (error instanceof CloudKitchenError) throw new BackofficeError(KITCHEN_CODES[error.code]);
      const code = String((error as { code?: unknown } | null)?.code ?? '');
      if (code === '55000' || code === '23505' || code === '23514')
        throw new BackofficeError('CONFLICT');
      if (code === '23503') throw new BackofficeError('INVALID_REQUEST');
      if (['40001', '40P01'].includes(code)) throw new BackofficeError('SERVICE_UNAVAILABLE');
      throw error;
    }
  }

  /** Screens, stations and the cloud kitchen presence of the branch. */
  async read(token: string, branch: string) {
    return this.run(token, branch, false, async (db) => {
      const stations = (
        await db.query<{ id: string; kind: 'prep' | 'assembly'; name: string; fresh: boolean }>(
          `SELECT s.id,s.kind,s.name,coalesce(bool_or(p.seen_at>clock_timestamp()-$2*interval '1 second'),false) AS fresh
           FROM cloud_kitchen_stations s LEFT JOIN cloud_kitchen_station_presence p ON p.branch_id=s.branch_id AND p.station_id=s.id
           WHERE s.branch_id=$1 GROUP BY s.id,s.kind,s.name ORDER BY s.kind,s.name,s.id`,
          [branch, KITCHEN_PRESENCE_SECONDS],
        )
      ).rows;
      const routing = (
        await db.query<{ active_routing_version: number }>(
          'SELECT active_routing_version FROM cloud_kitchen_config WHERE branch_id=$1',
          [branch],
        )
      ).rows[0];
      const online = (kind: 'prep' | 'assembly') =>
        stations.some((s) => s.kind === kind && s.fresh);
      return {
        mode: await modeOf(db, branch),
        routingVersion: routing?.active_routing_version ?? null,
        kitchenOnline: online('prep') && online('assembly'),
        stations: stations.map((s) => ({ id: s.id, kind: s.kind, name: s.name, online: s.fresh })),
        screens: (await listScreens(db, branch)).items,
      };
    });
  }
  /** New screen and its first one-time pairing code (shown once, valid 10 minutes). */
  async createScreen(token: string, branch: string, input: unknown) {
    const request = parse(CreateScreen, input);
    return this.run(token, branch, true, async (db, actor) => {
      const screen = await createScreenInTransaction(db, {
        branchId: branch,
        role: request.role,
        stationIds: request.stationIds,
        name: request.name,
        actor: 'bo:' + actor.id,
        reason: request.reason,
      });
      const code = await issuePairingCodeInTransaction(db, {
        branchId: branch,
        screenId: screen.screenId,
        actor: 'bo:' + actor.id,
        reason: request.reason,
      });
      await audit(
        db,
        actor,
        branch,
        randomUUID(),
        'cloud_kitchen:screen_create',
        screen.screenId,
        request.reason,
        null,
        { ...screen, pairingCodeExpiresAt: code.expiresAt },
      );
      return { screen: code.screen, pairingCode: code.pairingCode, expiresAt: code.expiresAt };
    });
  }
  /** New pairing code for a live screen (re-pairing or key rotation; the old key works until
   * the screen exchanges the new code). Never replayed: every call issues a new code. */
  async issuePairingCode(token: string, branch: string, screenId: string, input: unknown) {
    parse(z.uuid(), screenId);
    const request = parse(ScreenWrite, input);
    return this.run(token, branch, true, async (db, actor) => {
      const code = await issuePairingCodeInTransaction(db, {
        branchId: branch,
        screenId,
        actor: 'bo:' + actor.id,
        reason: request.reason,
      });
      await audit(
        db,
        actor,
        branch,
        randomUUID(),
        'cloud_kitchen:pairing_code',
        screenId,
        request.reason,
        null,
        { generation: code.screen.generation, expiresAt: code.expiresAt },
      );
      return code;
    });
  }
  /** Revoke at once: the screen key and any open code stop working. */
  async revokeScreen(token: string, branch: string, screenId: string, input: unknown) {
    parse(z.uuid(), screenId);
    const request = parse(Revoke, input);
    return this.run(token, branch, true, (db, actor) =>
      once(db, actor, branch, request.requestId, { screenId, ...request }, async () => {
        const before = (await listScreens(db, branch)).items.find((s) => s.screenId === screenId);
        if (!before) throw new BackofficeError('NOT_FOUND');
        const after = await revokeScreenInTransaction(db, {
          branchId: branch,
          screenId,
          actor: 'bo:' + actor.id,
          reason: request.reason,
        });
        await audit(
          db,
          actor,
          branch,
          request.requestId,
          'cloud_kitchen:screen_revoke',
          screenId,
          request.reason,
          before,
          after,
        );
        return after;
      }),
    );
  }
  async readMode(token: string, branch: string) {
    return this.run(token, branch, false, (db) => modeOf(db, branch));
  }
  /**
   * Switch kiosk/mobile fulfillment of the branch between the cashier (edge) and the cloud
   * kitchen. `expectedEpoch` is the epoch the manager saw: a concurrent switch is a CONFLICT.
   * Switching to cloud needs provisioned routing. Orders already paid keep their owner.
   */
  async setMode(token: string, branch: string, input: unknown) {
    const request = parse(ModeSwitch, input);
    return this.run(token, branch, true, (db, actor) =>
      once(db, actor, branch, request.requestId, request, async () => {
        const before = await modeOf(db, branch);
        if (before.epoch !== request.expectedEpoch || before.owner === request.owner)
          throw new BackofficeError('CONFLICT');
        if (
          request.owner === 'cloud' &&
          !(await db.query('SELECT 1 FROM cloud_kitchen_config WHERE branch_id=$1', [branch]))
            .rowCount
        )
          throw new BackofficeError('NOT_READY');
        await db.query('SELECT * FROM cloud_kitchen_set_mode($1,$2,$3,$4)', [
          branch,
          request.owner,
          'bo:' + actor.id,
          request.reason,
        ]);
        const after = await modeOf(db, branch);
        await audit(
          db,
          actor,
          branch,
          request.requestId,
          'cloud_kitchen:mode',
          null,
          request.reason,
          before,
          after,
        );
        return after;
      }),
    );
  }
}
