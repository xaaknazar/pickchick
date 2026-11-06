/**
 * Lane bo-ui, audit F01: no lost input in a back-office dialog.
 *
 * A guarded dialog notices every changed field. While it has changes, «Закрыть» and Esc ask
 * before discarding them and the page asks before a reload (`dirtyDialogOpen`, app.ts
 * beforeunload). A dialog with a draft key keeps its input in sessionStorage on every change
 * (the dialog's own code writes it with `writeDraft`) and restores it when opened again, so a
 * reload, a closed tab page or a second Esc that Chrome does not let us cancel loses nothing.
 * A dialog that is not guarded behaves exactly as before: nothing here touches it.
 */
export type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Guard = {
  dirty: boolean;
  question: string;
  store: DraftStore | null;
  key: string | null;
  done: boolean;
};
const guards = new WeakMap<HTMLDialogElement, Guard>();

/** The tab's sessionStorage, or null where the browser refuses it (private mode, policy). */
export function sessionStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
export function readDraft<T>(store: DraftStore | null, key: string): T | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
export function writeDraft(store: DraftStore | null, key: string, value: unknown) {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked storage only loses the reload safety net; the dialog still asks on close.
  }
}
export function dropDraft(store: DraftStore | null, key: string | null) {
  if (!key) return;
  try {
    store?.removeItem(key);
  } catch {
    // Nothing to keep: the draft is gone or the storage is blocked.
  }
}
export const isGuarded = (d: HTMLDialogElement) => guards.has(d);

/** Starts guarding `d`; a second call keeps the first guard. */
export function guard(
  d: HTMLDialogElement,
  options: { question: string; store?: DraftStore | null; key?: string | null; dirty?: boolean },
) {
  if (guards.has(d)) return;
  const g: Guard = {
    dirty: false,
    question: options.question,
    store: options.store ?? null,
    key: options.key ?? null,
    done: false,
  };
  guards.set(d, g);
  const mark = () => {
    if (g.dirty || g.done) return;
    g.dirty = true;
    d.dataset.dirty = 'true';
  };
  if (options.dirty) mark();
  d.addEventListener('input', mark);
  d.addEventListener('change', mark);
  d.addEventListener('cancel', (event) => {
    // Chrome does not let a page refuse a second Esc in a row; the draft then survives the close.
    if (!g.dirty || g.done || !event.cancelable) return;
    event.preventDefault();
    if (window.confirm(g.question)) {
      dropDraft(g.store, g.key);
      g.done = true;
      d.close();
    }
  });
}
/**
 * «Закрыть»: true when the dialog may close. A changed dialog asks first; a confirmed discard
 * also drops the draft.
 */
export function mayClose(d: HTMLDialogElement): boolean {
  const g = guards.get(d);
  if (!g || !g.dirty || g.done) return true;
  if (!window.confirm(g.question)) return false;
  dropDraft(g.store, g.key);
  g.done = true;
  return true;
}
/** The command went through: the dialog closes without a question and its draft is dropped. */
export function settle(d: HTMLDialogElement) {
  const g = guards.get(d);
  if (!g) return;
  g.done = true;
  delete d.dataset.dirty;
  dropDraft(g.store, g.key);
}
/** For beforeunload: an open guarded dialog with changes. */
export const dirtyDialogOpen = () =>
  document.querySelector('dialog.op-dialog[open][data-dirty="true"]') !== null;
