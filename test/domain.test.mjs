import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey, rangeKeys, price, normalizeLevels, normalizeBook,
  updateLevel, normalizeEvent, selectEvents, summarizeBook,
} from '../src/domain.mjs';

function event(overrides = {}) {
  return {
    id: 'nba-game-1', title: 'Boston Celtics vs. New York Knicks',
    slug: 'nba-bos-nyk-2026-10-22', startTime: '2026-10-22T00:00:00Z',
    markets: [{
      id: 'moneyline-1', question: 'Celtics vs. Knicks',
      sportsMarketType: 'moneyline', enableOrderBook: true,
      outcomes: ['Celtics', 'Knicks'], clobTokenIds: ['1001', '1002'],
      outcomePrices: ['0.56', '0.44'], acceptingOrders: true,
    }],
    ...overrides,
  };
}

test('calendar dates depend on the selected timezone, including Shanghai midnight', () => {
  const instant = new Date('2026-10-21T16:00:00Z');
  assert.equal(dayKey(instant, 'Asia/Shanghai'), '2026-10-22');
  assert.equal(dayKey(instant, 'America/New_York'), '2026-10-21');
  assert.equal(dayKey(new Date('2026-10-21T15:59:59Z'), 'Asia/Shanghai'), '2026-10-21');
});

test('three-day ranges include today and cross month/year boundaries correctly', () => {
  const now = new Date('2026-12-31T23:00:00Z');
  assert.deepEqual([...rangeKeys(now, 'upcoming', 'Asia/Shanghai')], ['2027-01-01', '2027-01-02', '2027-01-03']);
  assert.deepEqual([...rangeKeys(now, 'past', 'Asia/Shanghai')], ['2026-12-30', '2026-12-31', '2027-01-01']);
  assert.deepEqual([...rangeKeys(now, 'both', 'Asia/Shanghai')], ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
});

test('Eastern calendar windows stay three dates across spring and autumn DST changes', () => {
  assert.deepEqual([...rangeKeys(new Date('2026-03-08T06:59:00Z'), 'upcoming', 'America/New_York')], ['2026-03-08', '2026-03-09', '2026-03-10']);
  assert.deepEqual([...rangeKeys(new Date('2026-11-01T06:01:00Z'), 'past', 'America/New_York')], ['2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(dayKey(new Date('2026-03-08T04:59:59Z'), 'America/New_York'), '2026-03-07');
  assert.equal(dayKey(new Date('2026-03-08T05:00:00Z'), 'America/New_York'), '2026-03-08');
});

test('event selection uses local game date, retains boundaries and excludes adjacent dates', () => {
  const make = (id, startTime) => event({ id, startTime });
  const selected = selectEvents([
    make('before', '2026-10-21T15:59:59Z'),
    make('last', '2026-10-24T15:59:59Z'),
    make('first', '2026-10-21T16:00:00Z'),
    make('after', '2026-10-24T16:00:00Z'),
  ], { now: new Date('2026-10-22T05:00:00Z'), range: 'upcoming', timezone: 'Asia/Shanghai' });
  assert.deepEqual(selected.map(item => item.id), ['first', 'last']);
});

test('event selection deduplicates IDs and sorts by actual game start', () => {
  const a = event({ id: 'a', startTime: '2026-10-22T00:00:00Z' });
  const b = event({ id: 'b', startTime: '2026-10-22T01:00:00Z' });
  const selected = selectEvents([b, a, a], { now: new Date('2026-10-22T05:00:00Z') });
  assert.deepEqual(selected.map(item => item.id), ['a', 'b']);
});

test('Gamma JSON-string arrays and native arrays normalize to the same outcomes', () => {
  const native = event();
  const serialized = event({ markets: native.markets.map(market => ({
    ...market,
    outcomes: JSON.stringify(market.outcomes),
    clobTokenIds: JSON.stringify(market.clobTokenIds),
    outcomePrices: JSON.stringify(market.outcomePrices),
  })) });
  assert.deepEqual(normalizeEvent(serialized), normalizeEvent(native));
  assert.deepEqual(normalizeEvent(serialized).markets[0].outcomes, [
    { name: 'Celtics', tokenId: '1001', referencePrice: 0.56 },
    { name: 'Knicks', tokenId: '1002', referencePrice: 0.44 },
  ]);
});

test('v2 position IDs provide the order book identifiers when CTF token IDs are absent', () => {
  const market = event().markets[0];
  const normalized = normalizeEvent(event({ markets: [{
    ...market, clobTokenIds: '[]', positionIds: '["0xabc","0xdef"]',
  }] }));
  assert.ok(normalized);
  assert.deepEqual(normalized.markets[0].outcomes.map(outcome => outcome.tokenId), ['0xabc', '0xdef']);
  const withBoth = normalizeEvent(event({ markets: [{ ...market, positionIds: ['0xabc', '0xdef'] }] }));
  assert.deepEqual(withBoth.markets[0].outcomes.map(outcome => outcome.tokenId), ['1001', '1002']);
});

test('markets with mismatched or malformed outcome/identifier arrays are rejected', () => {
  const market = event().markets[0];
  for (const override of [
    { clobTokenIds: ['1001'] },
    { clobTokenIds: ['', '1002'] },
    { clobTokenIds: [1001, 1002] },
    { outcomes: ['Celtics', '  '] },
    { outcomes: ['Celtics', null] },
    { outcomes: [] },
    { outcomes: '[broken' },
    { outcomes: '{"Celtics":true}' },
    { clobTokenIds: 'not JSON' },
  ]) {
    assert.equal(normalizeEvent(event({ markets: [{ ...market, ...override }] })), null);
  }
});

test('only main game winner, spread and total markets enter the monitor', () => {
  const market = event().markets[0];
  const normalized = normalizeEvent(event({ markets: [
    { ...market, id: 'winner', sportsMarketType: 'moneyline' },
    { ...market, id: 'spread', sportsMarketType: 'spreads' },
    { ...market, id: 'total', sportsMarketType: 'totals' },
    { ...market, id: 'player', sportsMarketType: 'player_points' },
    { ...market, id: 'half', sportsMarketType: 'first_half_moneyline' },
    { ...market, id: 'other', sportsMarketType: undefined },
  ] }));
  assert.deepEqual(normalized.markets.map(item => item.id), ['winner', 'spread', 'total']);
  assert.equal(normalizeEvent(event({ markets: [{ ...market, sportsMarketType: 'player_rebounds' }] })), null);
});

test('normalization uses game start fields, rejects invalid time, and never substitutes listing creation time', () => {
  const raw = event();
  const fallback = normalizeEvent({ ...raw, startTime: undefined, markets: [{ ...raw.markets[0], gameStartTime: '2026-10-23T01:30:00Z' }] });
  assert.equal(fallback.startTime, '2026-10-23T01:30:00.000Z');
  assert.equal(normalizeEvent({ ...raw, startTime: 'not a date' }), null);
  assert.equal(normalizeEvent({ ...raw, startTime: undefined, startDate: '2026-10-22T00:00:00Z' }), null);
});

test('finished or closed events are hidden even while their markets are still open', () => {
  for (const status of [{ closed: true }, { ended: true }]) {
    assert.equal(normalizeEvent(event(status)), null);
  }
});

test('closed markets are removed and an event with no remaining target markets is hidden', () => {
  const market = event().markets[0];
  const mixed = event({ markets: [
    { ...market, id: 'settled', closed: true },
    { ...market, id: 'open', closed: false },
  ] });
  assert.deepEqual(normalizeEvent(mixed).markets.map(m => m.id), ['open']);
  assert.equal(normalizeEvent(event({ markets: [{ ...market, closed: true }] })), null);
});

test('started games and temporarily paused markets remain visible without an explicit end status', () => {
  const raw = event({ live: true, ended: false, closed: false, endDate: '2026-10-22T00:00:00Z' });
  raw.markets[0].acceptingOrders = false;
  const selected = selectEvents([raw], { now: new Date('2026-10-22T02:00:00Z') });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].markets[0].acceptingOrders, false);
});

test('missing/invalid reference prices remain unknown instead of becoming a live zero', () => {
  for (const input of [null, undefined, '', 'NaN', 'Infinity', -0.1, 1.01]) assert.equal(price(input), null);
  assert.equal(price('0'), 0);
  assert.equal(price('1'), 1);
  const raw = event();
  raw.markets[0].outcomePrices = ['0.56'];
  assert.equal(normalizeEvent(raw).markets[0].outcomes[1].referencePrice, null);
});

test('order book normalization sorts best prices first and filters invalid or zero levels', () => {
  const levels = [
    { price: '0.5', size: '10' }, { price: '0.4', size: '5' },
    { price: '0.6', size: '12' }, { price: '0.5', size: '20' },
    { price: '-0.1', size: '10' }, { price: '1.1', size: '1' },
    { price: '0.7', size: '0' }, { price: '0.8', size: '-1' },
    { price: '0.9', size: 'NaN' }, { price: 'oops', size: '2' },
  ];
  assert.deepEqual(normalizeLevels(levels, 'bids'), [
    { price: 0.6, size: 12 }, { price: 0.5, size: 20 }, { price: 0.4, size: 5 },
  ]);
  assert.deepEqual(normalizeLevels(levels, 'asks').map(level => level.price), [0.4, 0.5, 0.6]);
  assert.deepEqual(normalizeLevels(undefined, 'bids'), []);
});

test('normalized snapshots preserve token identifiers and record successful receipt time', () => {
  const now = '2026-10-22T05:00:00.000Z';
  const book = normalizeBook({ asset_id: '1001', bids: [{ price: '0.55', size: '10' }], asks: [], timestamp: '1792645200000' }, now);
  assert.equal(book.tokenId, '1001');
  assert.equal(book.updatedAt, now);
  assert.equal(book.source, 'live');
  assert.equal(book.error, null);
  assert.equal(book.timestamp, 1792645200000);
  assert.deepEqual(book.bids, [{ price: 0.55, size: 10 }]);
});

test('incremental updates replace level size, delete zero size and preserve the other side', () => {
  const book = normalizeBook({ asset_id: '1001', bids: [{ price: '0.5', size: '10' }], asks: [{ price: '0.6', size: '15' }] });
  assert.equal(updateLevel(book, { side: 'BUY', price: '0.5', size: '7' }, '2026-10-22T05:00:01.000Z'), true);
  assert.equal(book.bids[0].size, 7, 'delta quantity replaces, rather than adds to, the level');
  assert.equal(updateLevel(book, { side: 'BUY', price: '0.55', size: '9' }), true);
  assert.deepEqual(book.bids.map(level => level.price), [0.55, 0.5]);
  assert.equal(updateLevel(book, { side: 'BUY', price: '0.55', size: '0' }), true);
  assert.deepEqual(book.bids, [{ price: 0.5, size: 7 }]);
  assert.deepEqual(book.asks, [{ price: 0.6, size: 15 }]);
  assert.equal(updateLevel(book, { side: 'SELL', price: '0.6', size: '0' }), true);
  assert.deepEqual(book.asks, []);
});

test('invalid deltas do not mutate the book or freshen its last successful update', () => {
  const book = normalizeBook({ token_id: '1001', bids: [], asks: [] }, '2026-10-22T05:00:00.000Z');
  const original = structuredClone(book);
  for (const change of [
    { side: 'BUY', price: '0.5', size: '-1' },
    { side: 'HOLD', price: '0.5', size: '1' },
    { side: 'SELL', price: '2', size: '1' },
    { side: 'BUY', price: '0.5', size: 'Infinity' },
  ]) assert.equal(updateLevel(book, change), false);
  assert.deepEqual(book, original);
});

test('spread uses the best executable quotes and stays unknown for one-sided books', () => {
  assert.deepEqual(summarizeBook(undefined), { bid: null, ask: null, spread: null });
  assert.deepEqual(summarizeBook({ bids: [{ price: 0.54 }], asks: [] }), { bid: 0.54, ask: null, spread: null });
  const result = summarizeBook({ bids: [{ price: 0.54 }], asks: [{ price: 0.56 }] });
  assert.equal(result.bid, 0.54);
  assert.equal(result.ask, 0.56);
  assert.ok(Math.abs(result.spread - 0.02) < 1e-12);
  assert.equal(summarizeBook({ bids: [{ price: 0.5 }], asks: [{ price: 0.5 }] }).spread, 0);
});
