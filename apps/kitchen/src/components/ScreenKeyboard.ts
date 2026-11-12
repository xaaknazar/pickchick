/**
 * The kitchen screen's own on-screen keyboard. Kitchen monoblocks have a touch screen and no
 * keyboard, and Windows does not open its touch keyboard for the installed program (in a
 * browser only after a setting is changed on every monoblock). So the page brings a keyboard
 * with it: Latin and Russian letters, digits and the symbols a password may contain.
 *
 * It opens when a text field takes the focus on a workplace that is operated by touch or pen.
 * Any other workplace gets a "Клавиатура" button next to the focused field; once that button
 * was used the keys open by themselves there too, until somebody types on a real keyboard. The
 * keys type into the focused field through the ordinary `input` event, never take the focus
 * and close once no text field has it. While they are shown the page ends above them, so the
 * field being typed in stays visible. Phones and tablets keep the keyboard of their system.
 */
type Field = HTMLInputElement | HTMLTextAreaElement;
type Letters = 'latin' | 'ru';
type Layout = Letters | 'symbols';

const ROWS: Record<Layout, readonly string[]> = {
  latin: ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  ru: ['1234567890', 'йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбюё'],
  symbols: ['1234567890', '!@#$%^&*()', '-_=+[]{};:', '\'",.<>/?\\|~`'],
};
const TEXT_TYPES = new Set(['text', 'password', 'search', 'tel', 'url', 'email', 'number']);

function editable(node: unknown): node is Field {
  if (node instanceof HTMLTextAreaElement) return !node.disabled && !node.readOnly;
  return (
    node instanceof HTMLInputElement &&
    TEXT_TYPES.has(node.type) &&
    !node.disabled &&
    !node.readOnly
  );
}

/** Android, iOS and iPadOS show their own keyboard; the page must not put a second one on top. */
export function hasSystemKeyboard(agent: string, touchPoints: number) {
  return /Android|iPhone|iPad|iPod/i.test(agent) || (/Macintosh/.test(agent) && touchPoints > 1);
}

let installed = false;

export function installScreenKeyboard() {
  if (installed || hasSystemKeyboard(navigator.userAgent, navigator.maxTouchPoints)) return;
  installed = true;

  const root = document.createElement('div');
  root.className = 'screen-keyboard';
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'screen-keyboard-launcher';
  launcher.tabIndex = -1;
  launcher.textContent = 'Клавиатура';
  launcher.setAttribute('aria-label', 'Открыть экранную клавиатуру');
  launcher.hidden = true;
  const panel = document.createElement('div');
  panel.className = 'screen-keyboard-panel';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Экранная клавиатура');
  panel.hidden = true;
  root.append(launcher, panel);

  let open = false;
  /** This workplace types on the screen: the keys open as soon as a text field is focused. */
  let auto = false;
  let owner: Field | null = null;
  let ownerId = '';
  let letters: Letters = 'latin';
  let layout: Layout = 'latin';
  /** 0 lower case, 1 the next letter only, 2 until switched off. */
  let shift: 0 | 1 | 2 = 0;
  let watch: number | undefined;
  let repeat: number | undefined;
  let idle = 0;
  /**
   * The field whose keys were put away with "Скрыть" (or "Ввод" outside a form). A redraw gives
   * the focus back to the field by itself; that must not bring the keys back over the buttons the
   * person wanted to reach. Only a tap on the field or on "Клавиатура" does.
   */
  let dismissed = '';

  /** The field to type into: the focused one, or its replacement after the page was redrawn. */
  function current(): Field | null {
    if (editable(document.activeElement)) return document.activeElement;
    const again = ownerId ? document.getElementById(ownerId) : null;
    if (editable(again)) {
      again.focus({ preventScroll: true });
      // A field that never had the focus has its caret at the start: type at the end instead.
      try {
        again.setSelectionRange(again.value.length, again.value.length);
      } catch {
        // Types such as number have no caret to place.
      }
      return again;
    }
    return null;
  }
  /** A modal dialog makes everything outside it untouchable, so the keyboard moves inside. */
  function mount(field: Field) {
    const host = field.closest('dialog[open]') ?? document.body;
    if (root.parentElement === host) return;
    host.append(root);
    // The dialog takes the keys away with it when it closes; the page gets its height back.
    if (host !== document.body) host.addEventListener('close', () => close(), { once: true });
  }
  function key(label: string, action: string, className = '', name = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = ('screen-key ' + className).trim();
    button.dataset.key = action;
    button.textContent = label;
    if (name) button.setAttribute('aria-label', name);
    return button;
  }
  function draw() {
    const upper = layout !== 'symbols' && shift > 0;
    const rows = ROWS[layout].map((characters, index) => {
      const row = document.createElement('div');
      row.className = 'screen-keyboard-row';
      if (index === 3 && layout !== 'symbols') {
        const caps = key('⇧', 'shift', 'screen-key-wide', 'Верхний регистр');
        caps.setAttribute('aria-pressed', String(shift > 0));
        if (shift === 2) caps.classList.add('screen-key-locked');
        row.append(caps);
      }
      for (const character of characters)
        row.append(key(upper ? character.toUpperCase() : character, 'type'));
      if (index === 3) row.append(key('⌫', 'backspace', 'screen-key-wide', 'Удалить символ'));
      return row;
    });
    const bottom = document.createElement('div');
    bottom.className = 'screen-keyboard-row';
    bottom.append(
      key(
        layout === 'symbols' ? (letters === 'ru' ? 'АБВ' : 'ABC') : '#+=',
        'symbols',
        'screen-key-wide',
        layout === 'symbols' ? 'Буквы' : 'Знаки',
      ),
      key(
        letters === 'ru' ? 'ENG' : 'РУС',
        'language',
        'screen-key-wide',
        letters === 'ru' ? 'Латинские буквы' : 'Русские буквы',
      ),
      key('-', 'type'),
      key('', 'space', 'screen-key-space', 'Пробел'),
      key('.', 'type'),
      key('Ввод', 'enter', 'screen-key-wide screen-key-enter'),
      key('Скрыть', 'hide', 'screen-key-wide', 'Скрыть клавиатуру'),
    );
    panel.replaceChildren(...rows, bottom);
  }
  function measure() {
    document.documentElement.style.setProperty(
      '--screen-keyboard-height',
      (open ? panel.offsetHeight : 0) + 'px',
    );
  }
  /** Where Windows does open its own touch keyboard, it must not cover this one. */
  function own(field: Field) {
    field.setAttribute('inputmode', 'none');
    field.setAttribute('virtualkeyboardpolicy', 'manual');
  }
  function show(field: Field) {
    // A redraw of the page replaces the field by a new one with the same id: still the same
    // field for the person, so the chosen letters and register stay.
    const same = open && (field === owner || (!!field.id && field.id === ownerId));
    mount(field);
    if (!same) {
      letters = field.dataset.keyboard === 'ru' ? 'ru' : 'latin';
      layout = letters;
      shift =
        field.getAttribute('autocapitalize') === 'characters'
          ? 2
          : letters === 'ru' && !field.value
            ? 1
            : 0;
    }
    const replaced = same && field !== owner;
    owner = field;
    ownerId = field.id;
    dismissed = '';
    own(field);
    open = true;
    idle = 0;
    launcher.hidden = true;
    panel.hidden = false;
    draw();
    document.documentElement.classList.add('screen-keyboard-open');
    measure();
    if (!same || replaced) reveal(field, !same);
    watch ??= window.setInterval(settle, 400);
  }
  /**
   * Bring the field into the part of the page above the keys. A message of the form (a refused
   * sign-in) stays in sight too: it is shown above the field and would be scrolled away if the
   * field were centred. A redrawn form starts at the top again, so the replacement field is
   * brought back without a jump when it is already visible.
   */
  function reveal(field: Field, centre: boolean) {
    const alert =
      [
        ...(field.closest('dialog, main') ?? document).querySelectorAll<HTMLElement>(
          '[role="alert"]:not([hidden])',
        ),
      ].find((node) => node.textContent?.trim()) ?? null;
    if (centre && !alert) {
      field.scrollIntoView({ block: 'center', inline: 'nearest' });
      return;
    }
    alert?.scrollIntoView({ block: 'start', inline: 'nearest' });
    const box = field.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight - panel.offsetHeight)
      field.scrollIntoView({ block: alert ? 'end' : 'center', inline: 'nearest' });
  }
  /** Hide the keys. With a text field still focused the small button stays to bring them back. */
  function close() {
    window.clearInterval(repeat);
    repeat = undefined;
    const field = editable(document.activeElement) ? document.activeElement : null;
    if (open) {
      open = false;
      panel.hidden = true;
      document.documentElement.classList.remove('screen-keyboard-open');
      measure();
    }
    if (field) mount(field);
    launcher.hidden = !field;
    if (!field) {
      window.clearInterval(watch);
      watch = undefined;
      owner = null;
      ownerId = '';
    }
  }
  /** Runs while something is shown: once no text field has the focus, everything goes away. */
  function settle() {
    if (!root.isConnected) return close();
    if (editable(document.activeElement)) {
      idle = 0;
      return;
    }
    // One tick of grace: a tap on "Показать" or a redraw gives the focus back a moment later.
    if (++idle >= 2) close();
  }
  /**
   * Typing goes through the browser's own editing command first: the field gets the same
   * `input` event and undo history as from a real keyboard. Writing the value directly is the
   * fallback. Either way the browser does not apply `minlength` to this text, so a form that
   * needs a minimum length checks it itself on submit.
   */
  function insert(text: string) {
    const field = current();
    if (!field) return close();
    const start = field.selectionStart,
      end = field.selectionEnd;
    const replaced = start === null || end === null ? 0 : end - start;
    if (field.maxLength >= 0 && field.value.length - replaced + text.length > field.maxLength)
      return;
    if (document.execCommand('insertText', false, text)) return;
    if (start === null || end === null) field.value += text;
    else field.setRangeText(text, start, end, 'end');
    field.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
  }
  function erase() {
    const field = current();
    if (!field) return close();
    const start = field.selectionStart,
      end = field.selectionEnd;
    if (!field.value || (start === 0 && end === 0)) return;
    if (document.execCommand('delete', false)) return;
    if (start === null || end === null) field.value = field.value.slice(0, -1);
    else if (start !== end) field.setRangeText('', start, end, 'end');
    else field.setRangeText('', start - 1, start, 'end');
    field.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }),
    );
  }
  /** "Ввод": a new line in a long text, otherwise the next field of the form, then its submit. */
  function enter() {
    const field = current();
    if (!field) return close();
    if (field instanceof HTMLTextAreaElement) return insert('\n');
    const scope = field.form ?? field.closest('dialog') ?? document.body;
    const fields = [...scope.querySelectorAll<Field>('input, textarea')].filter(editable);
    const next = fields[fields.indexOf(field) + 1];
    if (next) {
      next.focus();
      return;
    }
    // Outside a form "Ввод" only puts the keys away, like "Скрыть".
    if (!field.form) dismissed = field.id;
    close();
    // Like the Enter key: a form whose button is switched off (a login wait) is not sent.
    const submit = field.form?.querySelector<HTMLButtonElement>(
      'button[type="submit"], button:not([type])',
    );
    if (field.form && !submit?.disabled) field.form.requestSubmit();
  }
  function press(button: HTMLButtonElement) {
    const action = button.dataset.key;
    if (action === 'type') {
      insert(button.textContent ?? '');
      if (shift === 1) {
        shift = 0;
        draw();
      }
    } else if (action === 'space') insert(' ');
    else if (action === 'backspace') erase();
    else if (action === 'enter') enter();
    else if (action === 'hide') {
      dismissed = ownerId;
      close();
    } else {
      if (action === 'shift') shift = shift === 0 ? 1 : shift === 1 ? 2 : 0;
      else if (action === 'language') {
        letters = letters === 'ru' ? 'latin' : 'ru';
        layout = letters;
      } else if (action === 'symbols') layout = layout === 'symbols' ? letters : 'symbols';
      draw();
      measure();
    }
  }

  // Keys act on the press itself and cancel it, so the text field never loses the focus.
  root.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target === launcher) {
      const field = current();
      auto = true;
      dismissed = '';
      if (field) show(field);
      return;
    }
    const button = event.target.closest<HTMLButtonElement>('button[data-key]');
    if (!button) return;
    // The press is cancelled, so the browser shows no pressed state of its own.
    button.classList.add('screen-key-pressed');
    window.setTimeout(() => button.classList.remove('screen-key-pressed'), 140);
    press(button);
    window.clearInterval(repeat);
    repeat = undefined;
    if (button.dataset.key === 'backspace') {
      // Holding the key keeps erasing, like a real keyboard.
      let held = 0;
      repeat = window.setInterval(() => {
        if (++held > 6) erase();
      }, 70);
    }
  });
  root.addEventListener('mousedown', (event) => event.preventDefault());
  // A held key (the erase key) must not open the browser's menu over the keys.
  root.addEventListener('contextmenu', (event) => event.preventDefault());
  for (const name of ['pointerup', 'pointercancel', 'blur'] as const)
    window.addEventListener(name, () => {
      window.clearInterval(repeat);
      repeat = undefined;
    });

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.target instanceof Node && root.contains(event.target)) return;
      if (event.pointerType === 'touch' || event.pointerType === 'pen') auto = true;
      if (!editable(event.target)) return;
      // The person taps the field: the keys may come back.
      if (event.target.id === dismissed) dismissed = '';
      if (auto) own(event.target);
    },
    true,
  );
  document.addEventListener('focusin', (event) => {
    if (!editable(event.target)) return;
    idle = 0;
    if (event.target.id !== dismissed) dismissed = '';
    if (open || (auto && !dismissed)) show(event.target);
    else {
      mount(event.target);
      launcher.hidden = false;
      watch ??= window.setInterval(settle, 400);
    }
  });
  // A tap on the field that already has the focus brings the keys back after "Скрыть".
  document.addEventListener('click', (event) => {
    if (auto && !open && editable(event.target) && event.target === document.activeElement) {
      dismissed = '';
      show(event.target);
    }
  });
  // Somebody types on a real keyboard: the screen keys only get in the way.
  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.key.length !== 1 || event.ctrlKey || event.metaKey) return;
    auto = false;
    if (open) close();
  });
  window.addEventListener('resize', () => {
    if (open) measure();
  });
}
