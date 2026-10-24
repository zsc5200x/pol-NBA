import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HEDGE_SETTINGS, validateHedgeSettings, calculateHedge, rankHedgeOpportunities, bestProfitableHedgesByEvent } from '../public/hedge-calculator.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
const NOW = Date.parse('2026-10-23T00:00:00Z');
const timestamp = (offset = 0) => new Date(NOW + offset).toISOString();
const calculate = extra => calculateHedge({ ...DEFAULT_HEDGE_SETTINGS, polPrice: 0.5, crownOdds: 0.98, ...extra });

function fixture() {
  const sides = (directions, tokens, odds) => directions.map((direction, index) => ({ direction, polTokenId: tokens[index],
    rawOdds: String(odds[index]), decimalOdds: 1 + odds[index], oddsFormat: 'hongkong', comparisonStatus: 'comparable_quote' }));
  const spreadSides = sides(['home', 'away'], ['warriors', 'lakers'], [0.99, 0.87]);
  const totalSides = sides(['over', 'under'], ['over', 'under'], [0.85, 0.99]);
  const markets = [
    { id: 'spread', type: 'spreads', question: 'Spread: Lakers (-2.5)', acceptingOrders: true, closed: false,
      outcomes: [{ name: 'Lakers', tokenId: 'lakers' }, { name: 'Warriors', tokenId: 'warriors' }] },
    { id: 'total', type: 'totals', question: 'O/U 236.5', acceptingOrders: true, closed: false,
      outcomes: [{ name: 'Under', tokenId: 'under' }, { name: 'Over', tokenId: 'over' }] },
  ];
  const raw = [
    { key: 'crown:spread', type: 'spreads', line: 2.5, sides: spreadSides },
    { key: 'crown:total', type: 'totals', line: 236.5, sides: totalSides },
  ].map(market => ({ ...market, phase: 'full', status: 'open', parseStatus: 'parsed', checkedAt: timestamp() }));
  return { mode: 'live', status: 'live',
    events: [{ id: 'event', title: 'Lakers vs. Warriors', startTime: timestamp(60000), markets }],
    books: Object.fromEntries(['lakers', 'warriors', 'over', 'under'].map(token => [token, {
      source: 'live', verifiedAt: timestamp(), updatedAt: timestamp(), error: null, asks: [{ price: token === 'lakers' ? 0.52 : 0.49, size: 1 }], bids: [],
    }])),
    crown: { status: 'running', mappingVerified: true, matches: [{ id: 'crown', home: '金州勇士', away: '洛杉矶湖人', markets: raw,
      comparison: { status: 'matched', polEventId: 'event', homeId: 'gsw', awayId: 'lal', markets: raw.map((market, index) => ({
        crownKey: market.key, type: market.type, line: market.line, status: 'matched', polMarketId: index ? 'total' : 'spread', sides: structuredClone(market.sides),
      })) },
    }] },
  };
}
const rank = (state = fixture(), options) => rankHedgeOpportunities(state, DEFAULT_HEDGE_SETTINGS, { now: NOW, ...options });
const best = (state = fixture(), settings = DEFAULT_HEDGE_SETTINGS, options) => bestProfitableHedgesByEvent(state, settings, { now: NOW, ...options });

function setOdds(state, marketIndex, direction, odds) {
  const match = state.crown.matches[0];
  for (const market of [match.markets[marketIndex], match.comparison.markets[marketIndex]]) {
    Object.assign(market.sides.find(side => side.direction === direction), { rawOdds: String(odds), decimalOdds: 1 + odds });
  }
}

function uniformQuotes(state, price, odds) {
  for (const book of Object.values(state.books)) book.asks[0].price = price;
  state.crown.matches[0].markets.forEach((market, index) => {
    for (const side of market.sides) setOdds(state, index, side.direction, odds);
  });
  return state;
}

test('rebate follows user-confirmed effective stake at both 0.98 and 1.03 without rounding or caps', () => {
  const below = calculate();
  close(below.effectiveStakeRmb, 98);
  close(below.rebateRmb, 3.038);
  const above = calculate({ crownOdds: 1.03 });
  close(above.effectiveStakeRmb, 103);
  close(above.rebateRmb, 3.193);
  close(above.polWinProfitRmb - above.profitBeforeRebateRmb, 3.193);
  close(above.crownWinProfitRmb - above.profitBeforeRebateRmb, 3.193);
});

test('equal gross payouts convert Pol USD to RMB and add the same rebate to both results', () => {
  const result = calculate({ exchangeRate: 7.2, crownStake: 1000, polPrice: 0.47 });
  close(result.polShares, 1980 / 7.2);
  close(result.polCostUsd, (1980 / 7.2) * 0.47);
  close(result.polCostRmb, 930.6);
  close(result.totalCostRmb, 1930.6);
  close(result.polWinProfitRmb, 79.78);
  close(result.crownWinProfitRmb, 79.78);
  close(result.profitRmb, 79.78);
  close(result.roiPercent, 79.78 / 1930.6 * 100);
  const otherFx = calculate({ exchangeRate: 8, crownStake: 1000, polPrice: 0.47 });
  close(otherFx.profitRmb, result.profitRmb);
  assert.notEqual(otherFx.polShares, result.polShares);
});

test('3.1 means 3.1 percent, and rebate may make a losing quote positive', () => {
  const without = calculate({ rebatePercent: 0 });
  close(without.profitRmb, -1);
  assert.ok(without.roiPercent < 0);
  const withRebate = calculate();
  close(withRebate.profitRmb, 2.038);
  assert.ok(withRebate.roiPercent > 0);
  close(withRebate.rebateRmb / withRebate.effectiveStakeRmb, 0.031);
});

test('settings accept finite numeric strings and reject empty, invalid or out-of-bounds input', () => {
  assert.deepEqual(validateHedgeSettings({ crownStake: '100', exchangeRate: '7.2', rebatePercent: '3.1' }), {
    settings: { crownStake: 100, exchangeRate: 7.2, rebatePercent: 3.1 }, errors: {},
  });
  for (const [key, values] of Object.entries({ crownStake: ['', null, false, [], 0, -1, 1e10, Infinity, 'NaN'],
    exchangeRate: [' ', undefined, 0, -1, 1001], rebatePercent: ['', null, -0.1, 101, Infinity] })) {
    for (const value of values) {
      const result = validateHedgeSettings({ ...DEFAULT_HEDGE_SETTINGS, [key]: value });
      assert.equal(result.settings, null, `${key} = ${String(value)}`);
      assert.ok(result.errors[key]);
      assert.equal(calculate({ [key]: value }), null);
    }
  }
  for (const value of ['', null, false, 0, -1, 1, Infinity]) assert.equal(calculate({ polPrice: value }), null);
  for (const value of ['', null, false, 0, -1, Infinity]) assert.equal(calculate({ crownOdds: value }), null);
  assert.equal(calculate({ crownOdds: Number.MAX_VALUE }), null);
});

test('rank pairs actual opposite directions even when home/away and outcome arrays are reversed', () => {
  const result = rank();
  assert.equal(result.eligibleMarketCount, 2);
  assert.equal(result.excludedMarketCount, 0);
  assert.equal(result.opportunities.length, 4);
  const lakers = result.opportunities.find(item => item.polTokenId === 'lakers');
  assert.equal(lakers.polLabel, '洛杉矶湖人（-2.5）');
  assert.equal(lakers.crownLabel, '金州勇士（+2.5）');
  close(lakers.crownOdds, 0.99);
  close(lakers.polPrice, 0.52);
  close(result.opportunities.find(item => item.polTokenId === 'warriors').crownOdds, 0.87);
  const over = result.opportunities.find(item => item.polTokenId === 'over');
  assert.equal(over.polLabel, '大于 236.5');
  assert.equal(over.crownLabel, '小于 236.5');
  close(over.crownOdds, 0.99);
  assert.ok(result.opportunities.every((item, index, all) => !index || all[index - 1].roiPercent >= item.roiPercent));
  assert.equal(lakers.eventTitle, '洛杉矶湖人 对阵 金州勇士');
  assert.ok(lakers.polShares > 1, 'theory must not limit quantities to the single share in best ask');
});

test('ranking is pure, deterministic, and scopes to a selected event', () => {
  const state = fixture(), before = structuredClone(state), settings = { ...DEFAULT_HEDGE_SETTINGS };
  assert.deepEqual(rank(state), rank(state));
  assert.deepEqual(state, before);
  assert.deepEqual(settings, DEFAULT_HEDGE_SETTINGS);
  assert.equal(rank(state, { eventId: 'missing' }).opportunities.length, 0);
  assert.equal(rank(state, { eventId: 'event' }).opportunities.length, 4);
});

test('invalid connection and session states disable all candidates without using saved data', () => {
  for (const mutate of [state => { state.mode = 'demo'; }, state => { state.status = 'blocked'; },
    state => { state.crown.status = 'blocked'; }, state => { state.crown.mappingVerified = false; },
    state => { state.events[0].ended = true; }, state => { delete state.crown; }]) {
    const state = fixture(); mutate(state);
    assert.equal(rank(state).opportunities.length, 0);
    assert.equal(rank(state).excludedMarketCount, 2);
  }
  assert.equal(rank(fixture(), { connected: false }).opportunities.length, 0);
});

test('books must be real, fresh, valid best asks; reference or comparison prices are never fallback prices', () => {
  for (const mutate of [book => { book.source = 'demo'; }, book => { book.error = 'failed'; },
    book => { book.verifiedAt = timestamp(-30001); }, book => { book.verifiedAt = timestamp(1); },
    book => { delete book.verifiedAt; }, book => { book.asks = []; }, book => { book.asks[0].size = 0; },
    book => { book.asks[0].price = 0; }, book => { book.asks[0].price = 1; }, book => { book.asks[0].price = ''; }]) {
    const state = fixture(); mutate(state.books.lakers);
    assert.equal(rank(state).opportunities.some(item => item.polTokenId === 'lakers'), false);
  }
  const boundary = fixture(); boundary.books.lakers.verifiedAt = timestamp(-30000);
  assert.equal(rank(boundary).opportunities.some(item => item.polTokenId === 'lakers'), true);
});

test('Crown full-game open parsed fresh raw market and matching odds format are mandatory', () => {
  for (const mutate of [market => { market.phase = 'half'; }, market => { delete market.phase; },
    market => { market.status = 'suspended'; }, market => { market.status = 'closed'; }, market => { market.parseStatus = 'conflict'; },
    market => { market.checkedAt = timestamp(-90001); }, market => { market.checkedAt = timestamp(1); },
    market => { market.line = -2.5; }]) {
    const state = fixture(); mutate(state.crown.matches[0].markets[0]);
    assert.equal(rank(state).opportunities.some(item => item.marketId === 'spread'), false);
  }
  for (const mutate of [side => { side.oddsFormat = 'decimal'; }, side => { side.rawOdds = '0'; },
    side => { side.decimalOdds = 2.3; }]) {
    const state = fixture(); mutate(state.crown.matches[0].markets[0].sides[0]);
    assert.equal(rank(state).opportunities.some(item => item.polTokenId === 'lakers'), false);
  }
  for (const status of ['stale', 'unavailable', 'outcome_unmatched']) {
    const state = fixture(); state.crown.matches[0].comparison.markets[0].sides[0].comparisonStatus = status;
    assert.equal(rank(state).opportunities.some(item => item.polTokenId === 'lakers'), false);
  }
});

test('closed, integer, mismatched and ambiguous market links are excluded', () => {
  for (const mutate of [state => { state.events[0].markets[0].acceptingOrders = false; },
    state => { state.events[0].markets[0].closed = true; },
    state => { state.events[0].markets[0].question = 'Spread: Lakers (-2)'; state.crown.matches[0].markets[0].line = 2; state.crown.matches[0].comparison.markets[0].line = 2; },
    state => { state.crown.matches[0].comparison.markets[0].status = 'ambiguous'; },
    state => { state.crown.matches[0].comparison.markets[0].polMarketId = 'missing'; },
    state => { state.crown.matches[0].comparison.markets[0].sides[0].polTokenId = 'lakers'; },
    state => { state.crown.matches[0].comparison.markets.push(structuredClone(state.crown.matches[0].comparison.markets[0])); },
    state => { state.crown.matches[0].markets.push(structuredClone(state.crown.matches[0].markets[0])); },
  ]) {
    const state = fixture(); mutate(state);
    assert.equal(rank(state).opportunities.some(item => item.marketId === 'spread'), false);
    assert.equal(rank(state).excludedMarketCount, 1);
  }
  const duplicate = fixture(); duplicate.crown.matches.push(structuredClone(duplicate.crown.matches[0]));
  assert.equal(rank(duplicate).opportunities.length, 0);
});

test('game profits select the largest RMB profit across spreads and totals rather than the highest ROI', () => {
  const state = fixture();
  for (const book of Object.values(state.books)) book.asks[0].price = 0.99;
  state.books.lakers.asks[0].price = 0.43;
  setOdds(state, 0, 'home', 0.85);
  state.books.over.asks[0].price = 0.5;
  setOdds(state, 1, 'under', 1.1);
  const byRoi = rank(state).opportunities;
  assert.equal(byRoi[0].polTokenId, 'lakers');
  close(byRoi[0].profitRmb, 8.085);
  const selected = best(state).get('event');
  assert.equal(selected.polTokenId, 'over');
  assert.equal(selected.type, 'totals');
  close(selected.profitRmb, 8.41);
  assert.ok(selected.roiPercent < byRoi[0].roiPercent);

  state.books.lakers.asks[0].price = 0.4;
  assert.equal(best(state).get('event').type, 'spreads');
});

test('game profits keep events isolated and ignore a panel event filter without changing source state', () => {
  const state = fixture(), second = fixture();
  const tokenSuffix = token => `${token}-second`;
  second.events[0].id = 'second';
  for (const market of second.events[0].markets) {
    for (const outcome of market.outcomes) outcome.tokenId = tokenSuffix(outcome.tokenId);
  }
  second.crown.matches[0].id = 'crown-second';
  second.crown.matches[0].comparison.polEventId = 'second';
  for (const market of [...second.crown.matches[0].markets, ...second.crown.matches[0].comparison.markets]) {
    for (const side of market.sides) side.polTokenId = tokenSuffix(side.polTokenId);
  }
  state.events.push(...second.events);
  state.crown.matches.push(...second.crown.matches);
  for (const [token, book] of Object.entries(second.books)) state.books[tokenSuffix(token)] = book;
  const before = structuredClone(state);
  const result = best(state, DEFAULT_HEDGE_SETTINGS, { eventId: 'missing' });
  assert.deepEqual([...result.keys()].sort(), ['event', 'second']);
  assert.equal(result.get('event').polTokenId.endsWith('-second'), false);
  assert.equal(result.get('second').polTokenId.endsWith('-second'), true);
  assert.deepEqual(state, before);

  for (const [token, book] of Object.entries(state.books)) {
    if (token.endsWith('-second')) book.asks[0].price = 0.99;
  }
  assert.deepEqual([...best(state).keys()], ['event']);
});

test('game profits exclude zero and losses, and recalculate using rebate and stake settings', () => {
  const noRebate = { ...DEFAULT_HEDGE_SETTINGS, rebatePercent: 0 };
  assert.equal(best(uniformQuotes(fixture(), 0.5, 1), noRebate).size, 0);
  assert.equal(best(uniformQuotes(fixture(), 0.6, 1), noRebate).size, 0);
  const state = uniformQuotes(fixture(), 0.5, 0.98);
  assert.equal(best(state, noRebate).size, 0);
  const standard = best(state).get('event');
  close(standard.profitRmb, 2.038);
  const larger = best(state, { ...DEFAULT_HEDGE_SETTINGS, crownStake: 1000 }).get('event');
  close(larger.profitRmb, standard.profitRmb * 10);
  assert.equal(best(state, { ...DEFAULT_HEDGE_SETTINGS, crownStake: 0 }).size, 0);
});

test('game profits hide disconnected, expired, ended and unmatched quotes', () => {
  assert.equal(best(fixture(), DEFAULT_HEDGE_SETTINGS, { connected: false }).size, 0);
  assert.equal(best(fixture(), DEFAULT_HEDGE_SETTINGS, { now: NOW + 30001 }).size, 0);
  for (const mutate of [
    state => { state.events[0].ended = true; },
    state => { state.crown.status = 'blocked'; },
    state => { state.crown.matches[0].comparison.status = 'unmatched'; },
    state => { for (const market of state.crown.matches[0].markets) market.checkedAt = timestamp(-90001); },
    state => { for (const book of Object.values(state.books)) book.asks = []; },
  ]) {
    const state = fixture(); mutate(state);
    assert.equal(best(state).size, 0);
  }
});

test('equal game profits resolve ties deterministically regardless of market ordering', () => {
  const state = uniformQuotes(fixture(), 0.5, 1);
  const expected = rank(state).opportunities.map(item => item.id).sort((a, b) => a.localeCompare(b))[0];
  assert.equal(best(state).get('event').id, expected);
  state.events[0].markets.reverse();
  for (const market of state.events[0].markets) market.outcomes.reverse();
  assert.equal(best(state).get('event').id, expected);
});
