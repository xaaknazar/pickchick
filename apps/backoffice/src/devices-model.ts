import { ApiError, type Request } from './api.js';
import { object, type Data } from './operations-model.js';
type Api = (path: string, request?: Request) => Promise<unknown>;
export type DeviceRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  mode: string | null;
  generation: number | null;
  paired_at: string | null;
  last_seen_at: string | null;
  key_expires_at: string | null;
  command_id: string | null;
  command_action: string | null;
  command_state: string | null;
  code_expires_at: string | null;
};
export type DeviceList = {
  branch_id: string;
  role: 'manager' | 'analyst';
  devices: DeviceRow[];
  as_of: string;
  password_reset?: { command_id: string; state: string; expires_at: string } | null;
};
export type IssuedCode = {
  device_id?: string;
  command_id: string;
  code: string;
  expires_at: string;
  purpose?: string;
};
function list(raw: unknown, branch: string): DeviceList {
  const value = object(raw);
  if (
    value['branch_id'] !== branch ||
    !['manager', 'analyst'].includes(String(value['role'])) ||
    !Array.isArray(value['devices'])
  )
    throw new ApiError('INVALID_RESPONSE');
  for (const row of value['devices']) {
    const d = object(row);
    if (!['id', 'name', 'kind', 'status'].every((k) => typeof d[k] === 'string'))
      throw new ApiError('INVALID_RESPONSE');
  }
  return value as DeviceList;
}
/** Codes are memory-only, never persisted in pending requests, storage, URLs or audit. */
export class DevicesModel {
  actor = '';
  branch = '';
  data: DeviceList | null = null;
  code: IssuedCode | null = null;
  error: unknown = null;
  busy = false;
  uncertain = false;
  private epoch = 0;
  private loadSequence = 0;
  constructor(
    private readonly api: Api,
    private readonly changed: () => void,
  ) {}
  clear() {
    this.epoch++;
    this.actor = '';
    this.branch = '';
    this.data = null;
    this.code = null;
    this.error = null;
    this.busy = false;
    this.uncertain = false;
  }
  hideCode() {
    this.code = null;
  }
  async load(actor: string, branch: string) {
    if (this.actor !== actor || this.branch !== branch) {
      this.clear();
      this.actor = actor;
      this.branch = branch;
    }
    const epoch = this.epoch,
      sequence = ++this.loadSequence;
    try {
      const data = list(await this.api(`branches/${branch}/devices`), branch);
      if (epoch !== this.epoch || sequence !== this.loadSequence) return;
      this.data = data;
      this.error = null;
      if (
        this.code &&
        (Date.parse(this.code.expires_at) <= Date.now() ||
          data.devices.some(
            (d) =>
              d.id === this.code?.device_id &&
              d.command_id === this.code.command_id &&
              d.command_state === 'paired',
          ) ||
          (this.code.purpose === 'kitchen-password-reset' &&
            data.password_reset?.command_id === this.code.command_id &&
            ['used', 'expired', 'rejected'].includes(data.password_reset.state)))
      )
        this.code = null;
    } catch (error) {
      if (epoch === this.epoch && sequence === this.loadSequence) {
        this.error = error;
        this.data = null;
        this.code = null;
      }
    }
    if (epoch === this.epoch) this.changed();
  }
  async issue(body: Data) {
    return this.send('pairing-codes', body);
  }
  async resetPassword(body: Data) {
    return this.send('kitchen-password-reset', body);
  }
  async revoke(body: Data) {
    return this.send('revoke', body);
  }
  private async send(action: string, body: Data) {
    if (this.busy || this.data?.role !== 'manager') throw new ApiError('FORBIDDEN');
    const epoch = this.epoch,
      branch = this.branch,
      actor = this.actor;
    this.busy = true;
    this.error = null;
    this.uncertain = false;
    this.code = null;
    try {
      const raw = object(
        await this.api(`branches/${branch}/devices/${action}`, {
          method: 'POST',
          body: { ...body, request_id: crypto.randomUUID() },
        }),
      );
      if (epoch !== this.epoch) return false;
      if (action === 'pairing-codes' || action === 'kitchen-password-reset') {
        if (
          typeof raw['code'] !== 'string' ||
          !/^([a-f0-9]{4}-){7}[a-f0-9]{4}$/.test(raw['code']) ||
          typeof raw['expires_at'] !== 'string' ||
          (action === 'pairing-codes' && typeof raw['device_id'] !== 'string') ||
          typeof raw['command_id'] !== 'string'
        )
          throw new ApiError('INVALID_RESPONSE');
        this.code = raw as IssuedCode;
      }
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
  async resetHistory() {
    const epoch = this.epoch;
    const raw = object(
      await this.api(`branches/${this.branch}/devices/kitchen-password-reset/events`),
    );
    return epoch === this.epoch && Array.isArray(raw['events']) ? raw['events'].map(object) : [];
  }
  async history(id: string) {
    const epoch = this.epoch,
      raw = object(await this.api(`branches/${this.branch}/devices/${id}/events`));
    if (epoch !== this.epoch) return [];
    if (!Array.isArray(raw['events'])) throw new ApiError('INVALID_RESPONSE');
    return raw['events'].map(object);
  }
}
export function deviceStatus(d: DeviceRow, now = Date.now()) {
  if (d.command_action === 'revoke' && ['pending', 'delivered'].includes(d.command_state ?? ''))
    return 'Отключение ждёт кассу';
  if (d.status === 'revoked') return 'Отключено';
  if (d.command_action === 'pair' && d.command_state !== 'paired') {
    if (d.code_expires_at && Date.parse(d.code_expires_at) <= now) return 'Код истёк';
    return d.command_state === 'applied' ? 'Введите код на экране' : 'Ждём кассу';
  }
  if (d.mode) return d.paired_at ? 'Подключено' : 'Ожидает подключения';
  if (d.kind === 'edge' && d.last_seen_at)
    return now - Date.parse(d.last_seen_at) < 120_000
      ? 'Касса на связи'
      : 'Нет свежего ответа кассы';
  return 'Связь экрана не проверена';
}
