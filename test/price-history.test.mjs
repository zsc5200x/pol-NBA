import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
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

test('baseline records only spread/total ask prices, with numeric ask deduplication', t => {
  const { monitor, history } = setup(t);
  const initial = history.history({});
  assert.equal(initial.records.length, 3);
  assert.ok(initial.records.every(record => record.kind === 'baseline' && record.type !== 'moneyline'));
  const spread = initial.records.find(record => record.marketId === 'spread');
  assert.equal(spread.line, -3.5); assert.match(spread.marketLabel, /湖人/);
  assert.equal(spread.sides[0].price, 0.6); assert.equal(spread.sides[0].delta, null);
  assert.equal('bid' in spread.sides[0], false);
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

test('size-only updates, heartbeat, and bid-only movement do not add ask history', t => {
  const { monitor, history } = setup(t);
  monitor.applyMessage({ event_type: 'price_change', timestamp: '2', price_changes: [{ asset_id: 'l', side: 'SELL', price: '0.6', size: '999' }] });
  monitor.state.stream.connected = true; monitor.verifyStream();
  assert.equal(history.history({ marketId: 'spread' }).records.length, 1);
  monitor.applyMessage({ event_type: 'price_change', timestamp: '3', price_changes: [{ asset_id: 'l', side: 'BUY', price: '0.51', size: '10' }] });
  const latest = history.history({ marketId: 'spread' }).records[0];
  assert.equal(latest.sides[0].price, 0.6); assert.equal(latest.sides[0].delta, null);
  assert.equal('bid' in latest.sides[0], false); assert.equal('bidDelta' in latest.sides[0], false);
});

test('failed, empty and stale quotes add no row; changed recovery compares to last valid ask', t => {
  const { monitor, history } = setup(t);
  monitor.markBookError('l', 'offline'); monitor.markBookError('l', 'still offline');
  let records = history.history({ marketId: 'spread' }).records;
  assert.equal(records.length, 1); assert.equal(records[0].kind, 'baseline');
  monitor.applyMessage(rawBook('l', '0.7', 3));
  records = history.history({ marketId: 'spread' }).records;
  assert.equal(records[0].kind, 'change'); assert.equal(records[0].sides[0].delta, 0.1);
  monitor.markBookError('l', 'offline again');
  const countAfterChange = history.history({ marketId: 'spread' }).records.length;
  monitor.applyMessage(rawBook('l', '0.7', 4));
  assert.equal(history.history({ marketId: 'spread' }).records.length, countAfterChange);
  monitor.state.books.l.verifiedAt = '2000-01-01T00:00:00.000Z'; history.capturePol();
  assert.equal(history.history({ marketId: 'spread' }).records.length, countAfterChange);
  monitor.applyMessage({ ...rawBook('l', '0.8', 4), asks: [] });
  assert.equal(history.history({ marketId: 'spread' }).records.length, countAfterChange);
  monitor.applyMessage(rawBook('l', '0.8', 5));
  records = history.history({ marketId: 'spread' }).records;
  assert.equal(records[0].sides[0].previousPrice, 0.7);
  assert.equal(records[0].sides[0].delta, 0.1);
});

test('a changed ask can be recorded with the other temporarily unavailable side kept null', t => {
  const { monitor, history } = setup(t);
  monitor.markBookError('w', 'briefly unavailable');
  assert.equal(history.history({ marketId: 'spread' }).records.length, 1);
  monitor.applyMessage(rawBook('l', '0.61', 2));
  const latest = history.history({ marketId: 'spread' }).records[0];
  assert.equal(latest.sides[0].price, 0.61); assert.equal(latest.sides[0].previousPrice, 0.6); assert.equal(latest.sides[0].delta, 0.01);
  assert.equal(latest.sides[1].price, null); assert.equal(latest.sides[1].previousPrice, 0.6); assert.equal(latest.sides[1].delta, null);
});

test('REST quotes are recorded before publication while unchanged resyncs are deduplicated', async t => {
  const { monitor, history } = setup(t);
  monitor.upstream = { books: async ids => ids.map(id => rawBook(id, id === 'l' ? '0.65' : '0.6', 100)) };
  await monitor.refreshBooks();
  assert.equal(history.history({ marketId: 'spread' }).records[0].sides[0].price, 0.65);
  await monitor.refreshBooks();
  assert.equal(history.history({ marketId: 'spread' }).records.length, 2);
});

test('Crown records only valid initial odds and actual changes, preserving the last valid comparison through outages', t => {
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
  crown.lastDetailState.get('c1').healthy = false; crown.emit('quotes', {});
  assert.equal(history.history({ source: 'crown', marketId: 'spread' }).records.length, 1);
  crown.lastDetailState.get('c1').healthy = true;
  crown.emit('quotes', {}); // same-price recovery is not a new record
  assert.equal(history.history({ source: 'crown', marketId: 'spread' }).records.length, 1);
  market.sides[1].rawOdds = '0.92'; market.sides[1].decimalOdds = 1.92; market.checkedAt = now();
  crown.store.saveMarket(market); crown.emit('quotes', {});
  records = history.history({ source: 'crown', marketId: 'spread' }).records;
  assert.equal(records[0].kind, 'change'); assert.equal(records[0].sides[0].delta, 0.02);
  assert.equal(records[0].sides[0].previousPrice, 0.9);
  // A subsequent invalid quote doesn't create an outage row or reset the baseline.
  market.sides[1].rawOdds = '0'; market.sides[1].decimalOdds = null; market.parseStatus = 'incomplete_odds';
  market.sides[0].rawOdds = '0.96'; market.sides[0].decimalOdds = 1.96; market.checkedAt = now();
  crown.store.saveMarket(market); crown.emit('quotes', {});
  records = history.history({ source: 'crown', marketId: 'spread' }).records;
  assert.equal(records[0].sides[1].price, 0.96); assert.equal(records[0].sides[1].previousPrice, 0.95);
  assert.equal(records[0].sides[0].price, null, 'partial valid odds keep the unavailable side empty');
  assert.equal(records[0].sides[1].delta, 0.01);
});

test('Crown skips empty/missing lines and treats odds-format conversion as incomparable', t => {
  const { crown, history } = setup(t, { crown: true });
  const market = crown.store.markets('c1').find(m => m.type === 'spreads');
  market.sides[0].rawOdds = '0'; market.sides[0].decimalOdds = null; market.parseStatus = 'incomplete_odds';
  crown.store.saveMarket(market); crown.emit('quotes', {});
  assert.equal(history.history({ source: 'crown', marketId: 'spread' }).records.length, 1);
  market.sides[0].rawOdds = '1.96'; market.sides[0].decimalOdds = 1.96; market.sides[0].oddsFormat = 'decimal';
  market.checkedAt = now(); crown.store.saveMarket(market); crown.emit('quotes', {});
  const converted = history.history({ source: 'crown', marketId: 'spread' }).records[0];
  assert.equal(converted.sides[1].price, 1.96); assert.equal(converted.sides[1].previousPrice, 0.95);
  assert.equal(converted.sides[1].delta, null, 'different odds formats must not produce a false movement');
  assert.equal(converted.kind, 'change');
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
  assert.equal(records.length, 2); assert.ok(records.every(record => ['baseline', 'change'].includes(record.kind))); assert.match(records[0].eventTitle, /湖人/);
  monitor.emit('markets', []); assert.equal(history.history({ marketId: 'spread' }).records.length, records.length);
});

test('SQLite history survives restarts without adding a same-price baseline and keeps source pagination', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'price-history-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, 'history.sqlite');
  const first = setup(t, { filename, crown: true });
  for (let n = 2; n < 7; n++) first.monitor.applyMessage(rawBook('l', String(0.6 + n / 100), n));
  const firstSince = first.history.history({}).recordingSince;
  const a = first.history.history({ source: 'pol', marketId: 'spread', limit: 2 });
  const b = first.history.history({ source: 'pol', marketId: 'spread', limit: 2, before: a.nextBefore });
  assert.equal(a.hasMore, true); assert.ok(a.records[1].id > b.records[0].id);
  assert.equal(first.history.history({ source: 'crown', marketId: 'spread' }).records.length, 1);
  const merged = first.history.history({ marketId: 'spread' });
  assert.equal(merged.records.filter(row => row.source === 'crown').length, 1, 'unfiltered query uses canonical Crown history');
  const mergedPages = [];
  let mergedBefore;
  do {
    const page = first.history.history({ marketId: 'spread', limit: 2, ...(mergedBefore ? { before: mergedBefore } : {}) });
    mergedPages.push(...page.records);
    mergedBefore = page.nextBefore;
    if (!page.hasMore) break;
  } while (true);
  assert.equal(mergedPages.length, 7, 'source-less pagination combines Pol and normalized Crown rows without gaps');
  assert.equal(mergedPages.filter(row => row.source === 'crown').length, 1);
  first.history.close();
  const second = new PriceHistory({ filename, monitor: first.monitor, crown: first.crown }); t.after(() => second.close());
  assert.equal(second.history({ source: 'crown', marketId: 'spread' }).records.length, 1, 'restart does not write a duplicate valid baseline');
  const result = second.history({ source: 'pol', marketId: 'spread' });
  assert.equal(result.recordingSince, firstSince); assert.equal(result.records.length, 6);
  assert.equal(result.records[0].kind, 'change'); assert.equal(result.records[0].sides[0].previousPrice, 0.65);
  assert.equal(result.records[0].sides[0].delta, 0.01);
});

test('legacy Crown history is normalized without deleting raw rows and paginates only valid changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'price-history-crown-legacy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, 'history.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE price_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_id TEXT NOT NULL,
    market_id TEXT NOT NULL, type TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL
  ); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('recordingSince', '2026-10-01T00:00:00.000Z');
  const insert = db.prepare('INSERT INTO price_records(source,event_id,market_id,type,observed_at,payload) VALUES(?,?,?,?,?,?)');
  const add = (second, sides, kind = 'change') => insert.run('crown', 'crown-event', 'crown-market', 'spreads', `2026-10-01T00:00:0${second}.000Z`, JSON.stringify({
    source: 'crown', eventId: 'crown-event', marketId: 'crown-market', type: 'spreads', observedAt: `2026-10-01T00:00:0${second}.000Z`, kind,
    sides,
  }));
  const side = (tokenId, price, decimalOdds, oddsFormat = 'hongkong') => ({ tokenId, label: tokenId, price, decimalOdds, oddsFormat });
  add(1, [side('home', 0.95, 1.95), side('away', 0.9, 1.9)], 'baseline');
  add(2, [side('home', null, null), side('away', null, null)], 'unavailable');
  add(3, [side('home', 0.95, 1.95), side('away', 0.9, 1.9)], 'recovered');
  add(4, [side('home', 0.96, 1.96), side('away', null, null)]);
  add(5, [side('home', 0.96, 1.96), side('away', 0.9, 1.9)], 'recovered');
  add(6, [side('home', 1.96, 1.96, 'decimal'), side('away', 0.9, 1.9)]);
  db.close();

  const monitor = new Monitor();
  const history = new PriceHistory({ filename, monitor }); t.after(() => history.close());
  const latest = history.history({ source: 'crown', eventId: 'crown-event', marketId: 'crown-market', limit: 1 });
  assert.equal(latest.records[0].id, 6); assert.equal(latest.hasMore, true);
  assert.equal(latest.records[0].sides[0].delta, null, 'odds format conversion has no comparable numeric delta');
  const middle = history.history({ source: 'crown', eventId: 'crown-event', marketId: 'crown-market', limit: 1, before: latest.nextBefore });
  assert.equal(middle.records[0].id, 4); assert.equal(middle.records[0].sides[1].price, null);
  const baseline = history.history({ source: 'crown', eventId: 'crown-event', marketId: 'crown-market', limit: 1, before: middle.nextBefore });
  assert.equal(baseline.records[0].id, 1); assert.equal(baseline.records[0].kind, 'baseline');
  assert.equal(history.history({ source: 'crown', eventId: 'crown-event', marketId: 'crown-market' }).records.length, 3);
  assert.equal(history.history({ eventId: 'crown-event', marketId: 'crown-market' }).records.length, 3, 'unfiltered source query must use normalized Crown index too');
  assert.equal(history.db.prepare("SELECT COUNT(*) AS count FROM price_records WHERE source='crown'").get().count, 6, 'raw rows are retained');
  history.close();

  const restarted = new PriceHistory({ filename, monitor }); t.after(() => restarted.close());
  assert.equal(restarted.history({ source: 'crown', eventId: 'crown-event', marketId: 'crown-market' }).records.length, 3);
  assert.equal(restarted.history({ eventId: 'crown-event', marketId: 'crown-market' }).records.length, 3);
});

test('legacy Pol rows are normalized by last valid ask, filter bid-only/outage duplicates, and paginate canonically', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'price-history-legacy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, 'history.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE price_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_id TEXT NOT NULL,
    market_id TEXT NOT NULL, type TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL
  ); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('recordingSince', '2026-10-01T00:00:00.000Z');
  const insert = db.prepare('INSERT INTO price_records(source,event_id,market_id,type,observed_at,payload) VALUES(?,?,?,?,?,?)');
  const add = (observedAt, sides) => insert.run('pol', 'legacy-event', 'legacy-market', 'spreads', observedAt, JSON.stringify({
    source: 'pol', eventId: 'legacy-event', marketId: 'legacy-market', type: 'spreads', observedAt,
    eventTitle: 'Legacy match', marketLabel: 'Spread', sides,
  }));
  const side = (tokenId, price, bid = 0.49) => ({ tokenId, label: tokenId, price, bid, sourceAt: null });
  add('2026-10-01T00:00:01.000Z', [side('home', 0.5), side('away', 0.5)]); // initial valid ask baseline
  add('2026-10-01T00:00:02.000Z', [side('home', 0.5, 0.51), side('away', 0.5, 0.48)]); // bid-only change
  add('2026-10-01T00:00:03.000Z', [side('home', null), side('away', null)]); // old unavailable row
  add('2026-10-01T00:00:04.000Z', [side('home', 0.5), side('away', 0.5)]); // same-price recovery
  add('2026-10-01T00:00:05.000Z', [side('home', 0.51), side('away', null)]); // one-sided change
  add('2026-10-01T00:00:06.000Z', [side('home', 0.51), side('away', 0.5)]); // unchanged recovery on the other side
  add('2026-10-01T00:00:07.000Z', [side('home', 0.5), side('away', 0.52)]); // A -> B -> A
  db.close();

  const history = new PriceHistory({ filename, monitor: new Monitor() }); t.after(() => history.close());
  const latest = history.history({ source: 'pol', eventId: 'legacy-event', marketId: 'legacy-market', limit: 1 });
  assert.equal(latest.records.length, 1); assert.equal(latest.records[0].id, 7); assert.equal(latest.hasMore, true);
  assert.deepEqual(latest.records[0].sides.map(item => [item.price, item.previousPrice, item.delta]), [[0.5, 0.51, -0.01], [0.52, 0.5, 0.02]]);
  const middle = history.history({ source: 'pol', eventId: 'legacy-event', marketId: 'legacy-market', limit: 1, before: latest.nextBefore });
  assert.equal(middle.records[0].id, 5); assert.equal(middle.records[0].sides[0].delta, 0.01);
  assert.equal(middle.records[0].sides[1].price, null); assert.equal(middle.records[0].sides[1].previousPrice, 0.5);
  const baseline = history.history({ source: 'pol', eventId: 'legacy-event', marketId: 'legacy-market', limit: 1, before: middle.nextBefore });
  assert.equal(baseline.records[0].id, 1); assert.equal(baseline.records[0].kind, 'baseline');
  assert.equal(baseline.records[0].sides[0].delta, null);
  assert.equal(history.history({ source: 'pol', eventId: 'legacy-event', marketId: 'legacy-market' }).records.length, 3);
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
