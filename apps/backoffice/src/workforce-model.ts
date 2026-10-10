import { ApiError, type Request } from './api.js';
import { today } from './finance-model.js';
export { today, money, minor, csv } from './finance-model.js';
export type WorkRecord = {
  id: string;
  kind: 'plan' | 'time' | 'rate' | 'bonus';
  revision: number;
  payload: Record<string, unknown>;
};
export type EmployeeRecord = {
  id: string;
  revision: number;
  payload: { name: string; role: string; active: boolean; note: string };
};
export type WorkforceSnapshot = {
  branch_id: string;
  month: string;
  role: string;
  employees: EmployeeRecord[];
  records: WorkRecord[];
  unresolved_events: number;
  source_status: string;
  period: { closed: boolean; revision: number; snapshot: unknown };
  calculation: {
    lines: {
      employee_id: string;
      seconds: number;
      night_seconds: number;
      base_minor: string;
      bonus_minor: string;
      total_minor: string;
    }[];
    total_minor: string;
    issues: { employee_id: string; code: string; record_id: string }[];
  };
  events: { id: string; employee_id: string; occurred_at: string; direction: string }[];
  audit: {
    id: string;
    action: string;
    actor_id: string;
    author?: string;
    reason: string;
    created_at: string;
    before_value: unknown;
    after_value: unknown;
  }[];
  audit_limit: number;
};
type Pending = {
  actor: string;
  branch: string;
  body: { request_id: string; reason: string; command: Record<string, unknown> };
};
export function hours(seconds: number) {
  return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}
export function localDateTime(value: string) {
  return new Date(Date.parse(value) + 5 * 3600000).toISOString().slice(0, 16);
}
export function intervalSeconds(intervals: { start: string; end: string }[]) {
  return intervals.reduce((n, p) => n + (Date.parse(p.end) - Date.parse(p.start)) / 1000, 0);
}
export class WorkforceModel {
  actor = '';
  branch = '';
  month = today().slice(0, 7) + '-01';
  data: WorkforceSnapshot | null = null;
  pending: Pending | null = null;
  busy = false;
  error = '';
  notice = '';
  lastEntryId = '';
  private generation = 0;
  private storageBroken = false;
  constructor(
    private api: (path: string, request?: Request) => Promise<unknown>,
    private storage: Storage,
    private changed: () => void,
  ) {}
  private key() {
    return 'pickchick.workforce.v1:' + this.actor;
  }
  clear() {
    this.generation++;
    this.actor = '';
    this.branch = '';
    this.pending = null;
    this.data = null;
    this.busy = false;
    this.error = '';
    this.notice = '';
    this.lastEntryId = '';
    this.storageBroken = false;
  }
  async scope(actor: string, branch: string) {
    if (this.actor === actor && this.branch === branch) return;
    if (this.pending && this.actor === actor) {
      this.error = 'Сначала проверьте результат отправленной операции.';
      this.changed();
      return;
    }
    this.clear();
    this.actor = actor;
    this.branch = branch;
    try {
      const raw = this.storage.getItem(this.key());
      if (raw) {
        const p = JSON.parse(raw) as Pending;
        if (
          p.actor !== actor ||
          !/^[-a-f0-9]{36}$/.test(p.branch) ||
          !p.body?.request_id ||
          !p.body.command
        )
          throw Error();
        this.pending = p;
      }
    } catch {
      this.storageBroken = true;
      this.error =
        'Журнал восстановления недоступен. Новые записи заблокированы; обратитесь к администратору.';
    }
    await this.load();
  }
  async load() {
    if (!this.actor || this.busy) return;
    if (this.data?.month !== this.month) this.data = null;
    const generation = this.generation;
    this.busy = true;
    this.changed();
    try {
      const d = (await this.api(
        `branches/${this.branch}/workforce?month=${this.month}`,
      )) as WorkforceSnapshot;
      if (
        !d ||
        d.branch_id !== this.branch ||
        d.month !== this.month ||
        !['manager', 'analyst'].includes(d.role) ||
        !Array.isArray(d.records) ||
        !Array.isArray(d.employees) ||
        !Array.isArray(d.audit) ||
        !d.calculation ||
        !d.period
      )
        throw new ApiError('INVALID_RESPONSE');
      if (generation === this.generation) {
        this.data = d;
        if (!this.storageBroken) this.error = '';
      }
    } catch (e) {
      if (generation === this.generation) {
        this.data = null;
        this.error = this.explain(e);
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
  }
  private explain(e: unknown) {
    if (e instanceof ApiError)
      return (
        (
          {
            CONFLICT: 'Запись уже изменена или месяц закрыт. Обновите данные и проверьте период.',
            FORBIDDEN: 'Для записи нужны права управляющего этой точки.',
            UNAUTHORIZED: 'Войдите в кабинет заново.',
            NOT_READY:
              'Закрыть табель можно после конца месяца. Разберите отмеченные ошибки, ставки и явки.',
            INVALID_REQUEST:
              'Проверьте сотрудника, даты и интервалы. Явка не может содержать будущие часы или пересечения.',
            SERVICE_UNAVAILABLE: 'Раздел смен временно недоступен.',
            NOT_FOUND: 'Запись не найдена. Обновите журнал.',
          } as Record<string, string>
        )[e.code] ?? 'Ответ сервера не подтверждён. Повторите проверку результата.'
      );
    return e instanceof Error ? e.message : 'Не удалось выполнить операцию.';
  }
  get writable() {
    return this.data?.role === 'manager' && !this.busy && !this.pending && !this.storageBroken;
  }
  async send(command: Record<string, unknown>, reason: string) {
    if (!this.writable) return false;
    const p = {
      actor: this.actor,
      branch: this.branch,
      body: { request_id: crypto.randomUUID(), reason, command },
    };
    try {
      this.storage.setItem(this.key(), JSON.stringify(p));
      if (this.storage.getItem(this.key()) !== JSON.stringify(p)) throw Error();
    } catch {
      this.storageBroken = true;
      this.error = 'Браузер не сохранил запрос. Он не отправлен. Проверьте доступность хранилища.';
      this.changed();
      return false;
    }
    this.pending = p;
    return this.recover();
  }
  async recover() {
    if (!this.pending || this.busy) return false;
    const p = this.pending,
      generation = this.generation;
    this.busy = true;
    this.error = '';
    this.changed();
    let ok = false;
    try {
      const result = await this.api(
        `branches/${p.branch}/${p.body.command['type'] === 'employee' ? 'commands' : 'workforce/commands'}`,
        {
          method: 'POST',
          body:
            p.body.command['type'] === 'employee'
              ? { ...p.body, command: { ...p.body.command, type: 'save', kind: 'employee' } }
              : p.body,
        },
      );
      if (!result || typeof result !== 'object' || !('id' in result || 'month' in result))
        throw new ApiError('INVALID_RESPONSE');
      if (generation !== this.generation) return false;
      this.storage.removeItem(this.key());
      this.pending = null;
      if (['save', 'employee'].includes(String(p.body.command['type'])) && 'id' in result)
        this.lastEntryId = String(result.id);
      this.notice = 'Сохранено на сервере. История изменений обновлена.';
      ok = true;
    } catch (e) {
      if (generation === this.generation) {
        this.error = this.explain(e);
        // Expired access or a missing route cannot disprove an earlier committed
        // request whose reply was lost. Keep it for recovery after reauthentication.
        if (e instanceof ApiError && [400, 409].includes(e.status)) {
          try {
            this.storage.removeItem(this.key());
            this.pending = null;
          } catch {
            this.storageBroken = true;
          }
        }
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
    if (ok) await this.load();
    return ok;
  }
}
