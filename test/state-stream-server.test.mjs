import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStream } from '../src/state-stream.mjs';

function client() {
  return {
    writableLength: 0, destroyed: false, writableEnded: false, messages: [],
    write(text) { this.messages.push(text); },
    destroy() { this.destroyed = true; },
    end() { this.writableEnded = true; },
  };
}
function decode(text) {
  return { event: text.match(/^event: (.+)\n/)[1], data: JSON.parse(text.match(/\ndata: (.+)\n/)[1]) };
}
function latest(response) { return decode(response.messages.at(-1)); }
function initialState() {
  return {
    mode: 'live', range: 'upcoming', events: [{ id: 'game-1' }],
    stream: { connected: true, lastMessageAt: 1 },
    books: { a: { bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.42, size: 10 }] }, b: { bids: [], asks: [] } },
    crown: { status: 'live', markets: [{ id: 'crown-1', odds: 0.98 }] },
  };
}
function merge(state, patch) {
  const next = { ...state, ...patch.set, books: { ...state.books, ...patch.books } };
  for (const token of patch.removedBooks) delete next.books[token];
  return next;
}

test('stream deltas detect in-place book and metadata changes and skip unchanged broadcasts', () => {
  const stream = new StateStream();
  const response = client();
  const state = initialState();
  stream.add(response, state, { delta: true });
  assert.equal(latest(response).event, 'state');
  const baseline = latest(response).data;
  stream.publish(state);
  assert.equal(response.messages.length, 1);

  state.books.a.bids[0].price = 0.41;
  state.stream.lastMessageAt = 2;
  stream.publish(state);
  const update = latest(response);
  assert.equal(update.event, 'patch');
  assert.deepEqual(Object.keys(update.data.books), ['a']);
  assert.deepEqual(update.data.set, { stream: { connected: true, lastMessageAt: 2 } });
  assert.deepEqual(update.data.removedBooks, []);
  assert.deepEqual(merge(baseline, update.data), state);
  assert.equal(baseline.books.a.bids[0].price, 0.4, 'the serialized baseline is not a live mutable reference');
  stream.publish(state);
  assert.equal(response.messages.length, 2);
});

test('settings, market removal, Crown odds and added books are synchronized together', () => {
  const stream = new StateStream();
  const response = client();
  const state = initialState();
  stream.add(response, state, { delta: true });
  const baseline = latest(response).data;
  state.range = 'past';
  state.events.splice(0, 1, { id: 'game-2' });
  state.crown.markets[0].odds = 1.03;
  delete state.books.a;
  state.books.c = { bids: [], asks: [{ price: 0.5, size: 20 }] };
  stream.publish(state);
  const patch = latest(response).data;
  assert.deepEqual(patch.removedBooks, ['a']);
  assert.deepEqual(Object.keys(patch.books), ['c']);
  assert.deepEqual(Object.keys(patch.set), ['range', 'events', 'crown']);
  assert.deepEqual(merge(baseline, patch), state);
});

test('late connection flushes pending changes without skipping updates for existing clients; reconnect gets a full baseline', () => {
  const stream = new StateStream();
  const first = client(); const second = client();
  const state = initialState();
  stream.add(first, state, { delta: true });
  let firstState = latest(first).data;
  state.books.a.asks[0].price = 0.43;
  stream.add(second, state, { delta: true });
  firstState = merge(firstState, latest(first).data);
  assert.equal(latest(second).event, 'state');
  let secondState = latest(second).data;
  assert.deepEqual(firstState, secondState);
  state.books.a.asks[0].size = 8;
  stream.publish(state);
  firstState = merge(firstState, latest(first).data);
  secondState = merge(secondState, latest(second).data);
  assert.deepEqual(firstState, state);
  assert.deepEqual(secondState, state);
  stream.remove(first);
  const reconnected = client();
  stream.add(reconnected, state, { delta: true });
  assert.equal(latest(reconnected).event, 'state');
  assert.deepEqual(latest(reconnected).data, state);
});

test('legacy clients retain full snapshots and each value is serialized once per broadcast for all clients', () => {
  const stream = new StateStream();
  const delta = client(); const legacy = client(); const secondLegacy = client();
  const state = initialState();
  let serialized = 0;
  state.books.a.toJSON = function () { serialized++; return { bids: this.bids, asks: this.asks }; };
  stream.add(delta, state, { delta: true });
  stream.add(legacy, state);
  stream.add(secondLegacy, state);
  serialized = 0;
  state.books.a.asks[0].price = 0.44;
  stream.publish(state);
  assert.equal(serialized, 1);
  assert.equal(latest(delta).event, 'patch');
  assert.equal(latest(legacy).event, 'state');
  assert.deepEqual(latest(legacy).data, JSON.parse(JSON.stringify(state)));
  assert.equal(legacy.messages.at(-1), secondLegacy.messages.at(-1));
});

test('backpressure disconnects a lagging client, while other clients and later baselines remain usable', () => {
  const stream = new StateStream({ maxBufferedBytes: 1024 });
  const slow = client(); const healthy = client();
  const state = initialState();
  stream.add(slow, state, { delta: true });
  stream.add(healthy, state, { delta: true });
  slow.writableLength = 1020;
  state.stream.lastMessageAt++;
  stream.publish(state);
  assert.equal(slow.destroyed, true);
  assert.equal(stream.clients.has(slow), false);
  assert.equal(latest(healthy).event, 'patch');
  healthy.writableLength = 1020;
  state.stream.lastMessageAt++;
  const newcomer = client();
  stream.add(newcomer, state, { delta: true });
  assert.equal(healthy.destroyed, true);
  assert.equal(latest(newcomer).event, 'state');
  assert.deepEqual(latest(newcomer).data, state);
  stream.heartbeat();
  assert.equal(newcomer.messages.at(-1), ': heartbeat\n\n');
  stream.close();
  assert.equal(newcomer.writableEnded, true);
  assert.equal(stream.clients.size, 0);
});
