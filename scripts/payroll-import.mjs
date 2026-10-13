#!/usr/bin/env node
/** Audited, resumable import via the existing API. No direct DB inserts and no real data in Git.
 * Preview first; apply requires its exact plan hash. Each command has a stable receipt.
 * Partial failures are reported, never undone by deleting already recorded history.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableId = (value) => {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const same = (a, b) => hash(canonical(a)) === hash(canonical(b));
const norm = (name) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
export function planImport(input, snapshot, branch) {
  if (
    input.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !/^\d{4}-\d{2}-01$/.test(input.month) ||
    snapshot.month !== input.month ||
    snapshot.branch_id !== branch ||
    snapshot.role !== 'manager' ||
    snapshot.period.closed
  )
    throw Error('Invalid source/scope or closed period');
  const operations = [],
    seen = new Set();
  const put = (kind, id, payload) => {
    const old = (kind === 'employee' ? snapshot.employees : snapshot.records).find(
      (r) => r.id === id,
    );
    if (old && (!same(old.payload, payload) || (old.kind && old.kind !== kind)))
      throw Error('Imported record was modified; reconcile explicitly');
    operations.push({
      path: kind === 'employee' ? 'commands' : 'workforce/commands',
      body: {
        request_id: stableId([branch, input.sha256, kind, id, 'command']),
        reason: 'Перенос предоставленного табеля ' + input.month.slice(0, 7),
        command: { type: 'save', kind, id, expected_revision: 0, payload },
      },
      existing: Boolean(old),
    });
  };
  for (const person of input.employees) {
    const key = norm(person.name);
    if (seen.has(key)) throw Error('Duplicate employee in input');
    seen.add(key);
    const matches = snapshot.employees.filter((e) => norm(e.payload.name) === key);
    if (matches.length > 1 || matches[0]?.payload.deleted)
      throw Error('Employee mapping ambiguous/deleted');
    const employee_id = matches[0]?.id ?? stableId([branch, 'employee', key]);
    if (!matches.length || employee_id === stableId([branch, 'employee', key]))
      put('employee', employee_id, {
        name: person.name,
        role: 'staff',
        position: person.position || 'Сотрудник',
        active: false,
        employment_status: 'unknown',
        note:
          'Перенесён из табеля ' + input.month.slice(0, 7) + '. Текущий статус требует уточнения.',
      });
    const id = (kind) => stableId([branch, input.sha256, employee_id, kind]);
    if (person.rate_minor && BigInt(person.rate_minor) > 0n) {
      const end = new Date(
        Date.UTC(Number(input.month.slice(0, 4)), Number(input.month.slice(5, 7)), 0),
      )
        .toISOString()
        .slice(0, 10);
      const rate = {
        employee_id,
        effective_date: input.month,
        valid_until: end,
        hourly_minor: person.rate_minor,
      };
      if (
        snapshot.records.some(
          (r) =>
            r.kind === 'rate' &&
            !r.payload.deleted &&
            r.id !== id('rate') &&
            r.payload.employee_id === employee_id &&
            r.payload.effective_date === input.month,
        )
      )
        throw Error('Existing rate conflicts with import');
      put('rate', id('rate'), rate);
    }
    for (const day of person.days) {
      const timeId = id('time:' + day.date);
      if (
        snapshot.records.some(
          (r) =>
            r.kind === 'time' &&
            !r.payload.deleted &&
            r.payload.status !== 'voided' &&
            r.id !== timeId &&
            r.payload.employee_id === employee_id &&
            r.payload.date === day.date,
        )
      )
        throw Error('Existing attendance conflicts with import');
      if (day.source.sha256 !== input.sha256 || day.date.slice(0, 7) !== input.month.slice(0, 7))
        throw Error('Source/date mismatch');
      put('time', timeId, {
        employee_id,
        date: day.date,
        paid_duration_ms: day.paid_duration_ms,
        source: day.source,
        intervals: [],
        source_event_ids: [],
        status: 'approved',
        attendance: 'worked',
        note: 'Часы из предоставленного табеля; время прихода и ухода не указано.',
      });
    }
    if (person.payroll) {
      if (person.payroll.source.sha256 !== input.sha256) throw Error('Source mismatch');
      if (
        snapshot.records.some(
          (r) =>
            r.kind === 'payroll' &&
            !r.payload.deleted &&
            r.payload.status !== 'voided' &&
            r.id !== id('payroll') &&
            r.payload.employee_id === employee_id &&
            r.payload.month === input.month,
        )
      )
        throw Error('Existing payroll conflicts with import');
      put('payroll', id('payroll'), {
        employee_id,
        month: input.month,
        status: 'draft',
        note: 'Историческая ведомость Excel. Проверьте исходные формулы и подтвердите начисление.',
        ...person.payroll,
      });
    }
  }
  // Includes all desired commands, even previously committed ones, so resume uses the same proof.
  return {
    hash: hash(operations.map((o) => ({ path: o.path, body: o.body }))),
    operations,
    summary: {
      commands: operations.length,
      pending: operations.filter((o) => !o.existing).length,
      employees: input.employees.length,
      days: input.employees.reduce((n, p) => n + p.days.length, 0),
    },
  };
}
export async function runImport({ input, branch, request, apply = false, expectedPlan }) {
  const snapshot = await request(`branches/${branch}/workforce?month=${input.month}`);
  const plan = planImport(input, snapshot, branch);
  if (!apply) return { plan: plan.hash, ...plan.summary };
  if (plan.hash !== expectedPlan) throw Error('Plan hash differs; inspect a fresh preview');
  let saved = 0;
  for (const operation of plan.operations) {
    if (operation.existing) continue;
    await request(`branches/${branch}/${operation.path}`, operation.body);
    saved++;
  }
  const after = await request(`branches/${branch}/workforce?month=${input.month}`);
  const verified = planImport(input, after, branch);
  if (verified.summary.pending !== 0) throw Error('Post-import verification incomplete');
  return { plan: plan.hash, saved, verified: true, ...verified.summary };
}
async function main() {
  const args = process.argv.slice(2),
    arg = (name) => args[args.indexOf(name) + 1];
  for (const flag of ['--file', '--token-file', '--branch', '--url'])
    if (!args.includes(flag)) throw Error('Missing ' + flag);
  const input = JSON.parse(await readFile(arg('--file'), 'utf8'));
  const config = JSON.parse(await readFile(arg('--token-file'), 'utf8'));
  const account = (config.accounts ?? [config]).find((a) => a.username === 'ceo');
  if (!/^[a-f0-9]{64}$/.test(account?.token ?? '')) throw Error('Scoped token unavailable');
  const url = new URL(arg('--url'));
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw Error('HTTPS or protected loopback required');
  const request = async (path, body) => {
    const response = await fetch(new URL(path, url.href.endsWith('/') ? url : url.href + '/'), {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + account.token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!response.ok)
      throw Error('API returned ' + response.status + '; retain receipts and inspect privately');
    return response.json();
  };
  console.log(
    JSON.stringify(
      await runImport({
        input,
        branch: arg('--branch'),
        request,
        apply: args.includes('--apply'),
        expectedPlan: args.includes('--expected-plan') ? arg('--expected-plan') : undefined,
      }),
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Payroll import stopped. No records were erased; inspect private input, API status and receipts before resuming.',
    );
    process.exitCode = 1;
  });
