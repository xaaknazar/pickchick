/**
 * Background restaurant traffic for the offline stand: cashier sales, kitchen passes, kiosk and
 * mobile guests, bank answers. Every loop records unexpected failures instead of throwing, so a
 * scenario can finish and report them. Expected refusals (restaurant offline, stopped item) are
 * counted by the actors.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { isNetwork } from './restaurant.mjs';

export const DEFAULT_RATES = {
  posPerMinute: 12,
  cancelShare: 0.1,
  kitchenEveryMs: 1500,
  kitchenShare: 0.7,
  channelPerMinute: 4,
  bankEveryMs: 1500,
  replayShare: 0.3,
};

export class Traffic {
  constructor(restaurant, rates = {}) {
    this.r = restaurant;
    this.rates = { ...DEFAULT_RATES, ...rates };
    this.running = false;
    this.loops = [];
    this.journeys = new Set();
    this.errors = [];
    this.stats = {
      mobile_started: 0,
      mobile_paid: 0,
      mobile_abandoned_no_reservation: 0,
      kiosk_started: 0,
    };
    this.channels = true;
  }
  record(where, error) {
    if (this.errors.length < 50)
      this.errors.push({
        where,
        code: error?.code ?? error?.name ?? 'ERROR',
        message: String(error?.message ?? error).slice(0, 200),
      });
  }
  async loop(name, intervalMs, step) {
    while (this.running) {
      const started = Date.now();
      try {
        await step();
      } catch (error) {
        this.record(name, error);
      }
      const wait = Math.max(50, intervalMs() - (Date.now() - started));
      await sleep(wait);
    }
  }
  start() {
    if (this.running) return;
    this.running = true;
    const r = this.r,
      rates = this.rates;
    const jitter = (ms) => ms * (0.5 + r.random());
    this.loops = [
      this.loop(
        'pos',
        () => jitter(60000 / rates.posPerMinute),
        async () => {
          if (rates.posPerMinute > 0) await r.posSale({ cancel: r.random() < rates.cancelShare });
        },
      ),
      this.loop(
        'kitchen',
        () => rates.kitchenEveryMs,
        () => r.kitchenPass({ share: rates.kitchenShare }),
      ),
      this.loop(
        'channel',
        () => jitter(60000 / Math.max(rates.channelPerMinute, 0.01)),
        async () => {
          if (!this.channels || rates.channelPerMinute <= 0) return;
          const journey = (r.random() < 0.5 ? this.mobileJourney() : this.kioskJourney()).catch(
            (error) => this.record('channel', error),
          );
          this.journeys.add(journey);
          journey.finally(() => this.journeys.delete(journey));
        },
      ),
      this.loop(
        'bank',
        () => rates.bankEveryMs,
        () => r.kioskBankPass(),
      ),
    ];
  }
  async stop() {
    this.running = false;
    await Promise.all(this.loops);
    await Promise.allSettled([...this.journeys]);
    this.loops = [];
  }
  /** Guest orders in the app; pays only after the cashier reserved the order (section 4). */
  async mobileJourney() {
    const entry = await this.r.mobileOrder();
    if (!entry) return;
    this.stats.mobile_started++;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && this.running) {
      if ((await this.r.reservationState(entry.orderId)) === 'held') break;
      await sleep(500);
    }
    if ((await this.r.reservationState(entry.orderId)) !== 'held') {
      this.stats.mobile_abandoned_no_reservation++;
      entry.abandoned = true;
      return;
    }
    await this.r.mobilePayStart(entry);
    await sleep(200 + this.r.random() * 1500);
    await this.r.mobileBankConfirms(entry, { replay: this.r.random() < this.rates.replayShare });
    this.stats.mobile_paid++;
  }
  async kioskJourney() {
    const entry = await this.r.kioskOrder();
    if (entry) this.stats.kiosk_started++;
  }
}

/** Retry a step that may hit a restarting process; anything else propagates. */
export async function patiently(step, attempts = 20) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (!isNetwork(error) || attempt >= attempts) throw error;
      await sleep(1000);
    }
  }
}
