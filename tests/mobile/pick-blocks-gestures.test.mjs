import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockDrag,
  blockDragAxis,
  isBlockDrop,
} from '../../apps/mobile/src/games/pick-blocks/gestures.ts';

test('a cell of finger travel moves one cell, without 0.85x acceleration', () => {
  assert.deepEqual(blockDrag(25, 0, 26), { x: 0, y: 0 });
  assert.deepEqual(blockDrag(26, 0, 26), { x: 1, y: 0 });
  assert.deepEqual(blockDrag(-52, 0, 26), { x: -2, y: 0 });
});

test('the first deliberate motion locks the axis for the whole touch', () => {
  assert.equal(blockDragAxis(5, 7, null), null);
  const horizontal = blockDragAxis(27, 3, null);
  assert.equal(horizontal, 'horizontal');
  assert.equal(blockDragAxis(27, 90, horizontal), horizontal);
  assert.deepEqual(blockDrag(27, 90, 26, horizontal), { x: 1, y: 0 });
  const vertical = blockDragAxis(2, 27, null);
  assert.equal(vertical, 'vertical');
  assert.equal(blockDragAxis(90, 53, vertical), vertical);
  assert.deepEqual(blockDrag(90, 53, 26, vertical), { x: 0, y: 2 });
  assert.equal(isBlockDrop(0, 80, 26, 150), true);
});
