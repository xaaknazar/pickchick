import { ApiError, type Request } from './api.js';
import { object } from './operations-model.js';
type Api = (path: string, request?: Request) => Promise<unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A kiosk QR payment whose bank result is still unknown 15+ minutes later (the kiosk waits). */
export type KioskIncidentCandidate = {
  order_id: string;
  attempt_id: string;
  total_minor: string;
  order_state: string;
  attempt_state: string;
  qr_state: string;
  has_operation_id: boolean;
  issue_started_at: string;
  created_at: string;
};
export type KioskIncidentAccepted = {
  order_id: string;
  attempt_id: string;
  reason: string;
  note: string;
  accepted_at: string;
  accepted_by_name: string;
  attempt_state: string;
  kaspi_check: KaspiCheck | null;
};
export type KioskIncidentList = {
  role: 'manager' | 'analyst';
  min_age_minutes: number;
  candidates: KioskIncidentCandidate[];
  accepted: KioskIncidentAccepted[];
};
/** What the manager saw in Kaspi Pay. Recorded only: it never declares a payment. */
export type KaspiCheck = 'payment_found' | 'payment_not_found';
export function parseIncidents(raw: unknown): KioskIncidentList {
  const value = object(raw);
  if (
    !['manager', 'analyst'].includes(String(value['role'])) ||
    !Array.isArray(value['candidates']) ||
    !Array.isArray(value['accepted']) ||
    !Number.isInteger(value['min_age_minutes'])
  )
    throw new ApiError('INVALID_RESPONSE');
  for (const row of value['candidates']) {
    const c = object(row);
    if (
      !UUID.test(String(c['order_id'])) ||
      !UUID.test(String(c['attempt_id'])) ||
      !/^\d{1,16}$/.test(String(c['total_minor'])) ||
      typeof c['has_operation_id'] !== 'boolean' ||
      !Number.isFinite(Date.parse(String(c['issue_started_at'])))
    )
      throw new ApiError('INVALID_RESPONSE');
  }
  for (const row of value['accepted']) {
    const a = object(row);
    if (!UUID.test(String(a['order_id'])) || typeof a['note'] !== 'string')
      throw new ApiError('INVALID_RESPONSE');
  }
  return value as KioskIncidentList;
}
/** «1 250 ₸» from minor units (tiyn). */
export const tenge = (minor: string) =>
  `${(BigInt(minor) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₸`;
/** Whole minutes since the QR attempt started. */
export const incidentAgeMinutes = (c: KioskIncidentCandidate, now = Date.now()) =>
  Math.max(0, Math.floor((now - Date.parse(c.issue_started_at)) / 60000));
/** What staff does after releasing the kiosk, by the Kaspi Pay finding. */
export function incidentAdvice(check: KaspiCheck) {
  return check === 'payment_found'
    ? 'Оплата есть в Kaspi Pay: выдайте гостю заказ и не принимайте повторную оплату. В системе платёж остаётся на сверке и привяжется к этому заказу, когда банк его подтвердит.'
    : 'Оплаты в Kaspi Pay нет: гость может оформить заказ заново. Если банк позже подтвердит платёж, он привяжется к этому заказу; возврат делается вручную в Kaspi Pay.';
}
/**
 * Audit 19.10, finding 4.3: a manager releases a kiosk stuck on an unknown QR payment from the
 * cabinet (before: an engineer over SSH). The server keeps the manager-only check, the 15-minute
 * guard and the audit; the payment itself is never declared paid or failed here.
 */
export class KioskIncidentsModel {
  actor = '';
  branch = '';
  data: KioskIncidentList | null = null;
  error: unknown = null;
  busy = false;
  /** The last decision went out without a definite answer: check the list before repeating. */
  uncertain = false;
  /** The last accepted decision of this tab, for the staff advice under the list. */
  last: { order_id: string; kaspi_check: KaspiCheck } | null = null;
  private epoch = 0;
  private pending: { fingerprint: string; request_id: string } | null = null;
  constructor(
    private readonly api: Api,
    private readonly changed: () => void,
  ) {}
  clear() {
    this.epoch++;
    this.actor = '';
    this.branch = '';
    this.data = null;
    this.error = null;
    this.busy = false;
    this.uncertain = false;
    this.last = null;
    this.pending = null;
  }
  async load(actor: string, branch: string) {
    if (this.actor !== actor || this.branch !== branch) {
      this.clear();
      this.actor = actor;
      this.branch = branch;
    }
    const epoch = this.epoch;
    try {
      const data = parseIncidents(await this.api(`branches/${branch}/kiosk-payment-incidents`));
      if (epoch !== this.epoch) return;
      this.data = data;
      this.error = null;
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.error = error;
      this.data = null;
    }
    this.changed();
  }
  /** Releases the kiosk; the same input repeats with the same request id (idempotent). */
  async accept(candidate: KioskIncidentCandidate, check: KaspiCheck, note: string) {
    if (this.busy || this.data?.role !== 'manager') throw new ApiError('FORBIDDEN');
    // The Kaspi Pay finding is always stated by the manager, never assumed (review 19.10).
    if (check !== 'payment_found' && check !== 'payment_not_found')
      throw new ApiError('INVALID_REQUEST');
    const body = {
      order_id: candidate.order_id,
      attempt_id: candidate.attempt_id,
      // Without a bank operation id the result can never be read from Kaspi automatically.
      reason: candidate.has_operation_id ? 'bank_result_unknown' : 'bank_identity_lost',
      note: note.trim(),
      confirm: 'payment_result_remains_unknown',
      kaspi_check: check,
    };
    const fingerprint = JSON.stringify(body);
    if (this.pending?.fingerprint !== fingerprint)
      this.pending = { fingerprint, request_id: crypto.randomUUID() };
    const epoch = this.epoch,
      actor = this.actor,
      branch = this.branch;
    this.busy = true;
    this.error = null;
    this.uncertain = false;
    this.changed();
    try {
      const raw = object(
        await this.api(`branches/${branch}/kiosk-payment-incidents`, {
          method: 'POST',
          body: { ...body, request_id: this.pending.request_id },
        }),
      );
      if (epoch !== this.epoch) return false;
      if (raw['kiosk'] !== 'session_end_allowed') throw new ApiError('INVALID_RESPONSE');
      this.pending = null;
      this.last = { order_id: candidate.order_id, kaspi_check: check };
      await this.load(actor, branch);
      return true;
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = error;
        this.uncertain = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      }
      return false;
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.changed();
      }
    }
  }
}
