import { request, assetPrefix, ApiError } from '../api.js';
import { displayPage, prefix, cloudPrefix, type DisplayItem } from '../types.js';
import { displayWindow, type Owner, type StreamStatus } from '../model.js';
import { streamIndicatorsElement } from './StreamStatus.js';
import type { TerminalAccess } from '../terminal-access.js';
/** Paired display never creates/imports a staff session or offers a kitchen action. */
export class DisplayAccess {
  private items: DisplayItem[] = [];
  private error = '';
  private busy = false;
  private page = 0;
  /** Cloud kitchen numbers (iPad 300-599, app 600-899) merged with the cashier's (portal flag). */
  cloud = false;
  streams: Record<Owner, StreamStatus> = { edge: 'unknown', cloud: 'unknown' };
  private last: Record<Owner, DisplayItem[]> = { edge: [], cloud: [] };
  constructor(
    private readonly access: TerminalAccess,
    private readonly changed: () => void,
  ) {}
  rotate() {
    this.page++;
    this.changed();
  }
  private async readNumbers(base: string) {
    const next: DisplayItem[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const page = displayPage(
        await request(base + '/display?limit=100' + (cursor ? '&afterNumber=' + cursor : ''), null),
      );
      next.push(...page.items);
      if (page.next === null) {
        cursor = null;
        break;
      }
      if (page.next === cursor) throw new Error();
      cursor = page.next;
    }
    if (cursor !== null) throw new Error();
    return next;
  }
  async refresh() {
    if (this.busy || !this.access.paired) return;
    this.busy = true;
    try {
      if (!this.cloud) {
        try {
          this.items = await this.readNumbers(prefix);
          this.error = '';
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            this.items = [];
            await this.access.check();
          }
          this.error = 'Нет свежего ответа кассы. Показаны последние полученные номера.';
        }
        return;
      }
      const [edge, cloud] = await Promise.allSettled([
        this.readNumbers(prefix),
        this.readNumbers(cloudPrefix),
      ]);
      for (const [owner, result] of [
        ['edge', edge],
        ['cloud', cloud],
      ] as const) {
        this.streams[owner] = result.status === 'fulfilled' ? 'online' : 'offline';
        if (result.status === 'fulfilled') this.last[owner] = result.value;
        else if (result.reason instanceof ApiError && result.reason.status === 401) {
          this.last[owner] = [];
          if (owner === 'edge') await this.access.check();
        }
      }
      const numbers = new Set(this.last.edge.map((i) => i.number));
      this.items = [...this.last.edge, ...this.last.cloud.filter((i) => !numbers.has(i.number))];
      this.error =
        edge.status === 'rejected' && cloud.status === 'rejected'
          ? 'Нет свежего ответа кассы и сервера. Показаны последние полученные номера.'
          : '';
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  render(root: HTMLElement, branch: string) {
    const header = document.createElement('header'),
      brand = document.createElement('div');
    brand.className = 'brand';
    const logo = document.createElement('img');
    logo.src = assetPrefix + '/logo.png';
    logo.alt = 'Pick Chick';
    brand.append(logo);
    const title = document.createElement('h1');
    title.textContent = 'Табло выдачи';
    const place = document.createElement('p');
    place.textContent = branch;
    header.append(brand, title, place);
    const main = document.createElement('main');
    main.className = 'board';
    const window = displayWindow(this.items, this.page);
    for (const [label, kind, items] of [
      ['Готовим', 'preparing', window.preparing],
      ['Готово', 'ready', window.ready],
    ] as const) {
      const section = document.createElement('section');
      section.className = kind;
      const heading = document.createElement('h2');
      heading.textContent = label;
      section.append(heading);
      const numbers = document.createElement('div');
      numbers.className = 'numbers';
      for (const item of items) {
        const article = document.createElement('article'),
          number = document.createElement('strong');
        number.textContent = item.number;
        article.append(number);
        if (item.name) {
          const name = document.createElement('span');
          name.className = 'guest-display-name';
          name.textContent = item.name;
          article.append(name);
        }
        numbers.append(article);
      }
      if (!items.length) {
        const p = document.createElement('p');
        p.textContent = 'Новые номера появятся здесь';
        numbers.append(p);
      }
      section.append(numbers);
      main.append(section);
    }
    root.replaceChildren(header, main);
    if (this.cloud) root.append(streamIndicatorsElement(this.streams));
    // With the cloud stream the cashier's own outage is shown by the indicator, not as an error.
    if (this.error || (this.access.error && !this.cloud)) {
      const p = document.createElement('p');
      p.className = 'error';
      p.setAttribute('role', 'status');
      p.textContent = this.access.error || this.error;
      root.append(p);
    }
  }
}
