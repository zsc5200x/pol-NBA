import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Monitor } from '../src/monitor.mjs';

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  terminated = false;
  send(value) { this.sent.push(value); }
  terminate() { this.terminated = true; this.readyState = 3; }
  message(value) { this.emit('message', JSON.stringify(value)); }
}

function game(id = 'game', { closed = false } = {}) {
  return {
    id, title: 'Celtics vs. Knicks', slug: `nba-${id}`, startTime: new Date().toISOString(),
    markets: [{ id: `market-${id}`, question: 'Celtics vs. Knicks', sportsMarketType: 'moneyline',
      closed, outcomes: ['Celtics', 'Knicks'], clobTokenIds: ['1001', '1002'], outcomePrices: ['0.54', '0.46'] }],
  };
}

function snapshot(id = '1001', timestamp = 1000) {
  return { asset_id: id, timestamp: String(timestamp), bids: [{ price: '0.5', size: '10' }], asks: [{ price: '0.6', size: '20' }] };
}

function fakeUpstream(overrides = {}) {
  const sockets = [];
  const upstream = {
    sockets,
    discover: async () => [game()],
    books: async ids => ids.map(id => snapshot(id)),
    socket() {
      const socket = new Socket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
    ...overrides,
  };
  return upstream;
}

async function until(predicate, message = 'condition did not become true') {
  const end = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(message);
    await delay(5);
  }
}

async function running(t, upstream) {
  const monitor = new Monitor({ upstream });
  t.after(() => monitor.stop());
  monitor.start();
  await monitor.discoveryPending;
  return monitor;
}

test('discovery subscribes all open outcome assets and WS snapshots/deltas maintain depth', async t => {
  const upstream = fakeUpstream();
  const monitor = await running(t, upstream);
  const socket = upstream.sockets[0];
  assert.deepEqual(JSON.parse(socket.sent[0]), { assets_ids: ['1001', '1002'], type: 'market', custom_feature_enabled: false });
  assert.equal(monitor.snapshot().stream.connected, true);
  socket.message({ event_type: 'book', ...snapshot('1001', 2000) });
  socket.message({ event_type: 'price_change', timestamp: '2001', price_changes: [
    { asset_id: '1001', side: 'BUY', price: '0.5', size: '7' },
    { asset_id: '1001', side: 'SELL', price: '0.55', size: '8' },
  ] });
  assert.deepEqual(monitor.snapshot().books['1001'].bids, [{ price: 0.5, size: 7 }]);
  assert.deepEqual(monitor.snapshot().books['1001'].asks, [{ price: 0.55, size: 8 }, { price: 0.6, size: 20 }]);
  socket.message({ event_type: 'price_change', timestamp: '2002', price_changes: [
    { asset_id: '1001', side: 'BUY', price: '0.5', size: '0' },
    { asset_id: '1001', side: 'SELL', price: '0.55', size: '0' },
  ] });
  assert.deepEqual(monitor.snapshot().books['1001'].bids, []);
  assert.deepEqual(monitor.snapshot().books['1001'].asks, [{ price: 0.6, size: 20 }]);
  assert.equal(monitor.snapshot().books['1001'].timestamp, 2002);
});

test('older WS snapshots and deltas never roll a newer book backward', async t => {
  const upstream = fakeUpstream();
  const monitor = await running(t, upstream);
  const socket = upstream.sockets[0];
  socket.message({ event_type: 'book', ...snapshot('1001', 3000) });
  const original = structuredClone(monitor.snapshot().books['1001']);
  socket.message({ event_type: 'book', ...snapshot('1001', 2000), bids: [] });
  socket.message({ event_type: 'price_change', timestamp: '2999', price_changes: [
    { asset_id: '1001', side: 'BUY', price: '0.5', size: '999' },
  ] });
  assert.deepEqual(monitor.snapshot().books['1001'], original);
});

test('missing or invalid snapshots cannot produce a partial order book from deltas', async t => {
  const monitor = new Monitor({ upstream: fakeUpstream() });
  t.after(() => monitor.stop());
  monitor.stopped = false;
  monitor.tokens = ['1001'];
  monitor.applyMessage({ event_type: 'price_change', timestamp: '5000', price_changes: [
    { asset_id: '1001', side: 'BUY', price: '0.5', size: '10' },
  ] });
  assert.equal(monitor.snapshot().books['1001'], undefined);
  monitor.markBookError('1001', 'waiting for snapshot');
  monitor.applyMessage({ event_type: 'price_change', timestamp: '5001', price_changes: [
    { asset_id: '1001', side: 'SELL', price: '0.6', size: '20' },
  ] });
  assert.deepEqual(monitor.snapshot().books['1001'].asks, []);
  assert.equal(monitor.snapshot().books['1001'].updatedAt, null);
});

test('REST failures retain the last known depth and its timestamp, mark errors, then recover', async t => {
  const upstream = fakeUpstream();
  const monitor = await running(t, upstream);
  const original = structuredClone(monitor.snapshot().books['1001']);
  upstream.books = async () => { throw new Error('simulated upstream timeout'); };
  await monitor.refreshBooks();
  const stale = monitor.snapshot().books['1001'];
  assert.deepEqual(stale.bids, original.bids);
  assert.deepEqual(stale.asks, original.asks);
  assert.equal(stale.updatedAt, original.updatedAt);
  assert.match(stale.error, /simulated upstream timeout/);
  assert.match(monitor.snapshot().error, /订单簿获取失败/);
  assert.equal(monitor.snapshot().status, 'offline');
  upstream.books = async ids => ids.map(id => snapshot(id, 6000));
  await monitor.refreshBooks();
  assert.equal(monitor.snapshot().books['1001'].error, null);
  assert.equal(monitor.snapshot().error, null);
  assert.equal(monitor.snapshot().status, 'live');
});

test('missing assets in a successful REST batch are explicit failures rather than silently fresh data', async t => {
  const upstream = fakeUpstream({ books: async () => [snapshot('1001')] });
  const monitor = await running(t, upstream);
  assert.equal(monitor.snapshot().books['1001'].error, null);
  assert.match(monitor.snapshot().books['1002'].error, /未返回订单簿/);
  assert.equal(monitor.snapshot().books['1002'].updatedAt, null);
  assert.equal(monitor.snapshot().status, 'degraded');
});

test('older REST snapshots cannot overwrite a newer WS update received during the request', async t => {
  const upstream = fakeUpstream();
  const monitor = await running(t, upstream);
  let resolveBooks;
  upstream.books = () => new Promise(resolve => { resolveBooks = resolve; });
  const pending = monitor.refreshBooks();
  upstream.sockets[0].message({ event_type: 'book', ...snapshot('1001', 7000), bids: [{ price: '0.55', size: '30' }] });
  resolveBooks([snapshot('1001', 6000), snapshot('1002', 6000)]);
  await pending;
  assert.deepEqual(monitor.snapshot().books['1001'].bids, [{ price: 0.55, size: 30 }]);
  assert.equal(monitor.snapshot().books['1001'].timestamp, 7000);
});

test('settings generation discards a previous discovery response and automatically retries the new range', async t => {
  const requests = [];
  let finishFirst;
  const upstream = fakeUpstream({
    discover: ({ range }) => {
      requests.push(range);
      if (requests.length === 1) return new Promise(resolve => { finishFirst = resolve; });
      return Promise.resolve([game('new-range')]);
    },
  });
  const monitor = new Monitor({ upstream });
  t.after(() => monitor.stop());
  monitor.start();
  monitor.setSettings({ range: 'past' });
  assert.deepEqual(monitor.snapshot().events, []);
  finishFirst([game('old-range')]);
  await until(() => monitor.snapshot().events[0]?.id === 'new-range', 'new settings were not rediscovered after obsolete discovery completed');
  assert.deepEqual(requests, ['upcoming', 'past']);
  assert.equal(monitor.snapshot().range, 'past');
  assert.equal(monitor.snapshot().events.some(event => event.id === 'old-range'), false);
});

test('closed games are hidden and never enter REST/WS monitoring', async t => {
  let booksCalls = 0;
  const upstream = fakeUpstream({
    discover: async () => [game('settled', { closed: true })],
    books: async () => { booksCalls++; return []; },
  });
  const monitor = new Monitor({ upstream, range: 'past' });
  t.after(() => monitor.stop());
  monitor.start();
  await monitor.discoveryPending;
  assert.deepEqual(monitor.snapshot().events, []);
  assert.deepEqual(monitor.tokens, []);
  assert.equal(upstream.sockets.length, 0);
  assert.equal(booksCalls, 0);
});

test('a game finishing during discovery is removed together with its books and subscription', async t => {
  const upstream = fakeUpstream();
  const monitor = await running(t, upstream);
  const socket = upstream.sockets[0];
  assert.equal(monitor.snapshot().events.length, 1);
  assert.equal(Object.keys(monitor.snapshot().books).length, 2);
  // Completion can be reported before the individual markets close.
  upstream.discover = async () => [{ ...game(), ended: true }];
  await monitor.refreshEvents();
  assert.deepEqual(monitor.snapshot().events, []);
  assert.deepEqual(monitor.snapshot().books, {});
  assert.deepEqual(monitor.tokens, []);
  assert.equal(socket.terminated, true);
  assert.equal(monitor.snapshot().stream.connected, false);
});

test('socket close retains visible depth but blocks deltas until resynchronization', async t => {
  const upstream = fakeUpstream();
  const monitor = await running(t, upstream);
  const original = structuredClone(monitor.snapshot().books['1001'].bids);
  upstream.books = async () => { throw new Error('still offline'); };
  upstream.sockets[0].emit('close');
  await until(() => !monitor.booksPending);
  assert.equal(monitor.snapshot().stream.connected, false);
  assert.deepEqual(monitor.snapshot().books['1001'].bids, original);
  assert.ok(monitor.snapshot().books['1001'].error);
  monitor.applyMessage({ event_type: 'price_change', timestamp: '9999', price_changes: [
    { asset_id: '1001', side: 'BUY', price: '0.5', size: '999' },
  ] });
  assert.deepEqual(monitor.snapshot().books['1001'].bids, original);
});

test('quiet connected books stay verified by PONG without inventing price updates', async t => {
  const upstream = fakeUpstream();
  const monitor = await running(t, upstream);
  const old = new Date(Date.now() - 60000).toISOString();
  for (const book of Object.values(monitor.snapshot().books)) {
    book.updatedAt = old;
    book.verifiedAt = old;
  }
  monitor.snapshot().updatedAt = old;
  monitor.snapshot().verifiedAt = old;
  const originalPrices = structuredClone(monitor.snapshot().books['1001'].bids);
  monitor.publish();
  assert.equal(monitor.snapshot().status, 'offline', 'unverified old data should initially be stale');
  upstream.sockets[0].emit('message', 'PONG');
  const state = monitor.snapshot();
  assert.equal(state.status, 'live', 'heartbeat confirms the stream remains current despite no depth changes');
  assert.ok(Date.parse(state.verifiedAt) > Date.parse(old));
  assert.equal(state.updatedAt, old, 'heartbeat is not a price/depth update');
  for (const book of Object.values(state.books)) {
    assert.ok(Date.parse(book.verifiedAt) > Date.parse(old));
    assert.equal(book.updatedAt, old, 'per-book content timestamp stays unchanged');
  }
  assert.deepEqual(state.books['1001'].bids, originalPrices);
});

test('heartbeat never verifies disconnected, errored or uninitialized books', async t => {
  const upstream = fakeUpstream();
  const monitor = await running(t, upstream);
  const old = new Date(Date.now() - 60000).toISOString();
  const state = monitor.snapshot();
  state.verifiedAt = old;
  for (const book of Object.values(state.books)) book.verifiedAt = old;
  state.stream.connected = false;
  monitor.verifyStream();
  assert.equal(state.verifiedAt, old);
  assert.equal(state.books['1001'].verifiedAt, old);
  state.stream.connected = true;
  monitor.markBookError('1001', 'snapshot invalid after reconnect');
  state.books['1002'].updatedAt = null;
  upstream.sockets[0].emit('message', 'PONG');
  assert.equal(state.books['1001'].verifiedAt, old, 'a healthy transport cannot validate a book with a missing-update error');
  assert.equal(state.books['1001'].error, 'snapshot invalid after reconnect');
  assert.equal(state.books['1002'].verifiedAt, old, 'no full snapshot means there is no valid depth to verify');
});

test('reconnect invalidates depth and accepts an older full snapshot as a fresh authoritative basis', async t => {
  const upstream = fakeUpstream();
  const monitor = await running(t, upstream);
  upstream.sockets[0].message({ event_type: 'book', ...snapshot('1001', 10003) });
  const original = structuredClone(monitor.snapshot().books['1001']);
  monitor.disconnect();
  assert.equal(monitor.snapshot().stream.connected, false);
  assert.deepEqual(monitor.snapshot().books['1001'].bids, original.bids, 'last depth remains visible during reconnect');
  assert.ok(monitor.snapshot().books['1001'].error, 'rebuilding a subscription invalidates its previous incremental basis');
  monitor.connect();
  await until(() => monitor.snapshot().stream.connected);
  const reconnected = upstream.sockets.at(-1);
  reconnected.emit('message', 'PONG');
  assert.ok(monitor.snapshot().books['1001'].error, 'heartbeat alone cannot recover missing deltas');
  reconnected.message({ event_type: 'book', ...snapshot('1001', 10000), bids: [{ price: '0.51', size: '35' }] });
  const recovered = monitor.snapshot().books['1001'];
  assert.equal(recovered.error, null);
  assert.equal(recovered.timestamp, 10000, 'invalid previous timestamp must not block a replacement full snapshot');
  assert.deepEqual(recovered.bids, [{ price: 0.51, size: 35 }]);
  assert.ok(recovered.verifiedAt);
  reconnected.message({ event_type: 'book', ...snapshot('1001', 9999), bids: [] });
  assert.deepEqual(monitor.snapshot().books['1001'].bids, [{ price: 0.51, size: 35 }], 'once healthy, the normal stale-snapshot guard applies again');
});

test('REST loads at most four batches concurrently and publishes ready books without waiting for slow batches', async t => {
  const requests = [];
  let inFlight = 0;
  let peak = 0;
  const upstream = fakeUpstream({
    books: ids => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise(resolve => requests.push({
        ids,
        finish() { inFlight--; resolve(ids.map(id => snapshot(id))); },
      }));
    },
  });
  const monitor = new Monitor({ upstream });
  t.after(() => monitor.stop());
  monitor.stopped = false;
  monitor.tokens = Array.from({ length: 250 }, (_, i) => String(1000 + i));
  monitor.state.eventsUpdatedAt = new Date().toISOString();
  const published = [];
  monitor.on('state', state => published.push(Object.keys(state.books).length));
  const pending = monitor.refreshBooks();
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.ids.length === 50));
  await monitor.refreshBooks();
  assert.equal(requests.length, 4, 'a concurrent refresh must reuse the active round');

  requests[0].finish();
  await until(() => requests.length === 5);
  await until(() => published.length > 0);
  assert.equal(published[0], 50, 'the first ready batch must reach the page while others are still pending');
  assert.equal(monitor.booksPending, true);
  assert.equal(peak, 4, 'parallelism stays bounded while the queue advances');
  for (const request of requests.slice(1)) request.finish();
  await pending;
  assert.equal(Object.keys(monitor.snapshot().books).length, 250);
  assert.equal(new Set(requests.flatMap(request => request.ids)).size, 250);
  assert.equal(monitor.snapshot().status, 'live');
});

test('100ms publication coalesces UI updates while quote history still sees every transition', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const monitor = new Monitor({ upstream: fakeUpstream() });
  t.after(() => monitor.stop());
  monitor.stopped = false;
  monitor.tokens = ['1001'];
  const prices = [];
  let publications = 0;
  monitor.on('quotes', () => prices.push(monitor.snapshot().books['1001'].bids[0]?.size));
  monitor.on('state', () => publications++);
  monitor.applyMessage({ event_type: 'book', ...snapshot('1001', 1000) });
  for (const [timestamp, size] of [[1001, '7'], [1002, '10']]) {
    monitor.applyMessage({ event_type: 'price_change', timestamp: String(timestamp), price_changes: [
      { asset_id: '1001', side: 'BUY', price: '0.5', size },
    ] });
  }
  assert.deepEqual(prices, [10, 7, 10], 'A → B → A must not be lost to UI batching');
  t.mock.timers.tick(99);
  assert.equal(publications, 0);
  t.mock.timers.tick(1);
  assert.equal(publications, 1);
});
