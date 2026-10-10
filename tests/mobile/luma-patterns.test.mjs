import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TOAST_DURATION_MS,
  TOASTS,
  lumaPalette,
  orderStatusLine,
  readyTransition,
  slideConfirmed,
  slideProgress,
  toastShouldDismiss,
  toastStyle,
} from '../../apps/mobile/src/luma-patterns.ts';
import { orderStage } from '../../apps/mobile/src/order-status.ts';

const read = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const tasks = (prep, assembly = 'pending') => [
  { station: 'prep', state: prep },
  { station: 'assembly', state: assembly },
];

test('status line follows the server state and the same assembly rule as orderStage', () => {
  const base = { number: '342', tasks: tasks('pending') };
  assert.deepEqual(orderStatusLine({ ...base, state: 'paid' }), {
    icon: 'checkmark-circle',
    label: 'Заказ принят',
    tone: 'success',
    accessibilityLabel: 'Заказ принят. Ваш номер 342',
  });
  assert.equal(orderStatusLine({ ...base, state: 'preparing' }).label, 'Готовится');
  const assembling = { ...base, state: 'preparing', tasks: tasks('done') };
  assert.equal(orderStatusLine(assembling).label, 'Собираем');
  assert.equal(orderStage({ ...assembling, snapshot: {} }), 'На сборке');
  assert.equal(orderStatusLine({ ...base, state: 'preparing', tasks: [] }).label, 'Готовится');
  assert.equal(orderStatusLine({ ...base, state: 'ready' }).label, 'Готов - заберите на выдаче');
  assert.equal(orderStatusLine({ ...base, state: 'fulfilled' }).label, 'Выдан');
  assert.equal(orderStatusLine({ ...base, state: 'cancelled' }).icon, 'close-circle');
  assert.equal(
    orderStatusLine({ state: 'paid', number: null }).accessibilityLabel,
    'Заказ принят',
    'no invented number',
  );
});

test('ready toast only for a live transition, never for an order opened as ready', () => {
  assert.equal(readyTransition('preparing', 'ready'), true);
  assert.equal(readyTransition(null, 'ready'), false);
  assert.equal(readyTransition(undefined, 'ready'), false);
  assert.equal(readyTransition('ready', 'ready'), false);
  assert.equal(readyTransition('preparing', 'fulfilled'), false);
});

test('toast timing, swipe-up dismissal and AA contrast', () => {
  assert.equal(TOAST_DURATION_MS, 2500);
  assert.equal(toastShouldDismiss(-30, 0), true);
  assert.equal(toastShouldDismiss(-5, -800), true);
  assert.equal(toastShouldDismiss(-10, -100), false);
  assert.equal(toastShouldDismiss(40, 900), false, 'a downward drag never dismisses');
  for (const tone of ['success', 'info']) {
    const { background, ink, icon } = toastStyle(tone);
    assert.ok(contrast(ink, background) >= 4.5, `${tone} text ${contrast(ink, background)}`);
    assert.ok(contrast(icon, background) >= 3, `${tone} icon ${contrast(icon, background)}`);
  }
  assert.ok(contrast(lumaPalette.lightInk, lumaPalette.light) >= 4.5);
  assert.equal(TOASTS.addedToCart.text, 'Добавлено в корзину');
  assert.equal(TOASTS.orderReady.text, 'Заказ готов - заберите на выдаче');
});

test('slide-to-confirm clamps the knob and confirms only near the end', () => {
  assert.equal(slideProgress(-40, 200), 0);
  assert.equal(slideProgress(100, 200), 0.5);
  assert.equal(slideProgress(400, 200), 1);
  assert.equal(slideProgress(50, 0), 0, 'no track yet means no progress');
  assert.equal(slideConfirmed(0.5), false);
  assert.equal(slideConfirmed(0.89), false);
  assert.equal(slideConfirmed(0.9), true);
});

test('components keep accessibility and motion contracts', () => {
  const sheet = read('components/ConfirmSheet.tsx');
  assert.match(sheet, /role="dialog"/);
  assert.match(sheet, /accessibilityViewIsModal/);
  assert.match(sheet, /useReducedMotion\(\)/);
  assert.match(sheet, /isReduceTransparencyEnabled/);
  assert.match(sheet, /withSpring\(0, SHEET_SPRING\)/);
  assert.match(sheet, /Escape/);
  const slide = read('components/SlideToConfirm.tsx');
  assert.match(slide, /accessibilityActions=\{\[\{ name: 'activate'/);
  assert.match(slide, /actionName === 'activate'\) confirm\(\)/);
  assert.match(slide, /useReducedMotion\(\)/);
  const toast = read('components/Toast.tsx');
  assert.match(toast, /announceForAccessibility/);
  assert.match(toast, /role="status"/);
  assert.match(toast, /TOAST_DURATION_MS/);
  // Owner rule: plain hyphen in interface texts.
  for (const file of [
    'luma-patterns.ts',
    'components/ConfirmSheet.tsx',
    'components/Toast.tsx',
    'components/SlideToConfirm.tsx',
    'components/OrderStatusLine.tsx',
    'components/CatalogChangeNotice.tsx',
  ])
    assert.doesNotMatch(read(file), /[–—]/, file);
});

test('screens use the patterns only where the events already exist', () => {
  const cancel = read('screens/ConnectedOrderScreens.tsx');
  assert.match(cancel, /<SlideToConfirm/);
  assert.match(cancel, /onPress=\{\(\) => setConfirmCancel\(true\)\}/);
  const profile = read('screens/ProfileScreen.tsx');
  assert.match(profile, /title="Выйти из профиля\?"/);
  assert.match(read('screens/ProductConfiguration.tsx'), /toast\(TOASTS\.addedToCart\)/);
  assert.match(read('screens/PhotoProduct.tsx'), /toast\(TOASTS\.addedToCart\)/);
  const status = read('screens/OrderStatusScreen.tsx');
  assert.match(status, /readyTransition\(previous, order\.state\)/);
  // No restaurant phone in the directory: there is no call action.
  assert.doesNotMatch(status, /Позвонить|tel:/);
  assert.doesNotMatch(read('../../../config/restaurant-locations.json'), /phone/);
});
