import { request, assetPrefix, ApiError } from '../api.js';
import { displayPage, type DisplayItem } from '../types.js';
import { displayWindow } from '../model.js';
import type { TerminalAccess } from '../terminal-access.js';
/** Paired display never creates/imports a staff session or offers a kitchen action. */
export class DisplayAccess {
  private items: DisplayItem[] = [];
  private error = '';
  private busy = false;
  private page = 0;
  constructor(
    private readonly access: TerminalAccess,
    private readonly changed: () => void,
  ) {}
  rotate() {
    this.page++;
    this.changed();
  }
  async refresh() {
    if (this.busy || !this.access.paired) return;
    this.busy = true;
    try {
      const next: DisplayItem[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < 10; pages++) {
        const page = displayPage(
          await request(
            '/edge/v1/fulfillment/display?limit=100' + (cursor ? '&afterNumber=' + cursor : ''),
            null,
          ),
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
      this.items = next;
      this.error = '';
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.items = [];
        await this.access.check();
      }
      this.error = 'Нет свежего ответа кассы. Показаны последние полученные номера.';
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
    if (this.error || this.access.error) {
      const p = document.createElement('p');
      p.className = 'error';
      p.setAttribute('role', 'status');
      p.textContent = this.access.error || this.error;
      root.append(p);
    }
  }
}
