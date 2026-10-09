import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import { authenticateDevice, type DeviceAuth } from '@pickchick/menu-sync';
import {
  DeviceAccessCommandSchema,
  DeviceAccessExchangeSchema,
  DeviceAccessExchangeResponseSchema,
  TerminalModeSchema,
  KitchenPasswordResetCommandSchema,
  type KitchenPasswordResetReceipt,
  type DeviceAccessReceipt,
} from '@pickchick/contracts';
import { BackofficeError, parse } from './model.js';

const request = z.strictObject({
  request_id: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  device_id: z.uuid().optional(),
  mode: TerminalModeSchema,
  name: z.string().trim().min(1).max(120),
  confirm_name: z.string().trim().min(1).max(120).optional(),
});
const revoke = z.strictObject({
  request_id: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  device_id: z.uuid(),
  confirm_name: z.string().trim().min(1).max(120),
});
export class DeviceAccessError extends Error {
  constructor(
    readonly code:
      | 'CODE_ALREADY_ISSUED'
      | 'DEVICE_ACCESS_RATE_LIMITED'
      | 'EDGE_UNAVAILABLE'
      | 'DEVICE_ACCESS_UNAVAILABLE',
  ) {
    super(code);
  }
}
type Actor = { id: string; organization_id: string; role: 'manager' | 'analyst' };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const hashDeviceCode = (code: string) => createHash('sha256').update(code).digest('hex');
export function deviceAccessEnabled(env: Record<string, string | undefined> = process.env) {
  const value = env['BACKOFFICE_DEVICE_ACCESS_ENABLED'] ?? 'false';
  if (!['true', 'false'].includes(value)) throw new Error('Invalid device access flag');
  return value === 'true';
}
async function event(
  db: DatabaseClient,
  branch: string,
  device: string,
  actorKind: 'backoffice' | 'edge',
  actorId: string,
  command: string,
  action: string,
  reason: string,
) {
  await db.query(
    `INSERT INTO device_events(id,device_id,branch_id,actor_kind,actor_id,command_id,action,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), device, branch, actorKind, actorId, command, action, reason],
  );
}
/** The scope is rechecked under the transaction that makes every mutation. */
export class DeviceRegistry {
  constructor(
    private readonly pool: DatabasePool,
    private readonly enabled = false,
  ) {}
  private async scope(
    db: DatabaseClient,
    token: string,
    branch: string,
    write = false,
  ): Promise<Actor> {
    if (!this.enabled) throw new DeviceAccessError('DEVICE_ACCESS_UNAVAILABLE');
    parse(z.uuid(), branch);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new BackofficeError('UNAUTHORIZED');
    const actor = (
      await db.query<Actor>(
        `SELECT id,organization_id FROM catalog_managers
      WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE`,
        [catalogHash(token)],
      )
    ).rows[0];
    if (!actor) throw new BackofficeError('UNAUTHORIZED');
    const grant = (
      await db.query<{ role: Actor['role'] }>(
        `SELECT g.role FROM bo_access_grants g
      JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id
      WHERE g.actor_id=$1 AND g.branch_id=$2 AND s.organization_id=$3 FOR SHARE OF g,s`,
        [actor.id, branch, actor.organization_id],
      )
    ).rows[0];
    if (!grant || (write && grant.role !== 'manager')) throw new BackofficeError('FORBIDDEN');
    return { ...actor, role: grant.role };
  }
  async read(token: string, branch: string) {
    return transaction(this.pool, async (db) => {
      const actor = await this.scope(db, token, branch);
      const devices = (
        await db.query(
          `SELECT d.id,d.name,d.kind,d.status,r.mode,r.generation,r.paired_at,
        a.observed_at AS last_seen_at,c.expires_at AS key_expires_at,
        cmd.id AS command_id,cmd.action AS command_action,cmd.state AS command_state,cmd.expires_at AS code_expires_at
        FROM devices d LEFT JOIN device_terminal_registry r ON r.device_id=d.id
        LEFT JOIN cloud_branch_availability a ON a.device_id=d.id AND a.branch_id=d.branch_id
        LEFT JOIN device_credentials c ON c.device_id=d.id
        LEFT JOIN cloud_device_commands cmd ON cmd.device_id=d.id AND cmd.generation=r.generation
        WHERE d.branch_id=$1 AND d.organization_id=$2 ORDER BY d.kind,d.name,d.id`,
          [branch, actor.organization_id],
        )
      ).rows;
      const kiosks = (
        await db.query(
          `SELECT id,'iPad '||left(id::text,8) AS name,'kiosk' AS kind,
        CASE WHEN active THEN 'active' ELSE 'revoked' END AS status FROM kiosk_devices WHERE branch_id=$1 AND organization_id=$2 ORDER BY id`,
          [branch, actor.organization_id],
        )
      ).rows;
      for (const kiosk of kiosks) {
        const existing = devices.findIndex((d) => d.id === kiosk.id);
        const row = {
          ...kiosk,
          mode: null,
          generation: null,
          paired_at: null,
          last_seen_at: null,
          key_expires_at: null,
          command_id: null,
          command_action: null,
          command_state: null,
          code_expires_at: null,
        };
        if (existing < 0) devices.push(row);
        else devices[existing] = { ...devices[existing], ...row, name: devices[existing].name };
      }
      // A connected edge is not proof that a particular kitchen browser is currently online.
      const password_reset =
        (
          await db.query(
            `SELECT id AS command_id,state,expires_at,created_at FROM cloud_kitchen_password_resets WHERE branch_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
            [branch],
          )
        ).rows[0] ?? null;
      return {
        branch_id: branch,
        role: actor.role,
        devices,
        password_reset,
        as_of: new Date().toISOString(),
      };
    });
  }
  async events(token: string, branch: string, device: string) {
    parse(z.uuid(), device);
    return transaction(this.pool, async (db) => {
      await this.scope(db, token, branch);
      if (
        !(await db.query('SELECT 1 FROM devices WHERE id=$1 AND branch_id=$2', [device, branch]))
          .rowCount
      )
        throw new BackofficeError('NOT_FOUND');
      return {
        events: (
          await db.query(
            `SELECT action,reason,actor_kind,at FROM device_events
        WHERE device_id=$1 AND branch_id=$2 ORDER BY at DESC,id DESC LIMIT 50`,
            [device, branch],
          )
        ).rows,
      };
    });
  }
  async issue(token: string, branch: string, input: unknown) {
    const body = parse(request, input),
      code = randomBytes(16).toString('hex');
    return this.mutate(token, branch, 'pair', body, code);
  }
  async revoke(token: string, branch: string, input: unknown) {
    return this.mutate(token, branch, 'revoke', parse(revoke, input));
  }
  async issueKitchenReset(token: string, branch: string, input: unknown) {
    const body = parse(
      z.strictObject({
        request_id: z.uuid(),
        reason: z.string().trim().min(3).max(500),
        confirm_login: z.literal('kitchen'),
      }),
      input,
    );
    const code = randomBytes(16).toString('hex');
    return transaction(this.pool, async (db) => {
      const actor = await this.scope(db, token, branch, true);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'device-access-actor:' + actor.id,
      ]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'device-access:' + branch,
      ]);
      const hash = digest({ branch, body }),
        prior = (
          await db.query(
            'SELECT request_digest FROM cloud_kitchen_password_resets WHERE actor_id=$1 AND request_id=$2',
            [actor.id, body.request_id],
          )
        ).rows[0];
      if (prior) {
        if (prior.request_digest !== hash) throw new BackofficeError('CONFLICT');
        throw new DeviceAccessError('CODE_ALREADY_ISSUED');
      }
      const limits = (
        await db.query(
          `SELECT count(*) FILTER(WHERE actor_id=$1 AND created_at>clock_timestamp()-interval '10 minutes') AS recent,
        count(*) FILTER(WHERE branch_id=$2 AND expires_at>clock_timestamp() AND state IN ('pending','delivered','applied')) AS open
        FROM cloud_kitchen_password_resets`,
          [actor.id, branch],
        )
      ).rows[0]!;
      if (Number(limits.recent) >= 3) throw new DeviceAccessError('DEVICE_ACCESS_RATE_LIMITED');
      if (Number(limits.open) > 0) throw new DeviceAccessError('CODE_ALREADY_ISSUED');
      const edge = (
        await db.query(
          `SELECT d.id FROM devices d JOIN fulfillment_transport_bindings b ON b.device_id=d.id AND b.branch_id=d.branch_id
        WHERE d.branch_id=$1 AND d.organization_id=$2 AND d.kind='edge' AND d.status='active' AND b.active FOR SHARE OF d,b`,
          [branch, actor.organization_id],
        )
      ).rows[0];
      if (!edge) throw new DeviceAccessError('EDGE_UNAVAILABLE');
      const command = randomUUID(),
        created = (
          await db.query(
            `WITH t AS (SELECT clock_timestamp() AS at)
        INSERT INTO cloud_kitchen_password_resets(id,branch_id,edge_device_id,login,code_hash,actor_id,request_id,request_digest,reason,created_at,expires_at)
        SELECT $1,$2,$3,'kitchen',$4,$5,$6,$7,$8,t.at,t.at+interval '10 minutes' FROM t RETURNING expires_at`,
            [
              command,
              branch,
              edge.id,
              hashDeviceCode(code),
              actor.id,
              body.request_id,
              hash,
              body.reason,
            ],
          )
        ).rows[0]!;
      await resetEvent(db, branch, actor.id, 'backoffice', command, 'issued', body.reason);
      return {
        command_id: command,
        code: code.match(/.{4}/g)!.join('-'),
        expires_at: created.expires_at,
        purpose: 'kitchen-password-reset',
      };
    });
  }
  async resetEvents(token: string, branch: string) {
    return transaction(this.pool, async (db) => {
      await this.scope(db, token, branch);
      return {
        events: (
          await db.query(
            'SELECT action,reason,actor_kind,at FROM kitchen_password_reset_events WHERE branch_id=$1 ORDER BY at DESC,id DESC LIMIT 50',
            [branch],
          )
        ).rows,
      };
    });
  }
  private async mutate(
    token: string,
    branch: string,
    action: 'pair' | 'revoke',
    body: z.infer<typeof request> | z.infer<typeof revoke>,
    code?: string,
  ) {
    return transaction(this.pool, async (db) => {
      const actor = await this.scope(db, token, branch, true);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'device-access-actor:' + actor.id,
      ]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'device-access:' + branch,
      ]);
      const hash = digest({ branch, action, body });
      const prior = (
        await db.query(
          'SELECT id,request_digest,device_id FROM cloud_device_commands WHERE actor_id=$1 AND request_id=$2',
          [actor.id, body.request_id],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_digest !== hash) throw new BackofficeError('CONFLICT');
        // Plaintext codes never enter persisted command responses or replay storage.
        if (action === 'pair') throw new DeviceAccessError('CODE_ALREADY_ISSUED');
        return { command_id: prior.id, device_id: prior.device_id };
      }
      const recent = (
        await db.query<{ count: string }>(
          `SELECT count(*) FROM cloud_device_commands WHERE
        actor_id=$1 AND created_at>clock_timestamp()-interval '10 minutes'`,
          [actor.id],
        )
      ).rows[0]!;
      if (Number(recent.count) >= 10) throw new DeviceAccessError('DEVICE_ACCESS_RATE_LIMITED');
      let device = body.device_id,
        generation = 1;
      let edge: string;
      if (device) {
        const old = (
          await db.query(
            `SELECT d.name,d.kind,d.status,r.edge_device_id,r.generation,r.mode FROM devices d
          LEFT JOIN device_terminal_registry r ON r.device_id=d.id WHERE d.id=$1 AND d.branch_id=$2 FOR UPDATE OF d`,
            [device, branch],
          )
        ).rows[0];
        if (!old) throw new BackofficeError('NOT_FOUND');
        if (old.kind === 'edge')
          throw new BackofficeError('CONFLICT', 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL');
        if (old.name !== body.confirm_name)
          throw new BackofficeError('CONFLICT', 'DEVICE_NAME_CONFIRMATION_REQUIRED');
        if (!old.edge_device_id || old.status === 'revoked') throw new BackofficeError('CONFLICT');
        if (
          action === 'pair' &&
          'mode' in body &&
          (body.mode !== old.mode || body.name !== old.name)
        )
          throw new BackofficeError('CONFLICT');
        edge = old.edge_device_id;
        generation = Number(old.generation) + 1;
        if (generation > 2147483646) throw new BackofficeError('CONFLICT');
        await db.query(
          'UPDATE device_terminal_registry SET generation=$2,paired_at=NULL WHERE device_id=$1',
          [device, generation],
        );
      } else {
        if (action !== 'pair' || !('mode' in body)) throw new BackofficeError('INVALID_REQUEST');
        const row = (
          await db.query(
            `SELECT d.id FROM devices d JOIN fulfillment_transport_bindings b ON b.device_id=d.id AND b.branch_id=d.branch_id
          WHERE d.branch_id=$1 AND d.organization_id=$2 AND d.kind='edge' AND d.status='active' AND b.active FOR SHARE OF d,b`,
            [branch, actor.organization_id],
          )
        ).rows[0];
        if (!row) throw new DeviceAccessError('EDGE_UNAVAILABLE');
        edge = row.id;
        device = randomUUID();
        const pending = (
          await db.query<{ count: string }>(
            `SELECT count(*) FROM cloud_device_commands WHERE branch_id=$1 AND action='pair'
          AND state IN ('pending','delivered','applied') AND expires_at>clock_timestamp()`,
            [branch],
          )
        ).rows[0]!;
        if (Number(pending.count) >= 10) throw new DeviceAccessError('DEVICE_ACCESS_RATE_LIMITED');
        await db.query(
          `INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,$4,$5)`,
          [
            device,
            branch,
            actor.organization_id,
            body.mode === 'display' ? 'display' : 'kitchen',
            body.name,
          ],
        );
        await db.query(
          `INSERT INTO device_terminal_registry(device_id,branch_id,edge_device_id,mode) VALUES($1,$2,$3,$4)`,
          [device, branch, edge, body.mode],
        );
      }
      // Do not disable any existing edge/kiosk identity. The edge ACK is the device verdict.
      const command = randomUUID();
      const created = (
        await db.query(
          `WITH t AS (SELECT clock_timestamp() AS at)
        INSERT INTO cloud_device_commands(id,device_id,branch_id,edge_device_id,generation,action,code_hash,actor_id,request_id,request_digest,reason,created_at,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,t.at,t.at+$12*interval '1 second' FROM t RETURNING expires_at`,
          [
            command,
            device,
            branch,
            edge,
            generation,
            action,
            code ? hashDeviceCode(code) : null,
            actor.id,
            body.request_id,
            hash,
            body.reason,
            action === 'pair' ? 600 : 120,
          ],
        )
      ).rows[0]!;
      await event(
        db,
        branch,
        device,
        'backoffice',
        actor.id,
        command,
        action === 'pair' ? 'code_issued' : 'revoke_requested',
        body.reason,
      );
      return {
        device_id: device,
        command_id: command,
        expires_at: created.expires_at,
        ...(code ? { code: code.match(/.{4}/g)!.join('-') } : {}),
      };
    });
  }
}

/** Independent narrow mailbox. The edge's authenticated binding determines its branch. */
export async function exchangeDeviceAccess(pool: DatabasePool, auth: DeviceAuth, input: unknown) {
  const body = parse(DeviceAccessExchangeSchema, input);
  return transaction(pool, async (db) => {
    const branch = await authenticateDevice(db, auth);
    if (
      !(
        await db.query(
          'SELECT 1 FROM fulfillment_transport_bindings WHERE branch_id=$1 AND device_id=$2 AND active FOR SHARE',
          [branch, auth.deviceId],
        )
      ).rowCount
    )
      throw new BackofficeError('FORBIDDEN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'device-access:' + branch,
    ]);
    const acknowledged: DeviceAccessReceipt[] = [];
    for (const receipt of body.receipts) {
      const cmd = (
        await db.query(
          `SELECT * FROM cloud_device_commands WHERE id=$1 AND branch_id=$2 AND edge_device_id=$3 FOR UPDATE`,
          [receipt.commandId, branch, auth.deviceId],
        )
      ).rows[0];
      if (!cmd || cmd.device_id !== receipt.terminalId || cmd.generation !== receipt.generation)
        throw new BackofficeError('CONFLICT');
      if (receipt.state === 'paired' && cmd.action !== 'pair')
        throw new BackofficeError('CONFLICT');
      if (cmd.state !== receipt.state && !['paired', 'rejected', 'expired'].includes(cmd.state)) {
        // Paired ACK can follow applied; duplicate/stale receipt cannot regress a terminal state.
        await db.query(
          'UPDATE cloud_device_commands SET state=$2,resolved_at=clock_timestamp() WHERE id=$1',
          [cmd.id, receipt.state],
        );
        await event(
          db,
          branch,
          cmd.device_id,
          'edge',
          auth.deviceId,
          cmd.id,
          receipt.state,
          'Подтверждение локальной кассы',
        );
        const current = (
          await db.query(
            'SELECT generation FROM device_terminal_registry WHERE device_id=$1 FOR UPDATE',
            [cmd.device_id],
          )
        ).rows[0];
        if (current?.generation === cmd.generation) {
          if (receipt.state === 'paired') {
            await db.query(
              'UPDATE device_terminal_registry SET paired_at=clock_timestamp() WHERE device_id=$1',
              [cmd.device_id],
            );
            await db.query("UPDATE devices SET status='active' WHERE id=$1", [cmd.device_id]);
          } else if (receipt.state === 'applied' && cmd.action === 'revoke')
            await db.query("UPDATE devices SET status='revoked' WHERE id=$1", [cmd.device_id]);
          else if (receipt.state === 'applied' && cmd.action === 'pair')
            await db.query("UPDATE devices SET status='pending' WHERE id=$1", [cmd.device_id]);
        }
      }
      acknowledged.push(receipt);
    }
    const resetAcknowledged: KitchenPasswordResetReceipt[] = [];
    for (const receipt of body.resetReceipts) {
      const cmd = (
        await db.query(
          'SELECT * FROM cloud_kitchen_password_resets WHERE id=$1 AND branch_id=$2 AND edge_device_id=$3 FOR UPDATE',
          [receipt.commandId, branch, auth.deviceId],
        )
      ).rows[0];
      if (!cmd) throw new BackofficeError('CONFLICT');
      if (cmd.state !== receipt.state && !['used', 'expired', 'rejected'].includes(cmd.state)) {
        await db.query(
          'UPDATE cloud_kitchen_password_resets SET state=$2,resolved_at=clock_timestamp() WHERE id=$1',
          [cmd.id, receipt.state],
        );
        await resetEvent(
          db,
          branch,
          auth.deviceId,
          'edge',
          cmd.id,
          receipt.state,
          'Подтверждение локальной кассы',
        );
      }
      resetAcknowledged.push(receipt);
    }
    const resets = (
      await db.query(
        `SELECT * FROM cloud_kitchen_password_resets WHERE edge_device_id=$1 AND branch_id=$2
      AND state IN ('pending','delivered') ORDER BY created_at,id LIMIT 25 FOR UPDATE`,
        [auth.deviceId, branch],
      )
    ).rows;
    for (const row of resets) {
      if (row.state === 'pending')
        await resetEvent(
          db,
          branch,
          auth.deviceId,
          'edge',
          row.id,
          'delivered',
          'Команда передана кассе',
        );
      await db.query(
        "UPDATE cloud_kitchen_password_resets SET state='delivered',delivered_at=clock_timestamp() WHERE id=$1",
        [row.id],
      );
    }
    // Late edge receipts remain acceptable: receipt loss must not hide an already paired screen.
    const rows = (
      await db.query(
        `SELECT c.*,d.name,r.mode FROM cloud_device_commands c JOIN devices d ON d.id=c.device_id
      JOIN device_terminal_registry r ON r.device_id=c.device_id AND r.generation=c.generation
      WHERE c.edge_device_id=$1 AND c.branch_id=$2 AND c.state IN ('pending','delivered')
      ORDER BY c.created_at,c.id LIMIT 25 FOR UPDATE OF c`,
        [auth.deviceId, branch],
      )
    ).rows;
    for (const row of rows) {
      if (row.state === 'pending')
        await event(
          db,
          branch,
          row.device_id,
          'edge',
          auth.deviceId,
          row.id,
          'delivered',
          'Команда передана кассе',
        );
      await db.query(
        "UPDATE cloud_device_commands SET state='delivered',delivered_at=clock_timestamp() WHERE id=$1",
        [row.id],
      );
    }
    return DeviceAccessExchangeResponseSchema.parse({
      branchId: branch,
      edgeDeviceId: auth.deviceId,
      acknowledged,
      resetAcknowledged,
      resetCommands: resets.map((row) =>
        KitchenPasswordResetCommandSchema.parse({
          commandId: row.id,
          branchId: branch,
          edgeDeviceId: auth.deviceId,
          login: row.login,
          codeHash: row.code_hash,
          issuedAt: row.created_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
        }),
      ),
      commands: rows.map((row) =>
        DeviceAccessCommandSchema.parse({
          commandId: row.id,
          branchId: branch,
          edgeDeviceId: auth.deviceId,
          terminalId: row.device_id,
          mode: row.mode,
          name: row.name,
          generation: row.generation,
          action: row.action,
          codeHash: row.code_hash,
          issuedAt: row.created_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
        }),
      ),
    });
  });
}

async function resetEvent(
  db: DatabaseClient,
  branch: string,
  actor: string,
  kind: 'backoffice' | 'edge',
  command: string,
  action: string,
  reason: string,
) {
  await db.query(
    'INSERT INTO kitchen_password_reset_events(id,command_id,branch_id,actor_kind,actor_id,action,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), command, branch, kind, actor, action, reason],
  );
}
