import { ApiError, message, type Request } from './api.js';

/**
 * Device registry of one branch (plan "Устройства", section 4/5/8 MVP).
 *
 * Contract: GET/POST v1/admin/backoffice/branches/:id/devices[...] as served by
 * services/api/src/device-registry-controller.ts and backoffice-core/src/device-registry.ts.
 * Responses and request bodies are snake_case; request bodies are strict objects on the server
 * ({request_id, reason, ...}), so no extra field may be sent.
 *
 * A one-time kiosk password or pairing code lives only in memory of this model (never in
 * storage) and is dropped as soon as the dialog closes, the code expires or the device pairs.
 */
export const ROLES = ['edge', 'pos', 'kiosk', 'kitchen_prep', 'kitchen_assembly', 'board'] as const;
export type DeviceRole = (typeof ROLES)[number];
export type DeviceStatus = 'pending' | 'active' | 'revoked';
export type OpenCode = { id: string; expires_at: string };
export type Device = {
  id: string;
  /** False for a kiosk provisioned before cloud051: adopted into the registry on first write. */
  registered: boolean;
  role: DeviceRole;
  name: string;
  status: DeviceStatus;
  online: boolean | null;
  last_seen_at: string | null;
  app_version: string | null;
  credential_expires_at: string | null;
  open_code: OpenCode | null;
  payment_open: boolean;
  /** Server decision (never the branch edge). */
  revocable: boolean;
  revoked_at: string | null;
};
export type Registry = {
  source: 'registry' | 'legacy';
  branch_id: string;
  role: 'manager' | 'analyst';
  as_of: string;
  kiosk_supported: boolean;
  devices: Device[];
};
export type DeviceEvent = {
  action: string;
  actor_kind: string;
  reason: string | null;
  at: string;
};
export type Pairing = {
  stage: 'form' | 'issuing' | 'code' | 'paired' | 'expired' | 'cancelled';
  /** Existing pending/kiosk device that receives a new code; null creates a new device. */
  deviceId: string | null;
  name: string;
  createRequest: string;
  codeRequest: string;
  codeId: string | null;
  login: string | null;
  password: string | null;
  code: string | null;
  expiresAt: string | null;
  error: string;
};

export const GROUPS: { id: string; title: string; roles: DeviceRole[]; hint: string }[] = [
  {
    id: 'cashier',
    title: 'Касса (моноблок)',
    roles: ['edge', 'pos'],
    hint: 'Кассовый узел точки: меню, заказы кухни и обмен с облаком идут через него.',
  },
  {
    id: 'kiosk',
    title: 'iPad-киоски',
    roles: ['kiosk'],
    hint: 'Киоски самообслуживания. Подключаются из кабинета по одноразовому логину и паролю.',
  },
  {
    id: 'prep',
    title: 'Кухня: приём',
    roles: ['kitchen_prep'],
    hint: 'Экраны приёма и приготовления заказов. Работают через кассу точки.',
  },
  {
    id: 'assembly',
    title: 'Кухня: сборка',
    roles: ['kitchen_assembly'],
    hint: 'Экраны сборки и выдачи заказов. Работают через кассу точки.',
  },
  {
    id: 'board',
    title: 'Табло',
    roles: ['board'],
    hint: 'Табло готовности заказов для гостей.',
  },
];
export const ROLE_LABELS: Record<DeviceRole, string> = {
  edge: 'Кассовый узел',
  pos: 'Приложение кассы',
  kiosk: 'iPad-киоск',
  kitchen_prep: 'Кухня: приём',
  kitchen_assembly: 'Кухня: сборка',
  board: 'Табло',
};
/** Instruction for screens that cannot be reset from the cloud yet (plan 8.4). */
export const STAFF_RESET_HINT =
  'Сброс пароля сотрудника выполняется на кассе: scripts/staff-password-setup.mjs --replace.';
export const EDGE_HINT =
  'Отключить кассу из кабинета нельзя. Замена кассы - по процедуре в docs/operations/menu-sync.md.';
/** The server requires a reason for every write; cancelling an unused code needs no judgement. */
export const CANCEL_REASON = 'Код подключения отменён в кабинете';
export const ONLINE_MS = 2 * 60_000;
export const ATTENTION_MS = 10 * 60_000;
export const CREDENTIAL_WARN_MS = 7 * 86_400_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_ROLE: Record<string, DeviceRole> = {
  edge: 'edge',
  pos: 'pos',
  kiosk: 'kiosk',
  kitchen: 'kitchen_prep',
  display: 'board',
};
type Raw = Record<string, unknown>;
function pick(o: Raw, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}
const invalid = () => new ApiError('INVALID_RESPONSE');
function object(value: unknown): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Raw;
}
function stamp(value: unknown, nullable = true): string | null {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value)))
    throw invalid();
  return value;
}
function text(value: unknown, max: number, nullable = false): string | null {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'string' || value.length > max) throw invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}

export function parseDevice(value: unknown): Device {
  const o = object(value);
  const rawRole = pick(o, 'role') ?? LEGACY_ROLE[String(pick(o, 'kind'))];
  if (!ROLES.includes(rawRole as DeviceRole)) throw invalid();
  const status = pick(o, 'status');
  if (status !== 'pending' && status !== 'active' && status !== 'revoked') throw invalid();
  const online = pick(o, 'online');
  // `pairing` is the latest open code: state open/expired keeps it on the card, consumed means
  // the iPad already used it (the exchange is reconciled into the registry on the next write).
  const code = pick(o, 'pairing');
  let open: OpenCode | null = null;
  if (code !== null && code !== undefined) {
    const c = object(code);
    const state = pick(c, 'state');
    if (state !== 'open' && state !== 'expired' && state !== 'consumed') throw invalid();
    const parsed = { id: uuid(pick(c, 'id')), expires_at: stamp(pick(c, 'expires_at'), false)! };
    if (state !== 'consumed') open = parsed;
  }
  return {
    id: uuid(pick(o, 'id')),
    registered: pick(o, 'registered') !== false,
    role: rawRole as DeviceRole,
    name: text(pick(o, 'name'), 120)!,
    status,
    online: typeof online === 'boolean' ? online : null,
    last_seen_at: stamp(pick(o, 'last_seen_at')),
    app_version: text(pick(o, 'app_version'), 64, true),
    credential_expires_at: stamp(pick(o, 'credential_expires_at')),
    open_code: open,
    payment_open: pick(o, 'payment_open') === true,
    revocable: pick(o, 'revocable') === true && rawRole !== 'edge',
    revoked_at: stamp(pick(o, 'revoked_at')),
  };
}
export function parseRegistry(value: unknown, branch: string): Registry {
  const o = object(value);
  const role = pick(o, 'role');
  const devices = pick(o, 'devices');
  const pairing = pick(o, 'kiosk_pairing');
  if (pairing !== 'ready' && pairing !== 'not_configured') throw invalid();
  if (
    String(pick(o, 'branch_id')).toLowerCase() !== branch.toLowerCase() ||
    (role !== 'manager' && role !== 'analyst') ||
    !Array.isArray(devices) ||
    devices.length > 500
  )
    throw invalid();
  return {
    source: 'registry',
    branch_id: branch,
    role,
    as_of: stamp(pick(o, 'server_time'), false)!,
    kiosk_supported: pairing === 'ready',
    devices: devices.map(parseDevice),
  };
}
/**
 * Read-only view built from the operations snapshot when the registry route is not installed
 * yet. It never offers actions: the old revoke command could cut off the cashier node.
 */
export function legacyRegistry(
  rows: Raw[] | undefined,
  branch: string,
  role: string | undefined,
  asOf: string,
): Registry {
  const devices: Device[] = [];
  for (const row of rows ?? []) {
    const r = LEGACY_ROLE[String(row['kind'])];
    const id = typeof row['id'] === 'string' && UUID.test(row['id']) ? row['id'] : null;
    if (!r || !id) continue;
    const seen = [row['last_fulfillment_at'], row['last_pos_at']]
      .filter((v): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    devices.push({
      id,
      role: r,
      name: typeof row['name'] === 'string' ? row['name'] : ROLE_LABELS[r],
      status: row['status'] === 'revoked' ? 'revoked' : 'active',
      online: null,
      last_seen_at: seen ?? null,
      app_version: null,
      credential_expires_at: null,
      registered: true,
      open_code: null,
      payment_open: false,
      revocable: false,
      revoked_at: null,
    });
  }
  return {
    source: 'legacy',
    branch_id: branch,
    role: role === 'manager' ? 'manager' : 'analyst',
    as_of: asOf,
    kiosk_supported: false,
    devices,
  };
}

const order: Record<DeviceStatus, number> = { active: 0, pending: 1, revoked: 2 };
export function groupDevices(devices: Device[]) {
  return GROUPS.map((g) => {
    const list = devices
      .filter((d) => g.roles.includes(d.role))
      .sort(
        (a, b) =>
          order[a.status] - order[b.status] ||
          g.roles.indexOf(a.role) - g.roles.indexOf(b.role) ||
          a.name.localeCompare(b.name, 'ru'),
      );
    return {
      ...g,
      current: list.filter((d) => d.status !== 'revoked'),
      revoked: list.filter((d) => d.status === 'revoked'),
    };
  });
}

export function ago(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}
export function relative(at: string | null, now: number) {
  if (!at) return 'нет данных';
  const ms = now - Date.parse(at);
  if (ms < 60_000) return 'только что';
  return `${ago(ms)} назад`;
}
export type Tone = 'good' | 'bad' | 'warn' | 'wait' | 'muted';
export function online(d: Device, now: number) {
  if (d.status !== 'active' || !d.last_seen_at) return false;
  return d.online ?? now - Date.parse(d.last_seen_at) < ONLINE_MS;
}
export function presence(d: Device, now: number): { tone: Tone; label: string } {
  if (d.status === 'revoked') return { tone: 'muted', label: 'Отозвано' };
  if (d.status === 'pending') return { tone: 'wait', label: 'Ожидает подключения' };
  if (!d.last_seen_at) return { tone: 'muted', label: 'Нет данных о связи' };
  if (online(d, now)) return { tone: 'good', label: 'На связи' };
  const ms = now - Date.parse(d.last_seen_at);
  return { tone: ms > ATTENTION_MS ? 'bad' : 'warn', label: `Нет связи ${ago(ms)}` };
}
export function credentialState(expires: string | null, now: number) {
  if (!expires) return null;
  const left = Date.parse(expires) - now;
  return left <= 0 ? 'expired' : left < CREDENTIAL_WARN_MS ? 'warn' : 'ok';
}
export function codeExpired(d: Device, now: number) {
  return d.open_code !== null && Date.parse(d.open_code.expires_at) <= now;
}
export function attention(d: Device, now: number) {
  if (d.status === 'revoked') return false;
  if (codeExpired(d, now)) return true;
  if (d.status !== 'active') return false;
  if (d.last_seen_at && !online(d, now) && now - Date.parse(d.last_seen_at) > ATTENTION_MS)
    return true;
  const key = credentialState(d.credential_expires_at, now);
  return key === 'warn' || key === 'expired';
}
export function summary(r: Registry, now: number) {
  const live = r.devices.filter((d) => d.status !== 'revoked');
  return {
    online: live.filter((d) => online(d, now)).length,
    attention: live.filter((d) => attention(d, now)).length,
    pending: live.filter((d) => d.status === 'pending').length,
  };
}
export function countdown(expires: string | null, now: number) {
  const left = Math.max(0, Math.ceil(((expires ? Date.parse(expires) : now) - now) / 1000));
  return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
}
export const reasonValid = (reason: string) =>
  reason.trim().length >= 3 && reason.trim().length <= 500;
export const nameValid = (name: string) => name.trim().length >= 2 && name.trim().length <= 64;
export const sameName = (typed: string, d: Device) =>
  typed.trim().toLocaleLowerCase('ru') === d.name.trim().toLocaleLowerCase('ru');

export type Action = 'code' | 'cancel_code' | 'rename' | 'revoke' | 'journal';
/**
 * MVP: only kiosks are managed from the cabinet. The cashier node is never revocable here,
 * kitchen, board and cashier screens stay read-only until the edge pairing protocol exists.
 */
export function actions(d: Device, r: Registry): Action[] {
  if (r.source !== 'registry') return [];
  if (r.role !== 'manager' || d.role !== 'kiosk' || d.status === 'revoked') return ['journal'];
  const list: Action[] = [];
  // An active kiosk is reset by revoking it and pairing a new device (the scope trigger
  // forbids moving kiosk rows), so a new code is offered only while the kiosk is pending.
  if (r.kiosk_supported && d.status === 'pending') list.push('code');
  if (d.open_code) list.push('cancel_code');
  list.push('rename', 'journal');
  if (d.revocable && !d.payment_open) list.push('revoke');
  return list;
}
export const canPair = (r: Registry | null) =>
  r?.source === 'registry' && r.role === 'manager' && r.kiosk_supported;

/** Write response {device, pairing:{id, purpose, expires_at, login, password}}; shown once. */
export function parseIssued(value: unknown) {
  const o = object(pick(object(value), 'pairing'));
  const login = pick(o, 'login'),
    password = pick(o, 'password'),
    code = pick(o, 'code');
  const hasLogin = typeof login === 'string' && typeof password === 'string';
  if (!hasLogin && typeof code !== 'string') throw invalid();
  if (hasLogin && (!/^[A-Za-z0-9_.-]{3,64}$/.test(login) || password.length < 12)) throw invalid();
  if (typeof code === 'string' && !/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code)) throw invalid();
  return {
    codeId: uuid(pick(o, 'id')),
    login: hasLogin ? login : null,
    password: hasLogin ? password : null,
    code: typeof code === 'string' ? code : null,
    expiresAt: stamp(pick(o, 'expires_at'), false)!,
  };
}
export function parseEvents(value: unknown): DeviceEvent[] {
  const list = Array.isArray(value) ? value : pick(object(value), 'events');
  if (!Array.isArray(list) || list.length > 200) throw invalid();
  return list.map((v) => {
    const o = object(v);
    return {
      action: text(pick(o, 'action'), 64)!,
      actor_kind: text(pick(o, 'actor_kind'), 32, true) ?? '',
      reason: text(pick(o, 'reason'), 500, true),
      at: stamp(pick(o, 'at') ?? pick(o, 'created_at'), false)!,
    };
  });
}
export const EVENT_LABELS: Record<string, string> = {
  created: 'Устройство добавлено',
  code_issued: 'Выпущен код подключения',
  code_cancelled: 'Код отменён',
  paired: 'Устройство подключено',
  pair_failed_burned: 'Код сожжён после ошибок ввода',
  renamed: 'Переименовано',
  revoked: 'Доступ отозван',
  credential_rotated: 'Ключ обновлён',
  staff_reset_requested: 'Запрошен сброс пароля сотрудника',
  staff_reset_applied: 'Пароль сотрудника сброшен',
  terminal_mirrored: 'Экран зарегистрирован кассой',
};

export function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.reason === 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL') return EDGE_HINT;
    const reasons: Record<string, string> = {
      CODE_ALREADY_ISSUED:
        'Код по этому запросу уже выпущен и повторно не показывается. Выпустите новый код.',
      CONFIRM_NAME_MISMATCH: 'Введите название устройства точно как в карточке.',
      CODE_NOT_OPEN: 'Код уже использован, отменён или истёк. Обновите список.',
      DEVICE_NOT_PENDING:
        'Устройство уже подключено. Чтобы заменить iPad, отключите его и подключите новый.',
      DEVICE_REVOKED: 'Доступ устройства уже отозван.',
      PAIRING_NOT_CONFIGURED: 'Подключение устройств на сервере пока не настроено.',
      KIOSK_NOT_CONFIGURED: 'Киоск для этой точки пока не настроен.',
      ROLE_PAIRING_NOT_READY: 'Этот тип устройства пока подключается только на кассе.',
      PAIRING_RATE_LIMITED: 'Слишком много кодов за короткое время. Подождите 10 минут.',
      KIOSK_PAYMENT_OPEN: 'Идёт оплата Kaspi. Отключить киоск можно только после закрытия платежа.',
      KIOSK_REVOKE_USES_REGISTRY: 'Киоск отключается в разделе «Устройства».',
    };
    if (e.reason && reasons[e.reason]) return reasons[e.reason]!;
    const known: Record<string, string> = {
      FORBIDDEN: 'Действие доступно только управляющему этой точки.',
      CONFLICT: 'Состояние устройства уже изменилось. Обновите список и повторите.',
      NOT_FOUND: 'Устройство не найдено. Обновите список.',
      INVALID_REQUEST: 'Сервер отклонил данные. Проверьте название и причину.',
      SERVICE_UNAVAILABLE: 'Реестр устройств временно недоступен. Повторите позже.',
      RATE_LIMITED: 'Слишком много запросов за короткое время. Подождите и повторите.',
    };
    if (known[e.code]) return known[e.code]!;
  }
  return message(e);
}
const registryMissing = (e: unknown) =>
  e instanceof ApiError &&
  e.status === 404 &&
  (e.code === 'INVALID_RESPONSE' || (e.code === 'NOT_FOUND' && !e.reason));

const serviceOff = (e: unknown) =>
  e instanceof ApiError && e.status === 503 && e.code === 'SERVICE_UNAVAILABLE' && !e.reason;

export class DevicesModel {
  actor = '';
  branch = '';
  data: Registry | null = null;
  /** The registry route is not installed on this server: the view falls back to read-only. */
  unavailable = false;
  busy = false;
  error = '';
  notice = '';
  loadedAt = 0;
  pairing: Pairing | null = null;
  private skew = 0;
  private generation = 0;
  constructor(
    private api: (path: string, request?: Request) => Promise<unknown>,
    private changed: () => void,
    private clock: () => number = () => Date.now(),
  ) {}
  /** Server time estimate: as_of plus the time elapsed since the snapshot. */
  now() {
    return this.clock() + this.skew;
  }
  clear() {
    this.generation++;
    this.actor = '';
    this.branch = '';
    this.data = null;
    this.unavailable = false;
    this.busy = false;
    this.error = '';
    this.notice = '';
    this.loadedAt = 0;
    this.pairing = null;
  }
  async scope(actor: string, branch: string) {
    if (this.actor === actor && this.branch === branch) return this.load();
    this.clear();
    this.actor = actor;
    this.branch = branch;
    return this.load();
  }
  private path(suffix = '') {
    return `branches/${this.branch}/devices${suffix}`;
  }
  async load() {
    if (!this.actor || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    this.changed();
    try {
      const value = await this.api(this.path());
      const data = parseRegistry(value, this.branch);
      if (generation !== this.generation) return;
      this.data = data;
      this.unavailable = false;
      this.error = '';
      this.skew = Date.parse(data.as_of) - this.clock();
      this.followPairing();
    } catch (e) {
      if (generation !== this.generation) return;
      // Route not installed (404), or BACKOFFICE_DEVICE_REGISTRY_ENABLED off (503) before any
      // registry answer: the read-only operations list stays, without actions.
      if (registryMissing(e) || (!this.data && serviceOff(e))) {
        this.unavailable = true;
        this.data = null;
        this.error = '';
      } else this.error = explain(e);
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.loadedAt = this.clock();
        this.changed();
      }
    }
  }
  /** Seconds between automatic refreshes: 3 s while a code waits for the iPad, else 15 s. */
  nextDelay() {
    return this.pairing?.stage === 'code' ? 3000 : 15000;
  }
  device(id: string | null) {
    return this.data?.devices.find((d) => d.id === id) ?? null;
  }
  startPairing(existing?: Device) {
    const n = (this.data?.devices.filter((d) => d.role === 'kiosk').length ?? 0) + 1;
    this.pairing = {
      stage: 'form',
      deviceId: existing?.id ?? null,
      name: existing?.name ?? `iPad-киоск ${n}`,
      createRequest: crypto.randomUUID(),
      codeRequest: crypto.randomUUID(),
      codeId: null,
      login: null,
      password: null,
      code: null,
      expiresAt: null,
      error: '',
    };
    this.changed();
  }
  closePairing() {
    this.pairing = null;
    this.changed();
  }
  private forget(p: Pairing, stage: Pairing['stage']) {
    p.stage = stage;
    p.password = null;
    p.code = null;
  }
  /** Expiry and pairing are observed from the registry and the clock, never assumed. */
  followPairing() {
    const p = this.pairing;
    if (!p || p.stage !== 'code') return;
    const d = this.device(p.deviceId);
    if (d && d.status === 'active' && (!d.open_code || d.open_code.id !== p.codeId))
      this.forget(p, 'paired');
    else if (d?.status === 'revoked') this.forget(p, 'cancelled');
    else if (p.expiresAt && Date.parse(p.expiresAt) <= this.now()) this.forget(p, 'expired');
  }
  tick() {
    const before = this.pairing?.stage;
    this.followPairing();
    if (this.pairing && before !== this.pairing.stage) this.changed();
  }
  async issue(name: string, reason: string) {
    const p = this.pairing;
    if (!p || p.stage === 'issuing' || !this.data || !canPair(this.data)) return false;
    if (!p.deviceId && !nameValid(name)) {
      p.error = 'Название устройства - от 2 до 64 символов.';
      this.changed();
      return false;
    }
    if (!reasonValid(reason)) {
      p.error = 'Укажите причину: от 3 до 500 символов.';
      this.changed();
      return false;
    }
    p.stage = 'issuing';
    p.error = '';
    p.name = name.trim();
    this.changed();
    try {
      let issued: ReturnType<typeof parseIssued>;
      if (!p.deviceId) {
        // Creating the kiosk issues its first code in the same command (bo_commands).
        const created = object(
          await this.api(this.path(), {
            method: 'POST',
            body: {
              request_id: p.createRequest,
              role: 'kiosk',
              name: p.name,
              reason: reason.trim(),
            },
          }),
        );
        const deviceId = uuid(pick(object(pick(created, 'device')), 'id'));
        issued = parseIssued(created);
        p.deviceId = deviceId;
      } else
        issued = parseIssued(
          await this.api(this.path(`/${p.deviceId}/pairing-codes`), {
            method: 'POST',
            body: { request_id: p.codeRequest, reason: reason.trim() },
          }),
        );
      if (this.pairing !== p) return false;
      Object.assign(p, issued, { stage: 'code' as const });
      void this.load();
      return true;
    } catch (e) {
      if (this.pairing !== p) return false;
      p.stage = 'form';
      p.error = explain(e);
      if (!p.deviceId && e instanceof ApiError && e.reason === 'CODE_ALREADY_ISSUED') {
        // The kiosk was created by an earlier attempt whose reply was lost; its code is never
        // shown again. The card appears in the list, a new code is issued from there.
        p.error =
          'Киоск уже создан, но его код больше не будет показан. Закройте окно и выпустите новый код в карточке киоска.';
        void this.load();
      } else if (p.deviceId) {
        // A lost reply may have issued a code that is never shown again: a new request id
        // issues a fresh code, and the server cancels the previous open one.
        p.codeRequest = crypto.randomUUID();
        if (e instanceof ApiError && e.code === 'NETWORK')
          p.error =
            'Ответ не получен. Если код был выпущен, он больше не будет показан. Выпустите новый код - прежний будет отменён.';
      }
      this.changed();
      return false;
    }
  }
  async cancelCode(deviceId: string, codeId: string, reason = CANCEL_REASON) {
    if (this.busy) return false;
    try {
      await this.api(this.path(`/${deviceId}/pairing-codes/${codeId}/cancel`), {
        method: 'POST',
        body: { request_id: crypto.randomUUID(), reason },
      });
      if (this.pairing?.codeId === codeId) this.forget(this.pairing, 'cancelled');
      this.notice = 'Код подключения отменён.';
      void this.load();
      return true;
    } catch (e) {
      this.error = explain(e);
      this.changed();
      return false;
    }
  }
  /** Returns an error text, or '' on success. */
  async revoke(d: Device, reason: string, typedName: string) {
    if (!this.data || !actions(d, this.data).includes('revoke'))
      return 'Это устройство нельзя отключить из кабинета.';
    if (!reasonValid(reason)) return 'Укажите причину: от 3 до 500 символов.';
    if (!sameName(typedName, d)) return 'Введите название устройства точно как в карточке.';
    try {
      await this.api(this.path(`/${d.id}/revoke`), {
        method: 'POST',
        body: { request_id: crypto.randomUUID(), reason: reason.trim(), confirm_name: d.name },
      });
      this.notice = `Доступ устройства «${d.name}» отозван.`;
      void this.load();
      return '';
    } catch (e) {
      return explain(e);
    }
  }
  async rename(d: Device, name: string, reason: string) {
    if (!this.data || !actions(d, this.data).includes('rename'))
      return 'Это устройство нельзя переименовать из кабинета.';
    if (!nameValid(name)) return 'Название устройства - от 2 до 64 символов.';
    if (!reasonValid(reason)) return 'Укажите причину: от 3 до 500 символов.';
    try {
      await this.api(this.path(`/${d.id}/rename`), {
        method: 'POST',
        body: { request_id: crypto.randomUUID(), name: name.trim(), reason: reason.trim() },
      });
      this.notice = 'Название сохранено.';
      void this.load();
      return '';
    } catch (e) {
      return explain(e);
    }
  }
  async events(d: Device) {
    return parseEvents(await this.api(this.path(`/${d.id}/events`)));
  }
}
