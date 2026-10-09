import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate as flush } from 'node:timers/promises';
import ts from 'typescript';

// Run the actual native adapter with controlled native events and no native runtime/network.
const source = readFileSync(
  new URL('../../apps/mobile/src/connectivity.ts', import.meta.url),
  'utf8',
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const online = { isConnected: true, isInternetReachable: true };
const offline = { isConnected: false, isInternetReachable: false };
function fixture(t) {
  let appListener;
  let networkListener;
  let removed = 0;
  let unsubscribed = 0;
  let configuration;
  const pending = [];
  const active = [];
  const native = {
    configure(value) {
      configuration = value;
    },
    addEventListener(listener) {
      networkListener = listener;
      return () => unsubscribed++;
    },
    refresh() {
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  const modules = {
    '@react-native-community/netinfo': { default: native },
    'react-native': {
      AppState: {
        currentState: 'active',
        addEventListener(event, listener) {
          assert.equal(event, 'change');
          appListener = listener;
          return {
            remove() {
              removed++;
            },
          };
        },
      },
    },
    './api': { API_URL: 'https://fixture.invalid' },
  };
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require(name) {
      assert.ok(name in modules, `Unexpected module ${name}`);
      return modules[name];
    },
  });
  const unsubscribe = exports.subscribeCatalogConnectivity({
    setActive(value) {
      active.push(value);
    },
  });
  t.after(unsubscribe);
  return {
    app: (state) => appListener(state),
    network: (state) => networkListener(state),
    active,
    pending,
    unsubscribe,
    configuration,
    removals: () => [removed, unsubscribed],
  };
}

test('foreground refresh recovers a stale offline native snapshot without another network event', async (t) => {
  const h = fixture(t);
  h.network(offline);
  h.app('background');
  h.app('active');
  h.app('active');
  assert.equal(h.pending.length, 1, 'Duplicate active notifications share the transition');
  assert.equal(h.active.at(-1), false);
  h.pending[0].resolve(online);
  await flush();
  assert.equal(h.active.at(-1), true);
  assert.equal(h.configuration.reachabilityMethod, 'GET');
  assert.equal(h.configuration.reachabilityUrl, 'https://fixture.invalid/health/live');
  assert.equal(await h.configuration.reachabilityTest({ status: 200 }), true);
  assert.equal(await h.configuration.reachabilityTest({ status: 503 }), false);
});

test('background and a newer foreground refresh supersede an old refresh response', async (t) => {
  const h = fixture(t);
  h.network(offline);
  h.app('background');
  h.app('active');
  h.app('inactive');
  h.pending[0].resolve(online);
  await flush();
  assert.equal(h.active.at(-1), false, 'Late refresh cannot resume reads in background');
  h.app('active');
  assert.equal(h.pending.length, 2);
  h.pending[1].resolve(offline);
  await flush();
  assert.equal(h.active.at(-1), false);
});

test('a refresh from an earlier foreground cannot overwrite the current foreground result', async (t) => {
  const h = fixture(t);
  h.network(offline);
  h.app('background');
  h.app('active');
  h.app('background');
  h.app('active');
  assert.equal(h.pending.length, 2);
  h.pending[1].resolve(offline);
  await flush();
  const count = h.active.length;
  h.pending[0].resolve(online);
  await flush();
  assert.equal(h.active.length, count);
  assert.equal(h.active.at(-1), false);
});

test('a newer network event wins over an older foreground refresh', async (t) => {
  const h = fixture(t);
  h.app('background');
  h.app('active');
  h.network(offline);
  const count = h.active.length;
  h.pending[0].resolve(online);
  await flush();
  assert.equal(h.active.length, count);
  assert.equal(h.active.at(-1), false);
});

test('cleanup ignores pending refreshes and queued native callbacks', async (t) => {
  const h = fixture(t);
  h.app('background');
  h.app('active');
  h.unsubscribe();
  assert.deepEqual(h.removals(), [1, 1]);
  const count = h.active.length;
  h.pending[0].resolve(online);
  h.network(online);
  h.app('background');
  h.app('active');
  await flush();
  assert.equal(h.active.length, count);
  assert.equal(h.pending.length, 1);
});

test('refresh rejection keeps the last observation and does not reject unhandled', async (t) => {
  const h = fixture(t);
  h.network(offline);
  h.app('background');
  h.app('active');
  const count = h.active.length;
  h.pending[0].reject(new Error('Native refresh temporarily unavailable'));
  await flush();
  assert.equal(h.active.length, count);
  assert.equal(h.active.at(-1), false);
  h.network(online);
  assert.equal(h.active.at(-1), true);
});
