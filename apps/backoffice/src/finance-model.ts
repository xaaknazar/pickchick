import { ApiError, type Request } from './api.js';

export type Category = {
  id: string;
  name: string;
  direction: 'in' | 'out';
  group: string;
  cashflow: string;
  recognition: string;
};
export type FinanceEntry = {
  id: string;
  kind: string;
  amount_minor: string;
  cash_date: string | null;
  recognition_date: string | null;
  account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  center: string;
  counterparty: string;
  reference: string;
  note: string;
};
export type Account = {
  id: string;
  name: string;
  kind: string;
  opening_date: string;
  opening_minor: string;
  before_minor: string;
  introduced_minor: string;
  in_minor: string;
  out_minor: string;
  after_minor: string;
};
export type JournalRow = {
  id: string;
  payload: FinanceEntry;
  created_at: string;
  author: string;
  void_reason: string | null;
  void_author: string | null;
  voided_at: string | null;
};
export type FinanceSnapshot = {
  schema_version: 1;
  branch_id: string;
  role: string;
  as_of: string;
  categories: Category[];
  centers: Record<string, string>;
  groups: Record<string, string>;
  accounts: Account[];
  summaries: {
    category_id: string;
    center: string;
    cash_minor: string;
    pnl_minor: string;
    entries: number;
  }[];
  journal: JournalRow[];
  total: number;
  periods: { month: string; closed: boolean; revision: number }[];
};
type Pending = {
  actor: string;
  branch: string;
  body: { request_id: string; reason: string; command: Record<string, unknown> };
};
export function minor(value: string): string {
  const v = value.trim().replaceAll(' ', '').replace(',', '.');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(v))
    throw new Error('Укажите сумму с точностью до двух знаков после запятой.');
  const [whole, decimal = ''] = v.split('.');
  const n = BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (n <= 0n || n > 99999999999999n)
    throw new Error('Сумма должна быть больше нуля и меньше 1 трлн ₸.');
  return String(n);
}
export function money(value: string) {
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${(a / 100n).toLocaleString('ru-RU')},${String(a % 100n).padStart(2, '0')} ₸`;
}
export function csv(rows: string[][]) {
  return (
    '\ufeff' +
    rows
      .map((row) =>
        row
          .map((v) => '"' + (/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replaceAll('"', '""') + '"')
          .join(';'),
      )
      .join('\r\n')
  );
}
export const today = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Almaty',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export class FinanceModel {
  actor = '';
  branch = '';
  start = today().slice(0, 7) + '-01';
  end = today();
  center = 'all';
  page = 0;
  category = '';
  basis = 'both';
  search = '';
  data: FinanceSnapshot | null = null;
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
    return 'pickchick.finance.v1:' + this.actor;
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
    const generation = this.generation;
    this.busy = true;
    this.changed();
    try {
      const query = new URLSearchParams({
        start_date: this.start,
        end_date: this.end,
        center: this.center,
        page: String(this.page),
        category: this.category,
        basis: this.basis,
        search: this.search,
      });
      const d = (await this.api(`branches/${this.branch}/finance?${query}`)) as FinanceSnapshot;
      if (
        d?.schema_version !== 1 ||
        d.branch_id !== this.branch ||
        !['manager', 'analyst'].includes(d.role) ||
        !Array.isArray(d.accounts) ||
        !Array.isArray(d.journal) ||
        !Array.isArray(d.summaries) ||
        !Array.isArray(d.categories) ||
        !Array.isArray(d.periods)
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
            UNAUTHORIZED: 'Войдите заново по личному файлу доступа.',
            INVALID_REQUEST:
              'Проверьте сумму, даты и счета. Дата платежа не может быть раньше начального остатка счёта.',
            SERVICE_UNAVAILABLE:
              'Финансовый модуль ещё не установлен на сервере или временно недоступен.',
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
      const result = await this.api(`branches/${p.branch}/finance/commands`, {
        method: 'POST',
        body: p.body,
      });
      if (!result || typeof result !== 'object' || !('id' in result || 'month' in result))
        throw new ApiError('INVALID_RESPONSE');
      if (generation !== this.generation) return false;
      this.storage.removeItem(this.key());
      this.pending = null;
      if (p.body.command['type'] === 'entry' && 'id' in result)
        this.lastEntryId = String(result.id);
      this.notice = 'Операция сохранена на сервере.';
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
