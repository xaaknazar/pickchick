// app.js needs a browser (DOM, sessionStorage), so lock() is guarded here by its source order:
// the refusal of model.logout() (a paid amount on the terminal, covered by cashier-ui.test.mjs)
// must come before anything is reset, the journal session ended or the PIN screen shown.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../../apps/pos/src/v2/app.js', import.meta.url), 'utf8');
const body = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};

test('lock() leaves everything as it is when logout is refused', () => {
  const lock = body('lock');
  const at = (text) => {
    const i = lock.indexOf(text);
    assert.ok(i >= 0, text);
    return i;
  };
  const refusal = at('if (!model.logout()) return;');
  for (const later of ['sale.reset()', 'ops.reset()', 'endSession()', "screen: 'lock'"])
    assert.ok(refusal < at(later), `${later} comes after the refusal check`);
});

test('no other path locks the screen before model.logout() has agreed', () => {
  // Every model.logout() in app.js has its result checked, so no PIN screen with a live actor.
  const calls = source.match(/model\.logout\(\)/g) ?? [];
  const checked = source.match(/!model\.logout\(\)/g) ?? [];
  assert.equal(calls.length, checked.length);
  const closing = source.indexOf(
    'if (!model.logout()) throw Error(errorMessage(model.state.error));',
  );
  assert.ok(closing > 0);
  assert.ok(closing < source.indexOf("reference.setState({ closeOpen: false, screen: 'lock'"));
  // Only lock() ends the journal session of the desk.
  assert.equal((source.match(/pickchickPosJournal\??\.endSession\(\)/g) ?? []).length, 1);
});
