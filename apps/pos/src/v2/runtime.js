import { PosController } from '../model.js';
import { transport } from '../api.js';
const session = {
  getItem: (k) => sessionStorage.getItem(k),
  setItem: (k, v) => sessionStorage.setItem(k, v),
  removeItem: (k) => sessionStorage.removeItem(k),
};
const native = Boolean(
  document.querySelector('meta[name="pickchick-pos-storage"][content="native-v1"]'),
);
const journal = {
  getItem: (k) => (native ? bridge().getItem(k) : localStorage.getItem(k)),
  setItem: (k, v) => (native ? bridge().setItem(k, v) : localStorage.setItem(k, v)),
  removeItem: () => {
    throw new Error('STORAGE_UNAVAILABLE');
  },
};
function bridge() {
  const b = globalThis.pickchickPosJournal;
  if (!b) throw new Error('STORAGE_UNAVAILABLE');
  return b;
}
async function lease(scope) {
  if (!navigator.locks) throw new Error('UNSUPPORTED_BROWSER');
  return new Promise(
    (resolve, reject) =>
      void navigator.locks
        .request('pickchick.pos.' + scope, { ifAvailable: true }, (lock) => {
          if (!lock) {
            reject(new Error('ACTIVE_TAB'));
            return;
          }
          return new Promise((release) => resolve(release));
        })
        .catch(reject),
  );
}
export const model = new PosController(
  transport,
  session,
  journal,
  () => crypto.randomUUID(),
  lease,
);
export async function pinLogin(pin, terminalId) {
  const response = await fetch('/edge/v1/staff/pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, terminal_id: terminalId }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'Подождите минуту перед следующим входом'
        : 'Неверный PIN или рабочее место недоступно',
    );
  await model.login(JSON.stringify(await response.json()));
  if (!model.state.actor) throw new Error('Не удалось открыть сессию кассира');
}
