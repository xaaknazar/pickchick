// Small, inert renderer for the designer's sc-if/sc-for template. No eval, scripts,
// HTML event attributes, or network runtime. Dynamic text always uses textContent.
export class TemplateView {
  constructor(template, target) {
    this.template = document.createElement('template');
    this.template.innerHTML = template;
    this.target = target;
  }
  render(values) {
    const focusKey = document.activeElement?.getAttribute('data-focus-key');
    let focusIndex = 0;
    const scrolls = [...this.target.querySelectorAll('*')]
      .filter((e) => e.scrollTop || e.scrollLeft)
      .map((e) => [e.getAttribute('data-scroll-key'), e.scrollTop, e.scrollLeft]);
    const read = (path, scope) =>
      path
        .trim()
        .split('.')
        .reduce((v, k) => v?.[k], scope);
    const val = (text, scope) => {
      const match = /^\s*{{\s*([\w.]+)\s*}}\s*$/.exec(text);
      return match
        ? read(match[1], scope)
        : text.replace(/{{\s*([\w.]+)\s*}}/g, (_, p) => String(read(p, scope) ?? ''));
    };
    let index = 0;
    const render = (node, scope) => {
      if (node.nodeType === Node.TEXT_NODE)
        return document.createTextNode(String(val(node.textContent, scope) ?? ''));
      if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
      const tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'helmet') return document.createDocumentFragment();
      if (tag === 'sc-if') {
        const fragment = document.createDocumentFragment();
        if (val(node.getAttribute('value') ?? '', scope))
          for (const c of node.childNodes) fragment.append(render(c, scope));
        return fragment;
      }
      if (tag === 'sc-for') {
        const fragment = document.createDocumentFragment(),
          list = val(node.getAttribute('list') ?? '', scope);
        if (Array.isArray(list))
          for (const row of list)
            for (const c of node.childNodes)
              fragment.append(render(c, { ...scope, [node.getAttribute('as')]: row }));
        return fragment;
      }
      const element =
        tag === 'image-slot'
          ? document.createElement('div')
          : node.namespaceURI?.includes('svg')
            ? document.createElementNS('http://www.w3.org/2000/svg', tag)
            : document.createElement(tag);
      for (const attr of node.attributes) {
        if (attr.name.startsWith('hint-')) continue;
        const value = val(attr.value, scope);
        if (attr.name.toLowerCase().startsWith('on')) {
          if (attr.name.toLowerCase() === 'onclick' && typeof value === 'function') {
            element.setAttribute('role', 'button');
            element.tabIndex = 0;
            element.setAttribute('data-focus-key', String(focusIndex++));
            element.addEventListener('click', (event) => {
              event.stopPropagation();
              value(event);
            });
            element.addEventListener('keydown', (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                value(event);
              }
            });
          }
          continue;
        }
        if (value !== false && value !== undefined && value !== null)
          element.setAttribute(attr.name, String(value));
      }
      if (element.getAttribute('style')?.includes('overflow'))
        element.setAttribute('data-scroll-key', String(index++));
      for (const child of node.childNodes) element.append(render(child, scope));
      return element;
    };
    const fragment = document.createDocumentFragment();
    for (const node of this.template.content.childNodes) fragment.append(render(node, values));
    this.target.replaceChildren(fragment);
    if (focusKey)
      this.target.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
    for (const [key, top, left] of scrolls) {
      const el = this.target.querySelector(`[data-scroll-key="${key}"]`);
      if (el) {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
    }
  }
}
