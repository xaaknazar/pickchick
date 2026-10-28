/**
 * Offline stand scenarios (docs/operations/offline-stand.md). Each scenario runs against live
 * background traffic and records what staff saw. Convergence inside a scenario is "the backlog
 * that existed at reconnect is delivered" (traffic keeps running); afterwards the runner stops the
 * traffic, drains every queue and compares both ledgers (checks.mjs).
 */
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import {
  pendingWork,
  drained,
  snapshot,
  evaluate,
  volumes,
  backlogMark,
  backlogDelivered,
  stopsConverged,
  channelOrdersLostByRestore,
} from './checks.mjs';
import { staffView, LABELS } from './staff-view.mjs';
import { WORKERS, checkedAdminUrl, StandError } from './stand.mjs';

const run = promisify(execFile);
const round = (v) => Math.round(v * 10) / 10;
export const check = (id, title, ok, expected, actual, details) => ({
  id,
  title,
  ok: Boolean(ok),
  expected,
  actual,
  ...(details ? { details } : {}),
});
const LIVE_KITCHEN = ['accepted', 'in_production', 'ready', 'handed_over'];

export class Context {
  constructor({ stand, restaurant, traffic, profile, log }) {
    this.stand = stand;
    this.r = restaurant;
    this.traffic = traffic;
    this.profile = profile;
    this.log = log;
    this.observations = {};
  }
  async observe(label) {
    const view = await staffView(this.stand);
    (this.observations[label] ??= []).push({ at: new Date().toISOString(), ...view });
    return view;
  }
  /** Links up and every process running (after a scenario broke something on purpose). */
  async heal() {
    this.stand.wan.set('up');
    this.stand.lan.set('up');
    for (const name of ['api', 'edge', ...WORKERS])
      if (!this.stand.running(name)) await this.stand.start(name);
  }
  /** Seconds until everything queued at `mark` time is delivered (traffic may continue). */
  async cleared(mark, timeoutMs = this.profile.convergeTimeoutMs) {
    const started = Date.now();
    for (;;) {
      if (await backlogDelivered(this.stand, mark))
        return { seconds: round((Date.now() - started) / 1000), converged: true };
      if (Date.now() - started > timeoutMs || this.profile.signal?.aborted)
        return { seconds: round((Date.now() - started) / 1000), converged: false };
      await sleep(500);
    }
  }
  /** Quiescent convergence: traffic stopped, every queue empty, heartbeat and stops current. */
  async converge(timeoutMs = this.profile.convergeTimeoutMs) {
    const started = Date.now();
    await this.heal();
    let pending, fresh, stops;
    for (;;) {
      pending = await pendingWork(this.stand);
      fresh = await this.stand.cloudAvailabilityFresh();
      stops = await stopsConverged(this.stand);
      if (
        (drained(pending) && fresh && stops) ||
        Date.now() - started > timeoutMs ||
        this.profile.signal?.aborted
      )
        break;
      await sleep(1000);
    }
    return {
      seconds: round((Date.now() - started) / 1000),
      pending,
      converged: drained(pending) && fresh && stops,
      fresh,
      stops,
    };
  }
  async verify(context = {}) {
    const data = await snapshot(this.stand);
    return {
      checks: evaluate(data, this.r.ledger, { ...context, pending: await pendingWork(this.stand) }),
      volumes: volumes(data),
    };
  }
  /** Let the traffic run; returns early only when the run is interrupted. */
  async hold(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !this.profile.signal?.aborted)
      await sleep(Math.min(1000, until - Date.now()));
  }
}

/** Mobile guests reserved and paying when the internet drops (AC-18). */
async function inFlightMobile(ctx, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const entry = await ctx.r.mobileOrder();
    if (!entry) continue;
    for (let t = 0; t < 40 && (await ctx.r.reservationState(entry.orderId)) !== 'held'; t++)
      await sleep(500);
    if ((await ctx.r.reservationState(entry.orderId)) !== 'held') continue;
    await ctx.r.mobilePayStart(entry);
    out.push(entry);
  }
  return out;
}
async function orderReview(stand, orderId) {
  const order = (
    await stand.cloud.query(
      'SELECT attention_required,(SELECT count(*)::int FROM commerce_refunds r WHERE r.order_id=o.id) refunds FROM commerce_orders o WHERE id=$1',
      [orderId],
    )
  ).rows[0];
  const tasks = Number(
    (await stand.edge.query('SELECT count(*) FROM fulfillment_tasks WHERE order_id=$1', [orderId]))
      .rows[0].count,
  );
  return { review: order?.attention_required === true, refunds: order?.refunds ?? 0, tasks };
}

export const SCENARIOS = {
  baseline: {
    title: 'Связь в норме: продажи кассы, кухня, киоск и приложение',
    async run(ctx) {
      await ctx.observe('normal');
      await ctx.hold(ctx.profile.baselineMs);
      await ctx.observe('normal');
      return {};
    },
  },

  wan_outage: {
    title: 'Потеря интернета (WAN) во время продаж: касса, кухня, стопы, закрытие смены',
    async run(ctx) {
      const { stand, r, traffic, profile } = ctx;
      const notes = {};
      const checks = [];
      traffic.channels = false;
      await sleep(1500);
      const mobile = await inFlightMobile(ctx, 2);
      const before = { pos: r.counters.pos_sales, kitchen: r.counters.kitchen_actions };
      stand.wan.set(profile.wanFault);
      const outageAt = Date.now();
      // Kiosk guests inside the 30 s detection window: the cloud still trusts the last heartbeat.
      const kiosk = [];
      for (let i = 0; i < 2; i++) {
        const entry = await r.kioskOrder({ items: ['BURGER', 'WINGS'] });
        if (entry) kiosk.push(entry);
      }
      // ... and one whose pie the cashier stops a moment later (paid, then refused by the cashier).
      const stoppedLater = await r.kioskOrder({ items: ['BURGER', 'PIE'] });
      notes.kiosk_sold_in_detection_window = kiosk.length + (stoppedLater ? 1 : 0);
      for (const entry of mobile) await r.mobileBankConfirms(entry);
      notes.mobile_paid_while_offline = mobile.length;
      await r.kioskBankPass();
      await r.posStop('pie', true);
      const remote = await r
        .remoteStop('tea', true)
        .catch((error) => ({ error: error.code ?? error.message }));
      notes.remote_stop_while_offline = remote.error ? `refused: ${remote.error}` : 'queued';
      await ctx.hold(Math.max(0, 35000 - (Date.now() - outageAt)));
      const fresh = await stand.cloudAvailabilityFresh();
      const startedBefore = traffic.stats.mobile_started + traffic.stats.kiosk_started;
      traffic.channels = true;
      const wanView = await ctx.observe('wan_loss');
      const falsePreparing = [];
      for (const entry of [...mobile, ...kiosk, ...(stoppedLater ? [stoppedLater] : [])]) {
        const state = await r.reservationState(entry.orderId);
        if (LIVE_KITCHEN.includes(state)) falsePreparing.push({ order: entry.orderId, state });
      }
      const refunds = Number(
        (
          await stand.cloud.query(
            'SELECT count(*) FROM commerce_refunds r JOIN commerce_orders o ON o.id=r.order_id WHERE o.branch_id=$1',
            [stand.ids.branch],
          )
        ).rows[0].count,
      );
      checks.push(
        check(
          'ac18_no_false_preparing',
          'AC-18: оплаченный до подтверждения кассой заказ не показан как «готовится», возврата нет',
          falsePreparing.length === 0 && refunds === 0 && mobile.length + kiosk.length > 0,
          { false_preparing: 0, refunds: 0 },
          {
            false_preparing: falsePreparing.length,
            refunds,
            in_flight: mobile.length + kiosk.length,
          },
        ),
        check(
          'wan_staff_sees_no_internet',
          'Касса показывает «нет интернета», а не «нет связи с кассой»; кухня - связь в норме',
          wanView.pos === LABELS.posWanDown && wanView.kitchen === LABELS.kitchenLanOk,
          { pos: LABELS.posWanDown, kitchen: LABELS.kitchenLanOk },
          { pos: wanView.pos, kitchen: wanView.kitchen, cloud_link: wanView.cloud_link },
        ),
        check(
          'wan_channels_closed',
          'Через 30 с без связи облако перестаёт продавать в киоске и приложении',
          fresh === false,
          false,
          fresh,
        ),
      );
      await ctx.hold(Math.max(0, profile.wanOutageMs - (Date.now() - outageAt) - 10000));
      const shift = await r.closeAndReopenShift();
      notes.shift_closed_offline = Boolean(shift.closed);
      await ctx.hold(Math.max(0, profile.wanOutageMs - (Date.now() - outageAt)));
      const startedOffline =
        traffic.stats.mobile_started + traffic.stats.kiosk_started - startedBefore;
      const backlog = await pendingWork(stand);
      notes.backlog_at_reconnect = backlog;
      checks.push(
        check(
          'wan_pos_kept_selling',
          'Касса продолжала продавать без интернета',
          r.counters.pos_sales > before.pos,
          '> 0',
          r.counters.pos_sales - before.pos,
        ),
        check(
          'wan_kitchen_kept_working',
          'Кухня по LAN продолжала готовить и выдавать без интернета',
          r.counters.kitchen_actions > before.kitchen && wanView.kitchen === LABELS.kitchenLanOk,
          '> 0',
          r.counters.kitchen_actions - before.kitchen,
        ),
        check(
          'wan_no_channel_sales_offline',
          'Пока касса недоступна, киоск и приложение не создают новых заказов (честный отказ)',
          startedOffline === 0,
          0,
          startedOffline,
          { refused: { mobile: r.counters.mobile_refused, kiosk: r.counters.kiosk_refused } },
        ),
        check(
          'wan_backlog_kept',
          'Накопленные без связи события сохранены на кассе до отправки',
          backlog.pos_events + backlog.kitchen_events > 0,
          '> 0',
          backlog.pos_events + backlog.kitchen_events,
        ),
      );
      const mark = await backlogMark(stand);
      notes.outage_seconds = round((Date.now() - outageAt) / 1000);
      stand.wan.set('up');
      const cleared = await ctx.cleared(mark);
      notes.convergence_seconds = cleared.seconds;
      checks.push(
        check(
          'wan_converged_in_time',
          `После возврата связи накопленное доставлено за ${profile.convergeLimitS} с`,
          cleared.converged && cleared.seconds <= profile.convergeLimitS,
          `<= ${profile.convergeLimitS} с`,
          `${cleared.seconds} с`,
        ),
      );
      // The paid kiosk order with the pie: refused by the cashier -> manager case, no kitchen.
      if (stoppedLater) {
        let state;
        for (let t = 0; t < 60; t++) {
          state = await orderReview(stand, stoppedLater.orderId);
          if (state.review) break;
          await sleep(1000);
        }
        notes.stopped_paid_order = state;
        checks.push(
          check(
            'wan_stopped_paid_order_to_manager',
            'Оплаченный заказ с позицией, остановленной на кассе без связи, ушёл менеджеру: без кухни и без автоматического возврата',
            state.review && state.tasks === 0 && state.refunds === 0,
            { review: true, tasks: 0, refunds: 0 },
            state,
          ),
        );
      }
      await ctx.hold(5000);
      const cloudStops =
        (
          await stand.cloud.query(
            'SELECT stopped_ids FROM cloud_branch_availability WHERE branch_id=$1',
            [stand.ids.branch],
          )
        ).rows[0]?.stopped_ids ?? [];
      const pie = r.variant('pie').variant_id;
      checks.push(
        check(
          'wan_cashier_stop_reached_cloud',
          'Стоп, поставленный на кассе без интернета, дошёл до облака после восстановления',
          cloudStops.includes(pie),
          true,
          cloudStops.includes(pie),
        ),
      );
      if (!remote.error) {
        const command = (
          await stand.cloud.query('SELECT state FROM cloud_stop_commands WHERE id=$1', [
            remote.command_id,
          ])
        ).rows[0];
        notes.remote_stop_result = command?.state;
      }
      await r.posStop('pie', false);
      if (await r.posStopped('tea')) await r.posStop('tea', false);
      else r.stopped.delete('tea');
      return { notes, checks };
    },
  },

  wan_chaos: {
    title: 'Плохая связь: потеря ответа после записи, дубли, опоздавшие и переставленные запросы',
    async run(ctx) {
      const { stand, profile } = ctx;
      stand.wan.set('chaos', profile.chaos);
      const before = stand.wan.stats();
      await ctx.hold(profile.chaosMs);
      const after = stand.wan.stats();
      const injected = Object.fromEntries(
        ['dropped_response', 'duplicated', 'late', 'reordered', 'reset', 'delayed'].map((k) => [
          k,
          after[k] - before[k],
        ]),
      );
      const mark = await backlogMark(stand);
      stand.wan.set('up');
      const cleared = await ctx.cleared(mark);
      return {
        notes: { injected, convergence_seconds: cleared.seconds },
        checks: [
          check(
            'chaos_faults_injected',
            'Стенд действительно терял ответы, дублировал и переставлял запросы',
            injected.dropped_response > 0 &&
              injected.duplicated > 0 &&
              injected.late > 0 &&
              injected.reordered > 0,
            'каждый вид > 0',
            injected,
          ),
          check(
            'chaos_converged',
            `После плохой связи накопленное доставлено за ${profile.convergeLimitS} с`,
            cleared.converged && cleared.seconds <= profile.convergeLimitS,
            `<= ${profile.convergeLimitS} с`,
            `${cleared.seconds} с`,
          ),
        ],
      };
    },
  },

  lan_outage: {
    title: 'Потеря локальной сети между кухней и кассой',
    async run(ctx) {
      const { stand, r, profile } = ctx;
      const before = { pos: r.counters.pos_sales, unreachable: r.counters.kitchen_unreachable };
      const start = r.ledger.pos.size;
      stand.lan.set('down');
      await ctx.hold(Math.min(10000, profile.lanOutageMs));
      const lanView = await ctx.observe('lan_loss');
      await ctx.hold(Math.max(0, profile.lanOutageMs - 10000));
      const createdDuring = [...r.ledger.pos.values()].slice(start);
      stand.lan.set('up');
      // The kitchen screen's next read must list every live order sold while it was cut off.
      const seen = new Set();
      for (const [actor, station] of [
        ['cook', stand.ids.prep],
        ['packer', stand.ids.assembly],
      ])
        for (const order of await r.kitchenQueue(actor, station)) seen.add(order.orderId);
      const states = new Map(
        (
          await stand.edge.query(
            'SELECT order_id,state FROM fulfillment_reservations WHERE branch_id=$1',
            [stand.ids.branch],
          )
        ).rows.map((x) => [x.order_id, x.state]),
      );
      const missing = createdDuring.filter(
        (o) =>
          !seen.has(o.orderId) && !['cancelled', 'handed_over'].includes(states.get(o.orderId)),
      );
      return {
        notes: { orders_during_lan_loss: createdDuring.length },
        checks: [
          check(
            'lan_pos_kept_selling',
            'Касса продолжала продавать при обрыве LAN до кухни',
            r.counters.pos_sales > before.pos,
            '> 0',
            r.counters.pos_sales - before.pos,
          ),
          check(
            'lan_kitchen_saw_loss',
            'Кухонный экран показал потерю связи с кассой',
            lanView.kitchen === LABELS.kitchenLanDown &&
              r.counters.kitchen_unreachable > before.unreachable,
            LABELS.kitchenLanDown,
            lanView.kitchen,
          ),
          check(
            'lan_cashier_unaffected',
            'Касса при этом показывает связь в норме (интернет и касса на месте)',
            lanView.pos === LABELS.posLanOk,
            LABELS.posLanOk,
            lanView.pos,
          ),
          check(
            'lan_orders_reached_kitchen',
            'После восстановления LAN кухня видит все заказы, пробитые без связи',
            missing.length === 0 && createdDuring.length > 0,
            0,
            missing.length,
          ),
        ],
      };
    },
  },

  edge_restart: {
    title: 'Аварийный перезапуск кассового узла и воркеров (обрыв между записью и ACK, AC-16)',
    async run(ctx) {
      const { stand, profile } = ctx;
      // Lost answers on the WAN leave commits without ACK, then the processes die.
      stand.wan.set('chaos', { dropResponse: 0.3, delayMs: [0, 200] });
      const kills = [];
      for (let i = 0; i < profile.edgeKills; i++) {
        await ctx.hold(profile.edgeKillEveryMs);
        const victims =
          i % 2 === 0 ? ['edge', 'fulfillment', 'pos'] : ['fulfillment', 'pos', 'menu'];
        for (const name of victims) await stand.stop(name, 'SIGKILL');
        kills.push(victims.join('+'));
        await sleep(3000);
        for (const name of victims) await stand.start(name);
      }
      const mark = await backlogMark(stand);
      stand.wan.set('up');
      const cleared = await ctx.cleared(mark);
      return {
        notes: {
          kills,
          pos_retries: ctx.r.counters.pos_retries,
          kitchen_retries: ctx.r.counters.kitchen_retries,
          convergence_seconds: cleared.seconds,
        },
        checks: [
          check(
            'edge_restart_converged',
            'После аварийных перезапусков кассы накопленное доставлено',
            cleared.converged,
            true,
            cleared.converged,
          ),
        ],
      };
    },
  },

  cloud_restart: {
    title: 'Аварийный перезапуск облачного API во время работы',
    async run(ctx) {
      const { stand, profile } = ctx;
      await ctx.hold(5000);
      await stand.stop('api', 'SIGKILL');
      await ctx.hold(profile.cloudDownMs);
      await stand.start('api');
      const mark = await backlogMark(stand);
      const cleared = await ctx.cleared(mark);
      return {
        notes: {
          cloud_down_seconds: profile.cloudDownMs / 1000,
          convergence_seconds: cleared.seconds,
        },
        checks: [
          check(
            'cloud_restart_converged',
            'После перезапуска облака касса досылает накопленное',
            cleared.converged,
            true,
            cleared.converged,
          ),
        ],
      };
    },
  },

  edge_restore: {
    title: 'Восстановление БД кассы из копии на другом сервере (fence последовательностей)',
    async run(ctx) {
      const { stand, r, traffic, profile } = ctx;
      const tools = await restoreTools(stand, profile);
      if (tools.skip) return { skipped: tools.skip };
      const notes = {};
      // 1. Hot backup while the restaurant works (as the scheduled cashier backup would).
      const dump = resolve(stand.runDir, 'edge-backup.dump');
      await dockerDump(tools.edgeContainer, stand.schema, dump);
      notes.backup_at = new Date().toISOString();
      // 2. The lost timeline: sales, kitchen work and paid app orders the cloud receives.
      await ctx.hold(profile.restoreLostMs);
      await traffic.stop();
      const before = await ctx.converge();
      notes.lost_timeline_delivered = before.converged;
      // 3. The cashier PC dies; the database is restored on a replacement server.
      for (const name of [...WORKERS, 'edge']) await stand.stop(name, 'SIGKILL');
      await stand.edge.end();
      await prepareRestoreTarget(stand);
      await dockerRestore(tools.restoreContainer, dump);
      stand.edgeAdmin = stand.admin.restore;
      stand.edge = createPool(stand.edgeUrl, 4);
      const restored = new Set(
        (
          await stand.edge.query('SELECT id FROM local_orders WHERE branch_id=$1', [
            stand.ids.branch,
          ])
        ).rows.map((x) => x.id),
      );
      const lostPos = [...r.ledger.pos.keys()].filter((id) => !restored.has(id));
      notes.pos_orders_lost_by_restore = lostPos.length;
      await stand.start('edge');
      const epoch = (
        await stand.edge.query(
          'SELECT reason,sequence_gap::text FROM edge_database_epochs ORDER BY epoch DESC LIMIT 1',
        )
      ).rows[0];
      notes.fence = epoch;
      for (const name of WORKERS) await stand.start(name);
      // Cloud-owned orders the cashier admitted after the backup, in any state: live ones the
      // cloud still shows in the kitchen (the restored cashier has no ticket; a restore needs
      // this list checked) and ones already handed over or cancelled on the lost timeline.
      const reservations = new Set(
        (await stand.edge.query('SELECT order_id FROM fulfillment_reservations')).rows.map(
          (x) => x.order_id,
        ),
      );
      const orphaned = channelOrdersLostByRestore(
        (
          await stand.cloud.query(
            'SELECT order_id,state FROM cloud_fulfillment_projection WHERE branch_id=$1',
            [stand.ids.branch],
          )
        ).rows,
        reservations,
      );
      notes.channel_orders_lost_by_restore = orphaned.lost.length;
      notes.channel_orders_lost_live = orphaned.live.length;
      notes.channel_orders_lost_by_state = orphaned.states;
      // 4. The restaurant works again on the restored database.
      r.menu = null;
      const lostChannel = new Set(orphaned.lost);
      traffic.start();
      await ctx.hold(profile.restoreAfterMs);
      // Orders live at backup time that also moved on the lost timeline: the restored cashier
      // re-emits their versions with new events and the cloud refuses them (409).
      const conflicts = await versionConflicts(stand);
      notes.version_conflicts = conflicts;
      const knownIssues =
        conflicts.pos_kitchen + conflicts.pos_orders + conflicts.channel_kitchen > 0
          ? [
              {
                id: 'restore_version_conflict',
                title:
                  'После восстановления кассы заказ, который был в работе в момент копии и продвинулся позже, конфликтует с облаком (409); упорядоченная очередь кухонных событий кассы стоит на нём, новые статусы кухни не доходят до кабинета',
                doc: 'docs/operations/edge-restore.md («Что остаётся ручной сверкой»)',
                evidence: conflicts,
                checks: [
                  ...(conflicts.pos_kitchen
                    ? ['pos_kitchen_in_cloud', 'pos_kitchen_events_once']
                    : []),
                  ...(conflicts.pos_orders ? ['pos_orders_in_cloud', 'pos_events_once'] : []),
                  ...(conflicts.channel_kitchen
                    ? ['channel_projection_matches', 'channel_orders_admitted_once']
                    : []),
                  'queues_drained',
                  'final_drain',
                ],
                // Queue checks are exempt only while nothing but these blocked streams waits.
                pendingKeys: ['pos_events', 'kitchen_events'],
              },
            ]
          : [];
      return {
        notes,
        knownIssues,
        context: { lostPosOrders: lostPos, lostChannelOrders: [...lostChannel] },
        checks: [
          check(
            'restore_fenced',
            'Восстановленная касса сама сдвинула номера событий (fence «restore»)',
            epoch?.reason === 'restore',
            'restore',
            epoch?.reason ?? null,
          ),
          check(
            'restore_lost_window_reported',
            'Потерянный отрезок (заказы после копии) остался в облаке и посчитан',
            lostPos.length > 0 && before.converged,
            '> 0',
            lostPos.length,
          ),
        ],
      };
    },
  },
};

/** Unacknowledged cashier events whose (order, version) the cloud already holds with another
 * event: the signature of a restored cashier re-living the lost timeline. */
export async function versionConflicts(stand) {
  const edge = (
    await stand.edge.query(
      `SELECT 'pos_kitchen' kind,event_id,order_id,aggregate_version FROM fulfillment_outbox
        WHERE branch_id=$1 AND acknowledged_at IS NULL AND payload->>'commercialOwner'='edge_pos'
      UNION ALL SELECT 'channel_kitchen',event_id,order_id,aggregate_version FROM fulfillment_outbox
        WHERE branch_id=$1 AND acknowledged_at IS NULL AND payload->>'commercialOwner' IS DISTINCT FROM 'edge_pos'
      UNION ALL SELECT 'pos_orders',event_id,aggregate_id,aggregate_version FROM outbox_events
        WHERE branch_id=$1 AND acknowledged_at IS NULL AND aggregate_type='order_commercial'`,
      [stand.ids.branch],
    )
  ).rows;
  const result = { pos_kitchen: 0, channel_kitchen: 0, pos_orders: 0 };
  const tables = {
    pos_kitchen: 'pos_kitchen_sync_inbox',
    channel_kitchen: 'cloud_fulfillment_inbox',
    pos_orders: 'pos_order_sync_inbox',
  };
  for (const row of edge) {
    const other = (
      await stand.cloud.query(
        `SELECT 1 FROM ${tables[row.kind]} WHERE order_id=$1 AND aggregate_version=$2 AND event_id<>$3`,
        [row.order_id, row.aggregate_version, row.event_id],
      )
    ).rowCount;
    if (other) result[row.kind]++;
  }
  return result;
}

/** Tools for the restore drill: the database servers' own pg_dump/pg_restore via docker. */
async function restoreTools(stand, profile) {
  if (!stand.admin.restore) return { skip: 'нет OFFLINE_STAND_RESTORE_DATABASE_URL' };
  if (profile.noDocker) return { skip: 'docker отключён параметром' };
  try {
    const container = async (url) => {
      const port = new URL(url).port || '5432';
      const { stdout } = await run(
        'docker',
        ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}'],
        { timeout: 15000 },
      );
      const names = stdout.split('\n').filter(Boolean);
      if (names.length !== 1) throw new StandError('CONTAINER_NOT_UNIQUE', port);
      return names[0];
    };
    return {
      edgeContainer: await container(stand.admin.edge),
      restoreContainer: await container(stand.admin.restore),
    };
  } catch (error) {
    return { skip: `docker недоступен: ${error.code ?? error.message}` };
  }
}
function pipeProcess(args, { input, output }) {
  return new Promise((done, fail) => {
    const child = spawn('docker', args, {
      stdio: [input ? 'pipe' : 'ignore', output ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    if (input) createReadStream(input).pipe(child.stdin);
    let written = Promise.resolve();
    if (output) {
      const file = createWriteStream(output, { mode: 0o600 });
      child.stdout.pipe(file);
      written = new Promise((ok) => file.on('close', ok));
    }
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0
        ? written.then(done)
        : fail(new StandError('DOCKER_TOOL_FAILED', stderr.slice(-300))),
    );
  });
}
const dockerDump = (container, schema, file) =>
  pipeProcess(
    [
      'exec',
      container,
      'pg_dump',
      '-U',
      'pickchick_local',
      '-d',
      'pickchick_edge',
      '-n',
      schema,
      '-Fc',
    ],
    { output: file },
  );
const dockerRestore = (container, file) =>
  pipeProcess(
    [
      'exec',
      '-i',
      container,
      'pg_restore',
      '-U',
      'pickchick_local',
      '-d',
      'pickchick_edge',
      '--exit-on-error',
      '--single-transaction',
    ],
    { input: file },
  );
/** The replacement server gets an empty pickchick_edge database (kept between runs). */
async function prepareRestoreTarget(stand) {
  const maintenance = checkedAdminUrl(stand.admin.restore, 'restore');
  maintenance.pathname = '/postgres';
  const admin = createPool(maintenance.toString(), 1);
  try {
    await admin.query('CREATE DATABASE pickchick_edge');
  } catch (error) {
    if (error.code !== '42P04') throw error;
  } finally {
    await admin.end();
  }
  const target = createPool(stand.admin.restore, 1);
  try {
    if (
      (await target.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [stand.schema])).rowCount
    )
      throw new StandError('SCHEMA_EXISTS', 'restore');
    stand.created.restore = true;
  } finally {
    await target.end();
  }
}

export const SCENARIO_ORDER = [
  'baseline',
  'wan_outage',
  'wan_chaos',
  'lan_outage',
  'edge_restart',
  'cloud_restart',
  'edge_restore',
];
