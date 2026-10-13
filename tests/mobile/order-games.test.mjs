import test from 'node:test';
import assert from 'node:assert/strict';
import {
  carouselIndex,
  openOrderGame,
  orderGameIds,
} from '../../apps/mobile/src/games/order-games.ts';

test('tracker games follow published availability and the Pick Farm flag', () => {
  const all = () => true;
  assert.deepEqual(orderGameIds(all, false), ['pick-blocks', 'pick-man', 'magic-sort']);
  assert.deepEqual(orderGameIds(all, true), ['pick-blocks', 'pick-man', 'magic-sort', 'pick-farm']);
  assert.deepEqual(
    orderGameIds((template) => template !== 'pick-man', false),
    ['pick-blocks', 'magic-sort'],
  );
  // Magic Sort has no published switch, exactly like its «События» card.
  assert.deepEqual(
    orderGameIds(() => false, false),
    ['magic-sort'],
  );
});

test('one helper opens every game with the order origin, after the host closes', () => {
  const calls = [];
  const router = { push: (href) => calls.push(['push', href]) };
  openOrderGame(router, 'pick-blocks', () => calls.push(['before']));
  openOrderGame(router, 'magic-sort');
  assert.deepEqual(calls, [
    ['before'],
    ['push', { pathname: '/games/pick-blocks', params: { from: 'order' } }],
    ['push', { pathname: '/games/magic-sort', params: { from: 'order' } }],
  ]);
});

test('carousel position follows the scroll offset and marks the last card at the end', () => {
  // 393 pt phone: three 300 pt cards, 12 pt gaps and 20 pt fields scroll at most 571 pt.
  assert.equal(carouselIndex(0, 312, 3, 571), 0);
  assert.equal(carouselIndex(150, 312, 3, 571), 0);
  assert.equal(carouselIndex(312, 312, 3, 571), 1);
  assert.equal(carouselIndex(571, 312, 3, 571), 2);
  // A wide screen shows every card; reaching the end still selects the last one.
  assert.equal(carouselIndex(196, 312, 3, 196), 2);
  assert.equal(carouselIndex(-40, 312, 3, 571), 0);
  assert.equal(carouselIndex(5000, 312, 3, 0), 2);
  assert.equal(carouselIndex(100, 312, 1, 0), 0);
});
