import { UuidSchema } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { authenticateStaff, requirePermission, audit } from './staff.js';
import type { StaffAuth } from './staff.js';
import { OrderError } from './errors.js';
import { posSalesInstalled } from './approvals.js';
import { lockBranch } from './commands.js';
import { FISCAL_RECEIPT_COLUMNS, appendFiscalEvent, fiscalReceipt } from './pos-outbox.js';
import { WEBKASSA_CODE } from '@pickchick/webkassa';
import type {
  FiscalCheck,
  FiscalLine,
  FiscalPayment,
  WebkassaClient,
  WebkassaError,
  WebkassaPaymentType,
  WebkassaPrintLine,
} from '@pickchick/webkassa';
import type { PosPaymentMethod } from '@pickchick/contracts';
import qrcode from 'qrcode-generator';

/**
 * Webkassa PaymentType by our tender method: 0 cash, 1 bank card, 4 mobile payment. Kaspi QR and
 * Kaspi transfers are mobile payments; the Kaspi Smart POS terminal takes cards and QR, so its
 * part counts as card (accountant to confirm, docs/integrations/webkassa-api.md).
 */
export const WEBKASSA_PAYMENT_TYPE: Partial<Record<PosPaymentMethod, WebkassaPaymentType>> = {
  cash: 0,
  kaspi_terminal: 1,
  kaspi_manual: 4,
};

/**
 * Automatic Webkassa sale receipts (docs/integrations/webkassa-api.md, stage 1).
 *
 * A POS sale writes its `pos_fiscal_receipts` row `pending` as before (schema026, ADR-0015). With
 * a Webkassa account file the point server issues that receipt itself: our receipt id is the
 * ExternalCheckNumber, so a repeat after a lost answer resolves to the same Webkassa receipt
 * (Code 14) and never makes a second one. The Webkassa CheckNumber is recorded exactly like a
 * number the cashier types (pending -> recorded, the sale's cashier as the recorder) and the
 * `fiscal` posSales event goes to the cloud as before. No schema change: the receipt itself,
 * its print form and QR stay in Webkassa and are fetched by our id when the POS prints.
 *
 * Stage 1 limits, kept manual (the existing «Чеки Webkassa» list): refund receipts, because the
 * Webkassa return needs the sale's shift and time which schema026 does not keep; and a receipt
 * Webkassa refuses (the error is shown to the POS, the cashier can still type a number).
 *
 * All Webkassa calls of the branch go through one queue: the vendor requires requests for one
 * register strictly one after another.
 */
export interface WebkassaFiscalStatus {
  receiptId: string;
  state: 'pending' | 'recorded' | 'not_required';
  receiptNumber: string | null;
  /** Last Webkassa refusal for a pending receipt (code and text), null while retrying silently. */
  error: WebkassaError | null;
  attempts: number;
}

interface PendingRow {
  id: string;
  order_id: string;
  amount_minor: string;
  display_number: number | null;
  cashier_staff_id: string;
  snapshot: { lines?: Array<{ name?: unknown; quantity?: unknown; total_minor?: unknown }> };
}

const MAX_BATCH = 10;
/** A refused receipt is tried again after this long (the cabinet may be fixed meanwhile). */
const REFUSED_RETRY_MS = 5 * 60 * 1000;

function lineName(name: unknown): string {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') {
    const n = name as Record<string, unknown>;
    for (const key of ['ru', 'kk', 'en'])
      if (typeof n[key] === 'string' && (n[key] as string).trim()) return n[key] as string;
  }
  return 'Позиция';
}

/**
 * Lines of the receipt from the sale's quote snapshot: the line total over its quantity is the
 * unit price (modifiers included); a remainder that does not divide goes into a line discount so
 * the receipt total equals the sale total to the tiyn.
 */
export function fiscalLinesOf(snapshot: PendingRow['snapshot'], total: bigint): FiscalLine[] {
  const lines = Array.isArray(snapshot.lines) ? snapshot.lines : [];
  const result = lines.map((line) => {
    const quantity = Number(line.quantity);
    const lineTotal = BigInt(String(line.total_minor));
    if (!Number.isInteger(quantity) || quantity < 1 || lineTotal <= 0n)
      throw new Error('Invalid quote line');
    const q = BigInt(quantity);
    const unit = (lineTotal + q - 1n) / q;
    return {
      name: lineName(line.name),
      quantity,
      unitPriceMinor: unit,
      discountMinor: unit * q - lineTotal,
    };
  });
  const sum = result.reduce(
    (s, l) => s + l.unitPriceMinor * BigInt(l.quantity) - l.discountMinor,
    0n,
  );
  if (result.length === 0 || sum !== total) throw new Error('Quote lines do not match the sale');
  return result;
}

/** Payments of the receipt by Webkassa type; a method without a type makes the receipt manual. */
export function fiscalPaymentsOf(
  tenders: ReadonlyArray<{ method: PosPaymentMethod; amount_minor: string }>,
): FiscalPayment[] | null {
  const byType = new Map<0 | 1 | 4, bigint>();
  for (const t of tenders) {
    const type = WEBKASSA_PAYMENT_TYPE[t.method];
    if (type === undefined) return null;
    byType.set(type, (byType.get(type) ?? 0n) + BigInt(t.amount_minor));
  }
  return [...byType].map(([type, amountMinor]) => ({ type, amountMinor }));
}

/**
 * QR modules of a receipt link for the printer: rows of '1' (dark) and '0', error correction M.
 * The printer draws them; it never builds a QR itself (no library in the desktop main process).
 */
export function qrMatrix(value: string): string[] {
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => (qr.isDark(row, col) ? '1' : '0')).join(''),
  );
}

export interface WebkassaPrintable extends WebkassaPrintLine {
  /** For a QR line (type 2): its module matrix. */
  qr?: string[];
}

export class WebkassaFiscalWorker {
  readonly #pool: DatabasePool;
  readonly #branchId: string;
  readonly #client: WebkassaClient;
  readonly #log: (event: Record<string, unknown>) => void;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #errors = new Map<string, { error: WebkassaError; at: number }>();
  readonly #attempts = new Map<string, number>();
  #lastZReportShiftClose: string | null = null;

  constructor(
    pool: DatabasePool,
    branchId: string,
    client: WebkassaClient,
    log: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event)),
  ) {
    this.#pool = pool;
    this.#branchId = branchId;
    this.#client = client;
    this.#log = log;
  }

  /** Runs `work` after every Webkassa call queued before it (vendor: one request at a time). */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Issues the branch's pending sale receipts, oldest first. Returns how many were recorded. */
  tick(now = Date.now()): Promise<number> {
    return this.#serial(async () => {
      if (!(await transaction(this.#pool, (client) => posSalesInstalled(client)))) return 0;
      const rows = await this.#pending();
      let recorded = 0;
      for (const row of rows) {
        const refused = this.#errors.get(row.id);
        if (refused && now - refused.at < REFUSED_RETRY_MS) continue;
        if (await this.#issue(row, now)) recorded += 1;
      }
      await this.#closeWebkassaShiftIfIdle();
      return recorded;
    });
  }

  async #pending(): Promise<PendingRow[]> {
    return (
      await this.#pool.query(
        `SELECT f.id,f.order_id,f.amount_minor::text AS amount_minor,s.cashier_staff_id,q.snapshot,
         r.display_number::integer AS display_number
         FROM pos_fiscal_receipts f
         JOIN pos_sales s ON s.order_id=f.order_id AND s.branch_id=f.branch_id
         JOIN local_orders o ON o.id=f.order_id AND o.branch_id=f.branch_id
         JOIN checkout_quotes q ON q.id=o.quote_id AND q.branch_id=f.branch_id
         LEFT JOIN fulfillment_reservations r ON r.local_order_id=f.order_id AND r.branch_id=f.branch_id
         WHERE f.branch_id=$1 AND f.state='pending' AND f.kind='sale'
         ORDER BY f.created_at,f.id LIMIT $2`,
        [this.#branchId, MAX_BATCH],
      )
    ).rows as PendingRow[];
  }

  async #issue(row: PendingRow, now: number): Promise<boolean> {
    const tenders = (
      await this.#pool.query(
        `SELECT method,amount_minor::text AS amount_minor FROM pos_sale_tenders
         WHERE order_id=$1 AND branch_id=$2 ORDER BY created_at,id`,
        [row.order_id, this.#branchId],
      )
    ).rows as Array<{ method: PosPaymentMethod; amount_minor: string }>;
    const payments = fiscalPaymentsOf(tenders);
    let check: FiscalCheck;
    try {
      if (!payments) throw new Error('Payment method without a Webkassa type');
      check = {
        operation: 'sale',
        externalNumber: row.id,
        ...(row.display_number ? { orderNumber: String(row.display_number) } : {}),
        lines: fiscalLinesOf(row.snapshot, BigInt(row.amount_minor)),
        payments,
      };
    } catch (error) {
      this.#refused(row.id, { code: -1, text: (error as Error).message }, now);
      return false;
    }
    this.#attempts.set(row.id, (this.#attempts.get(row.id) ?? 0) + 1);
    let result = await this.#client.issue(check);
    // Code 11: the Webkassa shift is past 24 h (a cash shift left open overnight). Close it with a
    // Z-report and repeat once under the same external number; Webkassa opens a new shift itself.
    if (
      result.kind === 'refused' &&
      result.errors.some((e) => e.code === WEBKASSA_CODE.SHIFT_OVER_24H)
    ) {
      const closed = await this.#client.zReport();
      this.#log({
        event: 'webkassa_shift_over_24h',
        receiptId: row.id,
        report: closed.kind === 'ok' ? 'ok' : closed.kind,
      });
      if (closed.kind === 'ok') result = await this.#client.issue(check);
    }
    if (result.kind === 'issued') {
      await this.#record(row, result.receipt.checkNumber);
      this.#errors.delete(row.id);
      this.#attempts.delete(row.id);
      this.#log({
        event: 'webkassa_receipt_issued',
        receiptId: row.id,
        checkNumber: result.receipt.checkNumber,
        offline: result.receipt.offline,
        duplicate: result.receipt.duplicate,
      });
      return true;
    }
    if (result.kind === 'refused') {
      this.#refused(row.id, result.errors[0]!, now);
      return false;
    }
    // unreachable or lost: the next tick repeats with the same external number.
    this.#log({ event: 'webkassa_receipt_retry', receiptId: row.id, reason: result.kind });
    return false;
  }

  #refused(receiptId: string, error: WebkassaError, now: number) {
    this.#errors.set(receiptId, { error, at: now });
    this.#log({ event: 'webkassa_receipt_refused', receiptId, code: error.code, text: error.text });
  }

  async #record(row: PendingRow, checkNumber: string) {
    await transaction(this.#pool, async (client: DatabaseClient) => {
      await lockBranch(client, this.#branchId);
      const updated = (
        await client.query(
          `UPDATE pos_fiscal_receipts SET state='recorded',receipt_number=$3,version=version+1,
           recorded_by_staff_id=$4,recorded_at=clock_timestamp()
           WHERE id=$1 AND branch_id=$2 AND state='pending' RETURNING ${FISCAL_RECEIPT_COLUMNS}`,
          [row.id, this.#branchId, checkNumber.slice(0, 40), row.cashier_staff_id],
        )
      ).rows[0];
      // Recorded meanwhile by hand (or voided): Webkassa holds the receipt under our id anyway.
      if (!updated) return;
      const receipt = fiscalReceipt(updated);
      await appendFiscalEvent(client, this.#branchId, receipt);
      await audit(
        client,
        this.#branchId,
        row.cashier_staff_id,
        'pos_fiscal.webkassa_issued',
        row.id,
      );
    });
  }

  /**
   * Closes the Webkassa shift (Z-report) once no PickChick cash shift of the branch is open and no
   * receipt is pending: Webkassa refuses checks after 24 h of one shift (Code 11). Only once per
   * closing of our last shift; Code 12/13 (nothing to close) is fine.
   */
  async #closeWebkassaShiftIfIdle() {
    const state = (
      await this.#pool.query(
        `SELECT (SELECT count(*) FROM local_cash_shifts WHERE branch_id=$1 AND state='open')::integer AS open,
         (SELECT max(closed_at) FROM local_cash_shifts WHERE branch_id=$1)::text AS last_close,
         (SELECT count(*) FROM pos_fiscal_receipts WHERE branch_id=$1 AND state='pending' AND kind='sale')::integer AS pending`,
        [this.#branchId],
      )
    ).rows[0] as { open: number; last_close: string | null; pending: number };
    if (state.open > 0 || state.pending > 0 || !state.last_close) return;
    if (state.last_close === this.#lastZReportShiftClose) return;
    const result = await this.#client.zReport();
    if (
      result.kind === 'ok' ||
      (result.kind === 'refused' &&
        result.errors.some((e) => e.code === 12 || e.code === WEBKASSA_CODE.NO_OPEN_SHIFT))
    ) {
      this.#lastZReportShiftClose = state.last_close;
      this.#log({ event: 'webkassa_shift_closed', report: result.kind === 'ok' });
    } else if (result.kind === 'refused') {
      this.#log({ event: 'webkassa_zreport_refused', code: result.errors[0]!.code });
    }
  }

  /** What the POS shows and prints for one receipt; `print` only once Webkassa issued it. */
  async status(
    receiptId: string,
    withPrint: boolean,
  ): Promise<WebkassaFiscalStatus & { print: WebkassaPrintable[] | null }> {
    const row = (
      await this.#pool.query(
        'SELECT state,receipt_number FROM pos_fiscal_receipts WHERE id=$1 AND branch_id=$2',
        [receiptId, this.#branchId],
      )
    ).rows[0] as
      { state: WebkassaFiscalStatus['state']; receipt_number: string | null } | undefined;
    if (!row) throw new OrderError('NOT_FOUND');
    const lines =
      withPrint && row.state === 'recorded'
        ? await this.#serial(() => this.#client.printFormat(receiptId))
        : null;
    const print =
      lines?.map((line) =>
        line.type === 2 && line.value.length <= 600 ? { ...line, qr: qrMatrix(line.value) } : line,
      ) ?? null;
    return {
      receiptId,
      state: row.state,
      receiptNumber: row.receipt_number,
      error: row.state === 'pending' ? (this.#errors.get(receiptId)?.error ?? null) : null,
      attempts: this.#attempts.get(receiptId) ?? 0,
      print,
    };
  }

  /** Asks for the receipt now instead of waiting for the next tick (after a sale). */
  nudge(): void {
    void this.tick().catch((error) =>
      this.#log({ event: 'webkassa_tick_failed', message: (error as Error).message }),
    );
  }

  /**
   * Print form of the Webkassa receipt of a kiosk order (stage 2: the cloud issues it on the same
   * cashbox under the cloud order id as ExternalCheckNumber). null while Webkassa has none.
   */
  async kioskPrint(orderId: string): Promise<WebkassaPrintable[] | null> {
    const lines = await this.#serial(() => this.#client.printFormat(orderId));
    if (!lines?.length) return null;
    return lines.map((line) =>
      line.type === 2 && line.value.length <= 600 ? { ...line, qr: qrMatrix(line.value) } : line,
    );
  }

  /** X-report of the Webkassa shift (manager): the vendor's figures as they are. */
  xReport() {
    return this.#serial(() => this.#client.xReport());
  }
}

/**
 * GET pos/fiscal-receipts/{id}/webkassa: the cashier (own desk) or shift manager asks for the
 * Webkassa state of one receipt and, once issued, its print form. Read-only.
 */
export async function webkassaReceiptStatus(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  worker: WebkassaFiscalWorker,
  receiptId: string,
  withPrint: boolean,
) {
  if (!UuidSchema.safeParse(receiptId).success) throw new OrderError('INVALID_REQUEST');
  const id = receiptId.toLowerCase();
  await transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    const row = (
      await client.query(
        `SELECT CASE WHEN f.kind='sale' THEN s.terminal_id ELSE x.terminal_id END AS desk
         FROM pos_fiscal_receipts f
         JOIN pos_sales s ON s.order_id=f.order_id AND s.branch_id=f.branch_id
         LEFT JOIN pos_refunds x ON x.id=f.refund_id AND x.branch_id=f.branch_id
         WHERE f.id=$1 AND f.branch_id=$2`,
        [id, branchId],
      )
    ).rows[0] as { desk: string } | undefined;
    if (!row || (actor.role !== 'shift_manager' && row.desk !== actor.terminal_id))
      throw new OrderError('NOT_FOUND');
  });
  return worker.status(id, withPrint);
}

/** Kiosk orders of today that the kitchen got: their receipt is issued (cloud fiscal gate). */
export const KIOSK_RECEIPTS_LIMIT = 100;

/**
 * GET pos/kiosk-receipts: the paid kiosk orders of the business day, so the cashier desk prints
 * their Webkassa receipt on its printer (owner 25.11: the kiosk prints on the cashier printer).
 * A cloud order reaches this kitchen only after its sale receipt is issued, so every row listed
 * has one; the desk keeps which it printed. Read-only.
 */
export async function kioskReceipts(pool: DatabasePool, branchId: string, auth: StaffAuth) {
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    const rows = (
      await client.query(
        `SELECT order_id,display_number::text,created_at FROM fulfillment_reservations
         WHERE branch_id=$1 AND commercial_owner='cloud' AND snapshot->>'channel'='kiosk'
           AND authorized_event_id IS NOT NULL AND state NOT IN ('cancel_requested','cancelled','released')
           AND business_day=(clock_timestamp() AT TIME ZONE 'Asia/Almaty')::date
         ORDER BY created_at DESC,order_id LIMIT $2`,
        [branchId, KIOSK_RECEIPTS_LIMIT],
      )
    ).rows as { order_id: string; display_number: string; created_at: Date }[];
    return {
      receipts: rows.map((r) => ({
        order_id: r.order_id,
        display_number: r.display_number,
        created_at: r.created_at.toISOString(),
      })),
    };
  });
}

/** GET pos/kiosk-receipts/{orderId}/print: that kiosk order's receipt form with its QR. */
export async function kioskReceiptPrint(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  worker: WebkassaFiscalWorker,
  orderId: string,
) {
  if (!UuidSchema.safeParse(orderId).success) throw new OrderError('INVALID_REQUEST');
  const id = orderId.toLowerCase();
  const row = await transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    return (
      await client.query(
        `SELECT display_number::text FROM fulfillment_reservations WHERE order_id=$1 AND branch_id=$2
         AND commercial_owner='cloud' AND snapshot->>'channel'='kiosk' AND authorized_event_id IS NOT NULL`,
        [id, branchId],
      )
    ).rows[0] as { display_number: string } | undefined;
  });
  if (!row) throw new OrderError('NOT_FOUND');
  const print = await worker.kioskPrint(id);
  if (!print) throw new OrderError('NOT_FOUND');
  return { order_id: id, display_number: row.display_number, print };
}
