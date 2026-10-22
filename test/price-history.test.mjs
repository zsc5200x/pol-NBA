import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Monitor } from '../src/monitor.mjs';
import { PriceHistory } from '../src/price-history.mjs';
import { CrownMonitor } from '../src/crown/monitor.mjs';
import { CrownStore } from '../src/crown/store.mjs';

const now = () => new Date().toISOString();
const rawBook = (tokenId, ask = '0.6', timestamp = 1, bid = '0.5') => ({
  event_type: 'book', asset_id: tokenId, timestamp: String(timestamp),
  asks: [{ price: ask, size: '20' }], bids: [{ price: bid, size: '10' }],
});
function setup(t, { filename = ':memory:', crown = false, empty = false } = {}) {
  const monitor = new Monitor(); monitor.stopped = false;
  const event = { id: 'event', title: 'Lakers vs. Warriors', startTime: '2026-10-24T00:00:00.000Z', markets: [
    { id: 'spread', type: 'spreads', question: 'Spread: Lakers (-3.5)', outcomes: [{ name: 'Lakers', tokenId: 'l' }, { name: 'Warriors', tokenId: 'w' }] },
    { id: 'spread-other', type: 'spreads', question: 'Spread: Lakers (-4.5)', outcomes: [{ name: 'Lakers', tokenId: 'l2' }, { name: 'Warriors', tokenId: 'w2' }] },
    { id: 'total', type: 'totals', question: 'Lakers vs. Warriors: O/U 235.5', outcomes: [{ name: 'Over', tokenId: 'o' }, { name: 'Under', tokenId: 'u' }] },
    { id: 'winner', type: 'moneyline', question: 'Lakers vs. Warriors', outcomes: [{ name: 'Lakers', tokenId: 'ml' }, { name: 'Warriors', tokenId: 'mw' }] },
  ] };
  monitor.state.events = [event];
  monitor.tokens = event.markets.flatMap(m => m.outcomes.map(o => o.tokenId));
  if (!empty) for (const tokenId of monitor.tokens) monitor.applyMessage(rawBook(tokenId));
  let crownMonitor;
  if (crown) {
    const store = new CrownStore(); crownMonitor = new CrownMonitor({ store });
    const match = { id: 'c1', home: '金州勇士', away: '洛杉矶湖人', startTime: event.startTime, sources: ['today'], checkedAt: now() };
    store.upsertMatch(match);
    crownMonitor.state.activeIds = ['c1']; crownMonitor.state.status = 'running';
    const markets = [
      { key: 'c1:spreads:full:3.5', matchId: 'c1', type: 'spreads', line: 3.5, status: 'open', parseStatus: 'parsed', checkedAt: now(), sides: [
        { direction: 'home', rawOdds: '0.950', decimalOdds: 1.95, oddsFormat: 'hongkong' },
        { direction: 'away', rawOdds: '0.900', decimalOdds: 1.9, oddsFormat: 'hongkong' },
      ] },
      { key: 'c1:totals:full:235.5', matchId: 'c1', type: 'totals', line: 235.5, status: 'open', parseStatus: 'parsed', checkedAt: now(), sides: [
        { direction: 'over', rawOdds: '0.88', decimalOdds: 1.88, oddsFormat: 'hongkong' },
        { direction: 'under', rawOdds: '0.99', decimalOdds: 1.99, oddsFormat: 'hongkong' },
      ] },
    ];
    for (const market of markets) store.saveMarket(market);
    crownMonitor.lastDetailState.set('c1', { healthy: true, marketKeys: new Set(markets.map(m => m.key)) });
  }
  const history = new PriceHistory({ filename, monitor, crown: crownMonitor });
  t.after(async () => { history.close(); monitor.stop(); await crownMonitor?.stop(); });
  return { monitor, crown: crownMonitor, history, event };
}

test('baseline records only spread/total lines, persists labels and both top prices, with numeric deduplication', t => {
  const { monitor, history } = setup(t);
  const initial = history.history({});
  assert.equal(initial.records.length, 3);
  assert.ok(initial.records.every(record => record.kind === 'baseline' && record.type !== 'moneyline'));
  const spread = initial.records.find(record => record.marketId === 'spread');
  assert.equal(spread.line, -3.5); assert.match(spread.marketLabel, /湖人/);
  assert.equal(spread.sides[0].price, 0.6); assert.equal(spread.sides[0].bid, 0.5); assert.equal(spread.sides[0].delta, null);
  monitor.applyMessage(rawBook('l', '0.6000', 2, '0.5000'));
  assert.equal(history.history({}).records.length, 3);
  assert.equal(history.history({ marketId: 'winner' }).records.length, 0);
});

test('different accepted WS messages preserve A→B→A before the UI debounce', t => {
  const { monitor, history } = setup(t);
  monitor.applyMessage({ event_type: 'price_change', timestamp: '2', price_changes: [
    { asset_id: 'l', side: 'SELL', price: '0.55', size: '10' },
  ] });
  monitor.applyMessage({ event_type: 'price_change', timestamp: '3', price_changes: [
    { asset_id: 'l', side: 'SELL', price: '0.55', size: '0' },
  ] });
  const records = history.history({ marketId: 'spread' }).records;
  assert.deepEqual(records.map(r => r.sides[0].price), [0.6, 0.55, 0.6]);
  assert.deepEqual(records.map(r => r.sides[0].delta), [0.05, -0.05, null]);
  assert.equal(history.history({ marketId: 'spread-other' }).records.length, 1);
  monitor.applyMessage(rawBook('l', '0.4', 1));
  assert.equal(history.history({ marketId: 'spread' }).records.length, 3);
});

test('one WS depth message applies atomically without recording a temporary next-best ask', t => {
  const { monitor, history } = setup(t);
  monitor.applyMessage({ ...rawBook('l', '0.5', 2), asks: [{ price: '0.5', size: '10' }, { price: '0.6', size: '10' }] });
  const before = history.history({ marketId: 'spread' }).records.length;
  monitor.applyMessage({ event_type: 'price_change', timestamp: '3', price_changes: [
    { asset_id: 'l', side: 'SELL', price: '0.5', size: '0' },
    { asset_id: 'l', side: 'SELL', price: '0.51', size: '20' },
  ] });
  const records = history.history({ marketId: 'spread' }).records;
  assert.equal(records.length, before + 1);
  assert.equal(records[0].sides[0].price, 0.51);
  assert.equal(records[0].sides[0].previousPrice, 0.5);
  assert.equal(records[0].sides[0].delta, 0.01);
});

test('size-only updates and heartbeat do not record; bid movement is explicit even when ask is unchanged', t => {
  const { monitor, history } = setup(t);
  monitor.applyMessage({ event_type: 'price_change', timestamp: '2', price_changes: [{ asset_id: 'l', side: 'SELL', price: '0.6', size: '999' }] });
  monitor.state.stream.connected = true; monitor.verifyStream();
  assert.equal(history.history({ marketId: 'spread' }).records.length, 1);
  monitor.applyMessage({ event_type: 'price_change', timestamp: '3', price_changes: [{ asset_id: 'l', side: 'BUY', price: '0.51', size: '10' }] });
  const latest = history.history({ marketId: 'spread' }).records[0];
  assert.equal(latest.sides[0].price, 0.6); assert.equal(latest.sides[0].delta, 0);
  assert.equal(latest.sides[0].previousBid, 0.5); assert.equal(latest.sides[0].bidDelta, 0.01);
});

test('failed, empty, stale and recovered quotes use null instead of zero and do not invent cross-gap deltas', t => {
  const { monitor, history } = setup(t);
  monitor.markBookError('l', 'offline'); monitor.markBookError('l', 'still offline');
  let records = history.history({ marketId: 'spread' }).records;
  assert.equal(records.length, 2); assert.equal(records[0].kind, 'unavailable');
  assert.equal(records[0].sides[0].price, null); assert.equal(records[0].sides[0].previousPrice, 0.6); assert.equal(records[0].sides[0].delta, null);
  monitor.applyMessage(rawBook('l', '0.7', 3));
  records = history.history({ marketId: 'spread' }).records;
  assert.equal(records[0].kind, 'recovered'); assert.equal(records[0].sides[0].delta, null);
  monitor.state.books.l.verifiedAt = '2000-01-01T00:00:00.000Z'; history.capturePol();
  assert.equal(history.history({ marketId: 'spread' }).records[0].kind, 'unavailable');
  monitor.applyMessage({ ...rawBook('l', '0.8', 4), asks: [] });
  assert.equal(history.history({ marketId: 'spread' }).records[0].sides[0].price, null);
});

test('REST quotes are recorded before publication while unchanged resyncs are deduplicated', async t => {
  const { monitor, history } = setup(t);
  monitor.upstream = { books: async ids => ids.map(id => rawBook(id, id === 'l' ? '0.65' : '0.6', 100)) };
  await monitor.refreshBooks();
  assert.equal(history.history({ marketId: 'spread' }).records[0].sides[0].price, 0.65);
  await monitor.refreshBooks();
  assert.equal(history.history({ marketId: 'spread' }).records.length, 2);
});

test('Crown quotes match exact line and Pol outcome order, persist independently of Pol availability', t => {
  const { monitor, crown, history } = setup(t, { crown: true });
  let records = history.history({ source: 'crown', marketId: 'spread' }).records;
  assert.equal(records.length, 1); assert.deepEqual(records[0].sides.map(s => s.price), [0.9, 0.95]);
  assert.deepEqual(records[0].sides.map(s => s.tokenId), ['l', 'w']);
  assert.equal(records[0].line, -3.5); assert.equal(records[0].crownLine, 3.5);
  assert.equal(history.history({ source: 'crown', marketId: 'spread-other' }).records.length, 0);
  const market = crown.store.markets('c1').find(m => m.type === 'spreads');
  market.sides[1].rawOdds = '0.90'; crown.store.saveMarket(market); crown.emit('quotes', {});
  assert.equal(history.history({ source: 'crown', marketId: 'spread' }).records.length, 1);
  monitor.markBookError('l', 'offline'); monitor.markBookError('w', 'offline');
  market.sides[1].rawOdds = '0.92'; market.sides[1].decimalOdds = 1.92; market.checkedAt = now();
  crown.store.saveMarket(market); crown.emit('quotes', {});
  records = history.history({ source: 'crown', marketId: 'spread' }).records;
  assert.equal(records[0].kind, 'change'); assert.equal(records[0].sides[0].delta, 0.02);
  crown.lastDetailState.get('c1').healthy = false; crown.emit('quotes', {});
  assert.equal(history.history({ source: 'crown', marketId: 'spread' }).records[0].kind, 'unavailable');
  crown.lastDetailState.get('c1').healthy = true; crown.emit('quotes', {});
  const recovery = history.history({ source: 'crown', marketId: 'spread' }).records[0];
  assert.equal(recovery.kind, 'recovered'); assert.equal(recovery.sides[0].delta, null);
});

test('newly missing Crown lines become unavailable once, invalid odds never become zero-price changes', t => {
  const { crown, history } = setup(t, { crown: true });
  const market = crown.store.markets('c1').find(m => m.type === 'spreads');
  market.sides[0].rawOdds = '0'; market.sides[0].decimalOdds = null; market.parseStatus = 'incomplete_odds';
  crown.store.saveMarket(market); crown.emit('quotes', {});
  assert.equal(history.history({ source: 'crown', marketId: 'spread' }).records[0].kind, 'unavailable');
  crown.lastDetailState.get('c1').marketKeys.delete(market.key); crown.emit('quotes', {}); crown.emit('quotes', {});
  assert.equal(history.history({ source: 'crown', marketId: 'spread' }).records.length, 2);
});

test('unobserved markets do not create unavailable baselines, and removed markets retain their history', t => {
  const { monitor, history } = setup(t, { empty: true });
  monitor.markBookError('l', 'not yet received'); monitor.markBookError('l', 'not yet received');
  assert.equal(history.history({}).records.length, 0);
  monitor.applyMessage(rawBook('l')); monitor.applyMessage(rawBook('w'));
  monitor.state.events = []; monitor.emit('markets', []);
  const records = history.history({ eventId: 'event', marketId: 'spread' }).records;
  assert.equal(records[0].kind, 'unavailable'); assert.match(records[0].eventTitle, /湖人/);
  monitor.emit('markets', []); assert.equal(history.history({ marketId: 'spread' }).records.length, records.length);
});

test('SQLite history survives restarts, uses fresh baselines, and source pagination never loses Crown rows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'price-history-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, 'history.sqlite');
  const first = setup(t, { filename, crown: true });
  for (let n = 2; n < 7; n++) first.monitor.applyMessage(rawBook('l', String(0.6 + n / 100), n));
  const firstSince = first.history.history({}).recordingSince;
  const a = first.history.history({ source: 'pol', marketId: 'spread', limit: 2 });
  const b = first.history.history({ source: 'pol', marketId: 'spread', limit: 2, before: a.nextBefore });
  assert.equal(a.hasMore, true); assert.ok(a.records[1].id > b.records[0].id);
  assert.equal(first.history.history({ source: 'crown', marketId: 'spread' }).records.length, 1);
  first.history.close();
  const second = new PriceHistory({ filename, monitor: first.monitor, crown: first.crown }); t.after(() => second.close());
  const result = second.history({ source: 'pol', marketId: 'spread' });
  assert.equal(result.recordingSince, firstSince); assert.equal(result.records.length, 7);
  assert.equal(result.records[0].kind, 'baseline'); assert.equal(result.records[0].sides[0].previousPrice, null);
  assert.equal(result.records[0].sides[0].delta, null);
});

test('storage failures do not escape quote listeners and are visible until successful retry', t => {
  const { monitor, history } = setup(t); history.flush();
  const original = history.insert;
  history.insert = { run() { throw new Error('synthetic disk error'); } };
  assert.doesNotThrow(() => monitor.applyMessage(rawBook('l', '0.7', 3)));
  const failed = history.history({ marketId: 'spread' });
  assert.equal(failed.status, 'error'); assert.match(failed.error, /暂时无法保存/);
  assert.equal(failed.records[0].sides[0].price, 0.6);
  history.insert = original;
  const recovered = history.history({ marketId: 'spread' });
  assert.equal(recovered.status, 'recording'); assert.equal(recovered.records[0].sides[0].price, 0.7);
});
