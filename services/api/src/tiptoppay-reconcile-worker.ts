import { createHmac } from 'node:crypto';
import { createPool, transaction } from '@pickchick/database';
import { TipTopPayReceiver, tipTopPayConfig, findTipTopPayPayment } from '@pickchick/commerce-core';

// Separate explicit worker gate. This executable has no submit/charge/refund operation.
async function main() {
  if (process.env.TIPTOPPAY_RECONCILE_ENABLED !== 'true') return;
  const config = tipTopPayConfig(process.env);
  if (!config) throw new Error('TIPTOPPAY_RECONCILE_NOT_CONFIGURED');
  const databaseUrl =
    process.env.TIPTOPPAY_RECONCILE_DATABASE_URL ?? process.env.CLOUD_DATABASE_URL;
  if (!databaseUrl) throw new Error('TIPTOPPAY_RECONCILE_DATABASE_NOT_CONFIGURED');
  const pool = createPool(databaseUrl);
  try {
    const due = await transaction(pool, async (client) => {
      const rows = await client.query<{ attempt_id: string }>(
        `SELECT s.attempt_id FROM commerce_tiptoppay_sessions s
        JOIN commerce_payment_attempts a ON a.id=s.attempt_id
        WHERE a.account_id=$1 AND a.state IN ('pending','unknown') AND s.opened_at IS NOT NULL
         AND s.reconcile_attempts<20 AND (s.last_reconcile_at IS NULL OR s.last_reconcile_at<clock_timestamp()-interval '2 minutes')
        ORDER BY s.created_at LIMIT 10 FOR UPDATE OF s SKIP LOCKED`,
        [config.accountId],
      );
      for (const row of rows.rows)
        await client.query(
          `UPDATE commerce_tiptoppay_sessions SET reconcile_attempts=reconcile_attempts+1,last_reconcile_at=clock_timestamp() WHERE attempt_id=$1`,
          [row.attempt_id],
        );
      return rows.rows;
    });
    for (const row of due) {
      try {
        const fields = await findTipTopPayPayment(config, row.attempt_id);
        if (!fields) continue;
        const raw = Buffer.from(new URLSearchParams(fields).toString());
        // Authenticated fixed-origin API result goes through the same strict binding/inbox path.
        await new TipTopPayReceiver(pool, config).receive(
          'pay',
          raw,
          createHmac('sha256', config.apiSecret).update(raw).digest('base64'),
        );
      } catch {
        console.error('TIPTOPPAY_RECONCILE_UNRESOLVED');
      }
    }
  } finally {
    await pool.end();
  }
}
await main();
