import {
  KitchenPasswordResetCommandSchema,
  KitchenPasswordResetReceiptSchema,
  KitchenPasswordResetRequestSchema,
} from '@pickchick/contracts';
import { transaction, type DatabasePool, type DatabaseClient } from '@pickchick/database';
import {
  authenticateTerminal,
  terminalHash,
  TerminalRateLimitError,
  type TerminalAuth,
} from './terminal-access.js';
import { makeStaffPasswordVerifier } from './staff-passwords.js';
import { audit } from './staff.js';
import { OrderError } from './errors.js';

let activeResets = 0;
const lock = (db: DatabaseClient, branch: string) =>
  db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['terminal-access:' + branch]);
/** Fixed login kitchen, existing active kitchen-role identity only. No PIN or role mutations. */
export class KitchenPasswordReset {
  constructor(
    private readonly pool: DatabasePool,
    private readonly branchId: string,
    private readonly edgeDeviceId: string,
  ) {}
  async receive(input: unknown) {
    const command = KitchenPasswordResetCommandSchema.parse(input);
    if (command.branchId !== this.branchId || command.edgeDeviceId !== this.edgeDeviceId)
      throw new OrderError('FORBIDDEN');
    return transaction(this.pool, async (db) => {
      await lock(db, this.branchId);
      if (
        !(
          await db.query('SELECT 1 FROM fulfillment_config WHERE branch_id=$1 AND device_id=$2', [
            this.branchId,
            this.edgeDeviceId,
          ])
        ).rowCount
      )
        throw new OrderError('FORBIDDEN');
      const prior = (
        await db.query(
          'SELECT payload,state FROM kitchen_password_reset_commands WHERE command_id=$1',
          [command.commandId],
        )
      ).rows[0];
      if (prior) {
        if (
          JSON.stringify(KitchenPasswordResetCommandSchema.parse(prior.payload)) !==
          JSON.stringify(command)
        )
          throw new OrderError('CONFLICT');
        return prior.state;
      }
      const staff = (
        await db.query(
          `SELECT s.id FROM local_staff s JOIN local_staff_passwords p ON p.staff_id=s.id AND p.branch_id=s.branch_id
        WHERE s.branch_id=$1 AND s.active AND s.role='kitchen' AND p.login='kitchen'`,
          [this.branchId],
        )
      ).rows[0];
      const clock = (
        await db.query(
          `SELECT $1::timestamptz<=clock_timestamp() AS expired,$2::timestamptz>clock_timestamp()+interval '30 seconds' AS future`,
          [command.expiresAt, command.issuedAt],
        )
      ).rows[0];
      const newer = (
        await db.query(
          'SELECT 1 FROM kitchen_password_reset_commands WHERE branch_id=$1 AND staff_id=$2 AND issued_at >= $3',
          [this.branchId, staff?.id ?? null, command.issuedAt],
        )
      ).rowCount;
      const state =
        !staff || clock.future || newer ? 'rejected' : clock.expired ? 'expired' : 'applied';
      if (state === 'applied')
        await db.query(
          "UPDATE kitchen_password_reset_commands SET state='expired' WHERE branch_id=$1 AND staff_id=$2 AND state='applied'",
          [this.branchId, staff.id],
        );
      await db.query(
        `INSERT INTO kitchen_password_reset_commands(command_id,branch_id,edge_device_id,staff_id,code_hash,payload,issued_at,expires_at,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          command.commandId,
          this.branchId,
          this.edgeDeviceId,
          staff?.id ?? null,
          command.codeHash,
          command,
          command.issuedAt,
          command.expiresAt,
          state,
        ],
      );
      return state;
    });
  }
  private async current(db: DatabaseClient, code: string, terminal: TerminalAuth, write = false) {
    const ticket = (
      await db.query(
        `SELECT command_id,staff_id FROM kitchen_password_reset_commands WHERE branch_id=$1 AND edge_device_id=$2
      AND code_hash=$3 AND state='applied' AND expires_at>clock_timestamp()`,
        [this.branchId, this.edgeDeviceId, terminalHash(code)],
      )
    ).rows[0];
    if (!ticket?.staff_id) throw new OrderError('UNAUTHORIZED');
    const staff = (
      await db.query(
        `SELECT id FROM local_staff WHERE id=$1 AND branch_id=$2 AND role='kitchen' AND active ${write ? 'FOR UPDATE' : 'FOR SHARE'}`,
        [ticket.staff_id, this.branchId],
      )
    ).rows[0];
    if (!staff) throw new OrderError('UNAUTHORIZED');
    await db.query('SELECT id FROM local_terminals WHERE id=$1 AND branch_id=$2 FOR SHARE', [
      terminal.id,
      this.branchId,
    ]);
    const bound = await authenticateTerminal(db, this.branchId, terminal);
    if (!['prep', 'assembly'].includes(bound.mode)) throw new OrderError('FORBIDDEN');
    const password = (
      await db.query(
        `SELECT staff_id FROM local_staff_passwords WHERE staff_id=$1 AND branch_id=$2 AND login='kitchen' ${write ? 'FOR UPDATE' : 'FOR SHARE'}`,
        [ticket.staff_id, this.branchId],
      )
    ).rows[0];
    if (!password) throw new OrderError('UNAUTHORIZED');
    return ticket as { command_id: string; staff_id: string };
  }
  async reset(input: unknown, terminal: TerminalAuth) {
    const parsed = KitchenPasswordResetRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.terminal_id !== terminal.id)
      throw new OrderError('UNAUTHORIZED');
    const body = parsed.data;
    const attempt = await transaction(this.pool, async (db) => {
      // The fixed branch budget cannot be bypassed with invented terminal IDs or codes.
      const result = await db.query(
        `INSERT INTO terminal_pair_limits(branch_id,window_started_at,attempts) VALUES($1,clock_timestamp(),1)
        ON CONFLICT(branch_id) DO UPDATE SET window_started_at=CASE WHEN terminal_pair_limits.window_started_at<=clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE terminal_pair_limits.window_started_at END,
        attempts=CASE WHEN terminal_pair_limits.window_started_at<=clock_timestamp()-interval '1 minute' THEN 1 ELSE terminal_pair_limits.attempts+1 END
        WHERE terminal_pair_limits.window_started_at<=clock_timestamp()-interval '1 minute' OR terminal_pair_limits.attempts<30 RETURNING attempts`,
        [this.branchId],
      );
      return result.rowCount === 1;
    });
    if (!attempt || activeResets >= 2) throw new TerminalRateLimitError();
    activeResets++;
    try {
      await transaction(this.pool, (db) => this.current(db, body.code, terminal));
      const verifier = await makeStaffPasswordVerifier(body.password);
      return await transaction(this.pool, async (db) => {
        await lock(db, this.branchId);
        const ticket = await this.current(db, body.code, terminal, true);
        const changed = await db.query(
          `UPDATE kitchen_password_reset_commands SET state='used' WHERE command_id=$1 AND state='applied' AND expires_at>clock_timestamp() RETURNING command_id`,
          [ticket.command_id],
        );
        if (changed.rowCount !== 1) throw new OrderError('UNAUTHORIZED');
        await db.query(
          `UPDATE local_staff_passwords SET salt=$2,verifier=$3,failed_attempts=0,locked_until=NULL,updated_at=clock_timestamp()
          WHERE staff_id=$1 AND branch_id=$4 AND login='kitchen'`,
          [ticket.staff_id, verifier.salt, verifier.verifier, this.branchId],
        );
        await db.query(
          'UPDATE staff_sessions SET revoked=true WHERE staff_id=$1 AND branch_id=$2',
          [ticket.staff_id, this.branchId],
        );
        await audit(
          db,
          this.branchId,
          ticket.staff_id,
          'staff.password_reset_by_owner_ticket',
          ticket.command_id,
        );
        return { reset: true as const };
      });
    } finally {
      activeResets--;
    }
  }
  async receipts() {
    await this.pool.query(
      "UPDATE kitchen_password_reset_commands SET state='expired' WHERE branch_id=$1 AND state='applied' AND expires_at<=clock_timestamp()",
      [this.branchId],
    );
    return (
      await this.pool.query(
        `SELECT command_id AS "commandId",state FROM kitchen_password_reset_commands WHERE branch_id=$1 AND edge_device_id=$2
      AND state IS DISTINCT FROM reported_state ORDER BY received_at,command_id LIMIT 50`,
        [this.branchId, this.edgeDeviceId],
      )
    ).rows.map((row) => KitchenPasswordResetReceiptSchema.parse(row));
  }
  async acknowledge(input: unknown) {
    const receipt = KitchenPasswordResetReceiptSchema.parse(input);
    await this.pool.query(
      'UPDATE kitchen_password_reset_commands SET reported_state=$2 WHERE command_id=$1 AND state=$2 AND branch_id=$3 AND edge_device_id=$4',
      [receipt.commandId, receipt.state, this.branchId, this.edgeDeviceId],
    );
  }
}
