import assert from 'node:assert/strict';
import test from 'node:test';
import {createReviewWriter} from '../shared/selection-state.mjs';
import {createWorkbench} from '../shared/workbench.mjs';

const {pageSlice, adjacentAsset, detailShortcut, resolveJumpPage, createBatchReviewIntent, selectionRange} = createWorkbench({});

test('page slices use the requested size and keep the default for existing callers', () => {
  const items = Array.from({length: 63}, (_, index) => index + 1);
  assert.deepEqual(pageSlice(items, 2).items, items.slice(20, 40));
  assert.deepEqual(pageSlice(items, 8, 50), {
    items: items.slice(50),
    page: 2,
    total: 63,
    totalPages: 2,
    start: 51,
    end: 63,
    hasPrevious: true,
    hasNext: false
  });
  assert.deepEqual(pageSlice(items, 2, 100).items, items);
  assert.deepEqual(pageSlice(items, 2, 0), pageSlice(items, 2));
  assert.deepEqual(pageSlice([], 3, 50), {
    items: [],
    page: 1,
    total: 0,
    totalPages: 0,
    start: 0,
    end: 0,
    hasPrevious: false,
    hasNext: false
  });
});

test('jump input clamps numeric pages and ignores nonnumeric input', () => {
  assert.equal(resolveJumpPage(' 3 ', 6), 3);
  assert.equal(resolveJumpPage('99', 6), 6);
  assert.equal(resolveJumpPage('-4', 6), 1);
  assert.equal(resolveJumpPage('4.9', 6), 4);
  assert.equal(resolveJumpPage(2, 0), 1);
  for (const value of ['', ' ', 'three', '4a', '0x10', 'Infinity', NaN, null, true]) {
    assert.equal(resolveJumpPage(value, 6), null);
  }
});

test('detail navigation follows the complete display order and stops at the ends', () => {
  const items = ['d', 'a', 'c', 'b', 'e'].map(id => ({id}));
  assert.equal(adjacentAsset(items, 'a', 1), items[2]);
  assert.equal(adjacentAsset(items, 'c', -1), items[1]);
  assert.equal(adjacentAsset(items, 'b', 1), items[4]);
  assert.equal(adjacentAsset(items, 'e', 1), null);
  assert.equal(adjacentAsset(items, 'd', -1), null);
  assert.equal(adjacentAsset(items, 'missing', 1), null);
  assert.equal(adjacentAsset([], 'a', 1), null);
});

test('detail shortcuts map review, navigation, comment, close and selection keys', () => {
  for (const [key, status] of [['1', 'keep'], ['2', 'check'], ['3', 'skip'], ['0', 'pending']]) {
    assert.deepEqual(detailShortcut({key}), {type: 'review', status});
  }
  for (const [key, direction] of [['ArrowLeft', -1], ['k', -1], ['K', -1], ['ArrowRight', 1], ['j', 1], ['J', 1]]) {
    assert.deepEqual(detailShortcut({key}), {type: 'adjacent', direction});
  }
  assert.deepEqual(detailShortcut({key: 'c'}), {type: 'comment'});
  assert.deepEqual(detailShortcut({key: 'C'}), {type: 'comment'});
  assert.deepEqual(detailShortcut({key: 'Escape'}), {type: 'close'});
  assert.deepEqual(detailShortcut({key: ' '}), {type: 'selection'});
  for (const key of ['/', '[', ']', 'PageUp', 'PageDown', 'Tab', 'Enter']) {
    assert.equal(detailShortcut({key}), null);
  }
});

test('detail shortcuts respect input focus, composition, modifiers and handled events', () => {
  for (const key of ['1', '2', '3', '0', 'ArrowLeft', 'ArrowRight', 'j', 'k', 'c', ' ', 'Escape']) {
    for (const property of ['defaultPrevented', 'isComposing', 'ctrlKey', 'altKey', 'metaKey']) {
      assert.equal(detailShortcut({key, [property]: true}), null, `${property} ${key}`);
    }
    if (key === 'Escape') continue;
    assert.equal(detailShortcut({key}, {editing: true}), null);
    assert.equal(detailShortcut({key}, {commentFocused: true}), null);
  }
  assert.deepEqual(detailShortcut({key: 'Escape'}, {editing: true, commentFocused: true}), {type: 'blurComment'});
  assert.equal(detailShortcut({key: ' '}, {spaceTarget: true}), null);
  for (const key of ['ArrowLeft', 'ArrowRight', '0']) assert.equal(detailShortcut({key}, {viewerFocused: true}), null);
  assert.deepEqual(detailShortcut({key: '1'}, {viewerFocused: true}), {type: 'review', status: 'keep'});
});

test('batch review intent changes only status and timestamp and rebases against current comments', () => {
  const updatedAt = '2026-11-11T00:00:00.000Z';
  const intent = createBatchReviewIntent(new Set(['one', 'two']), 'check', updatedAt);
  assert.deepEqual(intent, {
    reviews: {one: {status: 'check', updatedAt}, two: {status: 'check', updatedAt}},
    mergeReviews: true
  });

  let bytes = JSON.stringify({
    version: 1,
    reviews: {one: {status: 'keep', comment: 'Edited in another tab'}, three: {status: 'skip'}},
    selected: ['one', 'two']
  });
  let writes = 0;
  const writer = createReviewWriter({
    getItem: () => bytes,
    setItem: (_, value) => {
      writes++;
      bytes = value;
    }
  }, {reviewKey: 'review'});
  const result = writer.save(intent, {
    reviews: {one: {status: 'keep', comment: 'Old comment'}},
    selected: ['one', 'two'],
    legacySelected: ['one', 'two']
  });

  assert.equal(result.ok, true);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(bytes).reviews, {
    one: {status: 'check', comment: 'Edited in another tab', updatedAt},
    two: {status: 'check', comment: '', updatedAt},
    three: {status: 'skip'}
  });
  assert.deepEqual(result.selected, ['one', 'two']);
});

test('shift range includes both endpoints in display order', () => {
  const items = ['d', 'a', 'c', 'b'].map(id => ({id}));
  assert.deepEqual(selectionRange(items, 'a', 'b'), ['a', 'c', 'b']);
  assert.deepEqual(selectionRange(items, 'b', 'a'), ['a', 'c', 'b']);
  assert.deepEqual(selectionRange(items, 'c', 'c'), ['c']);
  assert.deepEqual(selectionRange(items, 'missing', 'c'), ['c']);
  assert.deepEqual(selectionRange(items, 'c', 'missing'), []);
});
