import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarketState, mergeStatePatch } from '../public/state-stream.js';

const book = price => ({ asks: [{ price, size: 10 }], bids: [], verifiedAt: '2026-10-23T00:00:00Z' });
const initial = () => ({ events: [{ id: 'event-1' }], books: { a: book(0.51), b: book(0.49) }, crown: { status: 'live' }, status: 'live' });

test('增量替换完整订单簿并保留未变化行情，上一状态不被修改', () => {
  const state = initial();
  const replacement = book(0.52);
  const next = mergeStatePatch(state, { set: { updatedAt: 'next' }, books: { a: replacement }, removedBooks: [] });
  assert.equal(next.books.a, replacement);
  assert.equal(next.books.b, state.books.b);
  assert.equal(next.events, state.events);
  assert.equal(next.crown, state.crown);
  assert.equal(next.updatedAt, 'next');
  assert.equal(state.books.a.asks[0].price, 0.51);
  assert.equal(state.updatedAt, undefined);
});

test('删除结束盘口与替换比赛列表可以原子应用', () => {
  const state = initial();
  const next = mergeStatePatch(state, { set: { events: [] }, books: {}, removedBooks: ['a', 'b'] });
  assert.deepEqual(next.books, {});
  assert.deepEqual(next.events, []);
  assert.equal(Object.keys(state.books).length, 2);
});

test('连续增量按收到的顺序更新，不丢失各token的独立变化', () => {
  const first = mergeStatePatch(initial(), { set: {}, books: { a: book(0.6) }, removedBooks: [] });
  const second = mergeStatePatch(first, { set: { status: 'reconnecting' }, books: { b: book(0.4) }, removedBooks: [] });
  assert.equal(second.books.a.asks[0].price, 0.6);
  assert.equal(second.books.b.asks[0].price, 0.4);
  assert.equal(second.status, 'reconnecting');
  const metadata = mergeStatePatch(second, { set: { crown: { status: 'offline' } }, books: {}, removedBooks: [] });
  assert.equal(metadata.books, second.books);
  assert.equal(metadata.crown.status, 'offline');
});

test('没有完整基线或增量结构损坏时拒绝合并', () => {
  const patch = { set: {}, books: {}, removedBooks: [] };
  assert.equal(mergeStatePatch(null, patch), null);
  assert.equal(isMarketState({ events: [], books: [] }), false);
  for (const invalid of [null, {}, { ...patch, set: { events: null } }, { ...patch, set: { books: {} } },
    { ...patch, books: { a: null } }, { ...patch, removedBooks: [3] },
    { ...patch, books: { a: book(0.5) }, removedBooks: ['a'] },
    JSON.parse('{"set":{"__proto__":{}},"books":{},"removedBooks":[]}')]) {
    assert.equal(mergeStatePatch(initial(), invalid), null);
  }
});
