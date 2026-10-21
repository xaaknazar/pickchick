import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function mount() {
  const events = {};
  const unsubscribers = [];
  let queries = 0;
  let added = 0;
  let removed = 0;
  let resolve;
  let snapshot;
  const native = {
    AccessibilityInfo: {
      isReduceMotionEnabled: () => {
        queries += 1;
        return new Promise((done) => {
          resolve = done;
        });
      },
      addEventListener: listen,
    },
    AppState: { currentState: 'active', addEventListener: listen },
  };
  function listen(name, callback) {
    added += 1;
    events[name] = callback;
    return {
      remove: () => {
        removed += 1;
        delete events[name];
      },
    };
  }
  const source = readFileSync(
    new URL('../../apps/kiosk/src/components/useMotionPreference.ts', import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: (name) =>
      name === 'react-native'
        ? native
        : {
            useSyncExternalStore: (subscribe, getSnapshot) => {
              snapshot = getSnapshot;
              unsubscribers.push(subscribe(() => {}));
              return getSnapshot();
            },
          },
  });
  return {
    use: exports.useMotionPreference,
    result: () => snapshot(),
    counts: () => ({ queries, added, removed }),
    answer: async (value) => {
      resolve(value);
      await Promise.resolve();
    },
    event: (name, value) => events[name](value),
    unmount: () => unsubscribers.pop()(),
  };
}

test('many animated tiles share one native query and listeners, released after the last tile', async () => {
  const m = mount();
  for (let i = 0; i < 80; i++) assert.equal(m.use(), true);
  assert.deepEqual(m.counts(), { queries: 1, added: 2, removed: 0 });
  await m.answer(false);
  assert.equal(m.result(), false);
  for (let i = 0; i < 79; i++) m.unmount();
  assert.equal(m.counts().removed, 0);
  m.unmount();
  assert.equal(m.counts().removed, 2);
});

test('a newer reduced-motion event wins over an older asynchronous query', async () => {
  const m = mount();
  m.use();
  m.event('reduceMotionChanged', true);
  await m.answer(false);
  assert.equal(m.result(), true);
  m.event('reduceMotionChanged', false);
  assert.equal(m.result(), false);
  m.unmount();
});

test('background suspends motion and foreground retains the accessibility preference', async () => {
  const m = mount();
  m.use();
  await m.answer(false);
  m.event('change', 'background');
  assert.equal(m.result(), true);
  m.event('change', 'active');
  assert.equal(m.result(), false);
  m.event('reduceMotionChanged', true);
  m.event('change', 'background');
  m.event('change', 'active');
  assert.equal(m.result(), true);
  m.unmount();
});
