// Inert designer template renderer. Dynamic text is never parsed as HTML.
// Retain mounted nodes so PIN entry and clock ticks do not restart animations.
export class TemplateView {
  constructor(template, target) {
    this.template = document.createElement('template');
    this.template.innerHTML = template;
    // Responsive rules also support the formatted designer HTML. Whitespace
    // after declaration separators must not change which breakpoint matches.
    for (const node of this.template.content.querySelectorAll('[style]'))
      node.setAttribute('style', node.getAttribute('style').replace(/([:;,])\s+/g, '$1'));
    this.target = target;
    this.actions = new WeakMap();
  }
  render(values) {
    const focusKey = document.activeElement?.getAttribute('data-focus-key');
    let focusIndex = 0,
      scrollIndex = 0;
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
    const children = (node, scope) =>
      [...node.childNodes].flatMap((child) => describe(child, scope));
    const describe = (node, scope) => {
      if (node.nodeType === Node.TEXT_NODE)
        return [{ text: String(val(node.textContent, scope) ?? '') }];
      if (node.nodeType !== Node.ELEMENT_NODE) return [];
      const tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'helmet') return [];
      if (tag === 'sc-if')
        return val(node.getAttribute('value') ?? '', scope) ? children(node, scope) : [];
      if (tag === 'sc-for') {
        const list = val(node.getAttribute('list') ?? '', scope);
        return Array.isArray(list)
          ? list.flatMap((row) => children(node, { ...scope, [node.getAttribute('as')]: row }))
          : [];
      }
      const attrs = {};
      let action;
      for (const attr of node.attributes) {
        if (attr.name.startsWith('hint-')) continue;
        const value = val(attr.value, scope);
        if (attr.name.toLowerCase().startsWith('on')) {
          if (attr.name.toLowerCase() === 'onclick' && typeof value === 'function') {
            action = value;
            attrs.role = 'button';
            if (values.interactionBusy) attrs['aria-disabled'] = 'true';
            attrs.tabindex = '0';
            attrs['data-focus-key'] = String(focusIndex++);
          }
          continue;
        }
        if (value !== false && value !== undefined && value !== null)
          attrs[attr.name] = String(value);
      }
      if (attrs.style?.includes('overflow')) attrs['data-scroll-key'] = String(scrollIndex++);
      return [
        {
          tag: tag === 'image-slot' ? 'div' : tag,
          svg: tag !== 'image-slot' && node.namespaceURI?.includes('svg'),
          attrs,
          action,
          children: children(node, scope),
        },
      ];
    };
    this.patchChildren(this.target, children(this.template.content, values));
    if (focusKey && !this.target.contains(document.activeElement))
      this.target
        .querySelector('[data-focus-key="' + focusKey + '"]')
        ?.focus({ preventScroll: true });
  }
  matches(node, value) {
    if ('text' in value) return node?.nodeType === Node.TEXT_NODE;
    return (
      node?.nodeType === Node.ELEMENT_NODE &&
      node.tagName.toLowerCase() === value.tag &&
      Boolean(node.namespaceURI?.includes('svg')) === Boolean(value.svg) &&
      node.getAttribute('data-screen-label') === (value.attrs['data-screen-label'] ?? null)
    );
  }
  patchChildren(parent, values) {
    let cursor = parent.firstChild;
    for (const value of values) {
      let node = cursor;
      if (!this.matches(node, value)) {
        node =
          'text' in value
            ? document.createTextNode(value.text)
            : value.svg
              ? document.createElementNS('http://www.w3.org/2000/svg', value.tag)
              : document.createElement(value.tag);
        if (cursor) {
          parent.replaceChild(node, cursor);
        } else parent.append(node);
      }
      if ('text' in value) {
        if (node.nodeValue !== value.text) node.nodeValue = value.text;
      } else {
        for (const attr of [...node.attributes])
          if (!(attr.name in value.attrs)) node.removeAttribute(attr.name);
        for (const [name, text] of Object.entries(value.attrs))
          if (node.getAttribute(name) !== text) node.setAttribute(name, text);
        if (value.action) {
          if (!this.actions.has(node)) {
            node.onclick = (event) => {
              event.stopPropagation();
              this.actions.get(node)?.(event);
            };
            node.onkeydown = (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                this.actions.get(node)?.(event);
              }
            };
          }
          this.actions.set(node, value.action);
        } else if (this.actions.has(node)) {
          this.actions.delete(node);
          node.onclick = null;
          node.onkeydown = null;
        }
        this.patchChildren(node, value.children);
      }
      cursor = node.nextSibling;
    }
    while (cursor) {
      const next = cursor.nextSibling;
      parent.removeChild(cursor);
      cursor = next;
    }
  }
}
