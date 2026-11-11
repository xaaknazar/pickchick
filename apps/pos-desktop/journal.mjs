import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export const JOURNAL_LIMIT = 100000;
export const JOURNAL_PREFIX = 'pickchick.pos.journal.v1.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = () => {
  throw new Error('STORAGE_UNAVAILABLE');
};
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !uuid.test(value)) fail();
}
function integer(value, min = 1, max = 2147483647) {
  if (!Number.isInteger(value) || value < min || value > max) fail();
}
function text(value, max = 300) {
  if (typeof value !== 'string' || !value.length || value.length > max) fail();
}
function money(value) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    fail();
}
function lineKey(item) {
  if (!item || typeof item !== 'object') fail();
  exact(
    item,
    Object.hasOwn(item, 'modifiers')
      ? ['variant_id', 'quantity', 'modifiers']
      : ['variant_id', 'quantity'],
  );
  id(item.variant_id);
  integer(item.quantity, 1, 99);
  const modifiers = item.modifiers ?? [];
  if (!Array.isArray(modifiers) || modifiers.length > 100) fail();
  const keys = modifiers.map((modifier) => {
    if (!modifier || typeof modifier !== 'object') fail();
    exact(
      modifier,
      Object.hasOwn(modifier, 'quantity')
        ? ['group_id', 'option_id', 'quantity']
        : ['group_id', 'option_id'],
    );
    id(modifier.group_id);
    id(modifier.option_id);
    if (Object.hasOwn(modifier, 'quantity')) integer(modifier.quantity, 1, 99);
    return `${modifier.group_id.toLowerCase()}:${modifier.option_id.toLowerCase()}`;
  });
  if (new Set(keys).size !== keys.length) fail();
  const selections = modifiers
    .map((modifier, index) => `${keys[index]}=${modifier.quantity ?? 1}`)
    .sort();
  return `${item.variant_id.toLowerCase()}|${selections.join('|')}`;
}
/*
 * Paid-sale commands (cutover 19.11, contracts section 5.1): exactly what apps/pos/src/model.ts
 * journals before sending (saleRequest, voidSale, refund, recordFiscal, closeSaleShift) and its
 * parsePending reads back. Every other kind and key is still refused.
 */
const PAYMENT_METHODS = [
  'cash',
  'kaspi_terminal',
  'aggregator_yandex_eda',
  'aggregator_glovo',
  'staff_meal',
  'marketing',
  'kaspi_manual',
  'chocofood',
];
const REFUND_REASONS = [
  'guest_changed_mind',
  'wrong_order',
  'quality',
  'aggregator_cancelled',
  'cashier_error',
  'other',
];
const SALE_KEYS = [
  'quote_id',
  'service_mode_confirmed',
  'order_repeated',
  'external_order_ref',
  'tenders',
  'cash_tendered_minor',
  'beneficiary',
  'reason',
  'approval',
];
const EXTERNAL_ORDER_REF = /^[A-Za-z0-9-]{3,40}$/;
/** The token of a parsed staff/approvals answer (apps/pos/src/types.ts approval). */
const APPROVAL_TOKEN = /^[A-Za-z0-9._~-]{16,256}$/;
/** Only `allowed` keys, each of `required` present. */
function only(value, allowed, required) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  return value;
}
/** A command path such as 'pos/sales/:id/void', `:id` being one uuid. */
function commandPath(path, pattern) {
  text(path, 160);
  const parts = path.split('/'),
    expected = pattern.split('/');
  if (parts.length !== expected.length) fail();
  for (const [index, part] of expected.entries())
    if (part === ':id') id(parts[index]);
    else if (parts[index] !== part) fail();
}
function positive(value) {
  money(value);
  if (value === '0') fail();
}
/** {approval_id, token} of a shift manager approval; the PIN never reaches the journal. */
function proof(value) {
  exact(value, ['approval_id', 'token']);
  id(value.approval_id);
  if (typeof value.token !== 'string' || !APPROVAL_TOKEN.test(value.token)) fail();
}
function refundReason(code, value) {
  if (!REFUND_REASONS.includes(code)) fail();
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 300) fail();
}
function tenderCount(tenders) {
  if (!Array.isArray(tenders) || tenders.length < 1 || tenders.length > 2) fail();
}
function saleBody(path, body) {
  if (path !== 'pos/sales') fail();
  only(body, SALE_KEYS, ['quote_id', 'service_mode_confirmed', 'order_repeated', 'tenders']);
  id(body.quote_id);
  if (body.service_mode_confirmed !== true || body.order_repeated !== true) fail();
  tenderCount(body.tenders);
  for (const tender of body.tenders) {
    only(tender, ['method', 'amount_minor', 'reference'], ['method', 'amount_minor']);
    if (!PAYMENT_METHODS.includes(tender.method)) fail();
    positive(tender.amount_minor);
    if (tender.reference !== undefined) text(tender.reference, 40);
  }
  if (body.external_order_ref !== undefined) {
    text(body.external_order_ref, 40);
    if (!EXTERNAL_ORDER_REF.test(body.external_order_ref)) fail();
  }
  if (body.cash_tendered_minor !== undefined) money(body.cash_tendered_minor);
  if (body.beneficiary !== undefined) text(body.beneficiary, 100);
  if (body.reason !== undefined) {
    text(body.reason);
    if (body.reason.trim().length < 3) fail();
  }
  if (body.approval !== undefined) proof(body.approval);
}
export function validateJournal(key, raw, scope) {
  if (typeof scope !== 'string' || scope.split('.').length !== 3) fail();
  scope.split('.').forEach(id);
  if (
    key !== JOURNAL_PREFIX + scope ||
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') > JOURNAL_LIMIT
  )
    fail();
  const j = exact(JSON.parse(raw), [
    'version',
    'scope',
    'draft',
    'pending',
    'known',
    'selected',
    ...(Object.hasOwn(JSON.parse(raw), 'held') ? ['held'] : []),
  ]);
  if (j.version !== 1 || j.scope !== scope || !Array.isArray(j.known) || j.known.length > 100)
    fail();
  j.known.forEach(id);
  if (j.selected !== null) id(j.selected);
  if (j.held !== undefined && (!Array.isArray(j.held) || j.held.length > 10)) fail();
  for (const draft of [j.draft, ...(j.held ?? [])].filter((d) => d !== null)) {
    const d = exact(draft, [
      'release_id',
      'service_mode',
      'items',
      ...(Object.hasOwn(draft, 'details') ? ['details'] : []),
    ]);
    if (d.details !== undefined) {
      exact(d.details, ['display_name', 'kitchen_comment']);
      if (
        typeof d.details.display_name !== 'string' ||
        [...d.details.display_name].length > 14 ||
        typeof d.details.kitchen_comment !== 'string' ||
        d.details.kitchen_comment.length > 60
      )
        fail();
    }
    id(d.release_id);
    if (
      !['takeaway', 'dine_in'].includes(d.service_mode) ||
      !Array.isArray(d.items) ||
      d.items.length > 50
    )
      fail();
    if (new Set(d.items.map(lineKey)).size !== d.items.length) fail();
  }
  if (j.pending !== null) {
    // A receipt number also names its order (`subject`), read again after the answer.
    const p = exact(j.pending, [
      'key',
      'path',
      'body',
      'kind',
      'at',
      ...(j.pending?.kind === 'fiscal_record' ? ['subject'] : []),
    ]);
    id(p.key);
    text(p.at, 40);
    if (!/^\d{4}-\d\d-\d\dT/.test(p.at) || !Number.isFinite(Date.parse(p.at))) fail();
    if (p.kind === 'create') {
      if (p.path !== 'orders') fail();
      const keys =
        p.body && Object.hasOwn(p.body, 'kitchen_admission')
          ? ['quote_id', 'kitchen_admission']
          : ['quote_id'];
      exact(p.body, keys);
      if (keys.length === 2 && p.body.kitchen_admission !== 'unpaid') fail();
      id(p.body.quote_id);
    } else if (p.kind === 'cancel') {
      text(p.path, 160);
      const parts = p.path.split('/');
      if (parts.length !== 3 || parts[0] !== 'orders' || parts[2] !== 'cancel') fail();
      id(parts[1]);
      exact(p.body, ['expected_version', 'reason']);
      integer(p.body.expected_version);
      text(p.body.reason);
    } else if (p.kind === 'shift_open') {
      if (p.path !== 'cash-shifts') fail();
      exact(p.body, ['opening_cash_minor']);
      money(p.body.opening_cash_minor);
    } else if (p.kind === 'shift_move') {
      text(p.path, 160);
      const parts = p.path.split('/');
      if (parts.length !== 3 || parts[0] !== 'cash-shifts' || parts[2] !== 'movements') fail();
      id(parts[1]);
      exact(p.body, ['direction', 'amount_minor', 'reason']);
      if (!['in', 'out'].includes(p.body.direction)) fail();
      money(p.body.amount_minor);
      text(p.body.reason);
      if (!p.body.reason.trim()) fail();
    } else if (p.kind === 'shift_close') {
      text(p.path, 160);
      const parts = p.path.split('/');
      if (parts.length !== 3 || parts[0] !== 'cash-shifts' || parts[2] !== 'close') fail();
      id(parts[1]);
      // Today's close has exactly these three keys; closing a sales shift may add the Kaspi
      // terminal total and the shift_close_pending_fiscal approval (contracts section 5.1).
      only(
        p.body,
        ['expected_version', 'counted_cash_minor', 'reason', 'terminal_reported_minor', 'approval'],
        ['expected_version', 'counted_cash_minor', 'reason'],
      );
      integer(p.body.expected_version);
      money(p.body.counted_cash_minor);
      text(p.body.reason);
      if (!p.body.reason.trim()) fail();
      if (p.body.terminal_reported_minor !== undefined) money(p.body.terminal_reported_minor);
      if (p.body.approval !== undefined) proof(p.body.approval);
    } else if (p.kind === 'sale') saleBody(p.path, p.body);
    else if (p.kind === 'void') {
      commandPath(p.path, 'pos/sales/:id/void');
      exact(p.body, [
        'expected_version',
        'reason_code',
        'reason',
        'fiscal_sale_issued',
        'approval',
      ]);
      integer(p.body.expected_version);
      refundReason(p.body.reason_code, p.body.reason);
      if (typeof p.body.fiscal_sale_issued !== 'boolean') fail();
      proof(p.body.approval);
    } else if (p.kind === 'refund') {
      commandPath(p.path, 'pos/sales/:id/refunds');
      exact(p.body, ['refund_id', 'tenders', 'reason_code', 'reason', 'approval']);
      id(p.body.refund_id);
      tenderCount(p.body.tenders);
      const tenders = p.body.tenders.map((tender) => {
        exact(tender, ['tender_id', 'amount_minor']);
        id(tender.tender_id);
        positive(tender.amount_minor);
        return tender.tender_id.toLowerCase();
      });
      if (new Set(tenders).size !== tenders.length) fail();
      refundReason(p.body.reason_code, p.body.reason);
      proof(p.body.approval);
    } else if (p.kind === 'fiscal_record') {
      commandPath(p.path, 'pos/fiscal-receipts/:id/record');
      only(
        p.body,
        ['expected_version', 'receipt_number', 'approval'],
        ['expected_version', 'receipt_number'],
      );
      integer(p.body.expected_version);
      text(p.body.receipt_number, 40);
      if (p.body.approval !== undefined) proof(p.body.approval);
      id(p.subject);
    } else if (p.kind === 'ordering') {
      if (!['ordering/open', 'ordering/close'].includes(p.path)) fail();
      exact(p.body, ['expected_version']);
      integer(p.body.expected_version);
    } else if (p.kind === 'stop') {
      if (p.path !== 'availability/stops') fail();
      exact(p.body, [
        'variant_id',
        'expected_version',
        'reason',
        'stopped',
        ...(p.body.duration === undefined ? [] : ['duration']),
      ]);
      if (p.body.duration !== undefined && !['manual', 'hour', 'shift'].includes(p.body.duration))
        fail();
      id(p.body.variant_id);
      integer(p.body.expected_version, 0);
      text(p.body.reason);
      if (typeof p.body.stopped !== 'boolean') fail();
    } else fail();
  }
  return raw;
}

/**
 * True when no stored journal of this desk holds an unanswered command ("Проверить результат").
 * A journal that cannot be read counts as unanswered: the caller must not restart the desk.
 */
export function journalsSettled(directory, fsImpl = fs) {
  if (!isAbsolute(directory)) fail();
  let names;
  try {
    names = fsImpl.readdirSync(directory);
  } catch (error) {
    return error.code === 'ENOENT';
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const path = join(directory, name);
      const stat = fsImpl.lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > JOURNAL_LIMIT) return false;
      const journal = JSON.parse(fsImpl.readFileSync(path, 'utf8'));
      if (!journal || typeof journal !== 'object' || journal.pending !== null) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** A bounded Store for the existing controller. No token, path, delete, or network API. */
export function createJournalStore({
  directory,
  fsImpl = fs,
  platform = process.platform,
  now = Date.now,
}) {
  if (!isAbsolute(directory)) fail();
  let authority = null;
  function ensureDirectory() {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fsImpl.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
  function scopedPath(key) {
    if (!authority || now() >= authority.expiresAt || key !== JOURNAL_PREFIX + authority.scope)
      fail();
    ensureDirectory();
    return join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  }
  function read(key, path) {
    try {
      const stat = fsImpl.lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > JOURNAL_LIMIT) fail();
      return validateJournal(key, fsImpl.readFileSync(path, 'utf8'), authority.scope);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return {
    /** A signed-in cashier or shift manager holds this desk right now. */
    hasSession() {
      return Boolean(authority && now() < authority.expiresAt);
    },
    setSession(value, expectedSessionId) {
      authority = null;
      try {
        const s = exact(value, [
          'session_id',
          'staff_id',
          'terminal_id',
          'branch_id',
          'role',
          'expires_at',
          ...(value?.name === undefined ? [] : ['name']),
        ]);
        if (s.name !== undefined) text(s.name, 100);
        for (const field of ['session_id', 'staff_id', 'terminal_id', 'branch_id']) id(s[field]);
        if (s.session_id !== expectedSessionId || !['cashier', 'shift_manager'].includes(s.role))
          return;
        text(s.expires_at, 40);
        const expiresAt = Date.parse(s.expires_at);
        if (!Number.isFinite(expiresAt) || expiresAt <= now()) return;
        authority = { scope: `${s.branch_id}.${s.staff_id}.${s.terminal_id}`, expiresAt };
      } catch {
        /* Failed or invalid session revokes journal access. */
      }
    },
    getItem(key) {
      return read(key, scopedPath(key));
    },
    setItem(key, value) {
      const path = scopedPath(key);
      validateJournal(key, value, authority.scope);
      // A corrupted existing file is a stop condition, never an empty journal.
      read(key, path);
      const temporary = join(directory, `.write-${randomUUID()}.tmp`);
      let fd;
      let failure;
      try {
        fd = fsImpl.openSync(temporary, 'wx', 0o600);
        fsImpl.writeFileSync(fd, value, 'utf8');
        fsImpl.fsyncSync(fd);
        fsImpl.closeSync(fd);
        fd = undefined;
        // Same directory / volume. Never unlink the previous journal first.
        fsImpl.renameSync(temporary, path);
        // Windows cannot portably open/fsync a directory through Node. The file
        // is flushed before replacement; physical power-loss is not certified.
        if (platform !== 'win32') {
          fd = fsImpl.openSync(directory, 'r');
          fsImpl.fsyncSync(fd);
          fsImpl.closeSync(fd);
          fd = undefined;
        }
      } catch (error) {
        failure = error;
      } finally {
        try {
          if (fd !== undefined) fsImpl.closeSync(fd);
        } catch (error) {
          failure ??= error;
        }
        try {
          fsImpl.unlinkSync(temporary);
        } catch (error) {
          if (error.code !== 'ENOENT') failure ??= error;
        }
      }
      if (failure) throw failure;
    },
  };
}
