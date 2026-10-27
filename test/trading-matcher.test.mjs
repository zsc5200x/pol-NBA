import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTradingMarket } from '../src/trading/matcher.mjs';

const signal = {
  sport: 'NBA',
  marketType: 'spreads',
  period: 'full',
  teams: [{ id: 'uta' }, { id: 'mem' }],
  selection: { teamId: 'mem', handicap: 1.5 },
};

function state({
  events,
  market = { id: 'spread-1', type: 'spreads', question: 'Spread: Utah Jazz (-1.5)', closed: false, acceptingOrders: true,
    outcomes: [{ name: 'Utah Jazz', tokenId: 'uta-token' }, { name: 'Memphis Grizzlies', tokenId: 'mem-token' }] },
  book = { tokenId: 'mem-token', source: 'live', error: null, verifiedAt: '2026-10-26T00:00:00.000Z',
    asks: [{ price: 0.45, size: 20 }], bids: [{ price: 0.42, size: 30 }] },
  mode = 'live', status = 'live',
} = {}) {
  const game = { id: 'event-1', title: 'Utah Jazz vs. Memphis Grizzlies', startTime: '2026-10-26T02:00:00.000Z', markets: [market] };
  return { mode, status, events: events ?? [game], books: { 'mem-token': book } };
}

const options = { now: Date.parse('2026-10-26T00:00:10.000Z') };

test('maps Memphis +1.5 to the Memphis outcome when Utah is the market line reference', () => {
  const result = resolveTradingMarket(signal, state(), options);
  assert.equal(result.status, 'matched');
  assert.equal(result.event.id, 'event-1');
  assert.equal(result.market.id, 'spread-1');
  assert.equal(result.outcome.name, 'Memphis Grizzlies');
  assert.equal(result.tokenId, 'mem-token');
  assert.equal(result.bestAsk, 0.45);
  assert.equal(result.bestBid, 0.42);
  assert.equal(result.lineForTeam, 1.5);
});

test('matches a Memphis-reference market only at the exact signed line', () => {
  const market = { ...state().events[0].markets[0], question: 'Spread: Memphis Grizzlies (+1.5)' };
  assert.equal(resolveTradingMarket(signal, state({ market }), options).status, 'matched');
  const wrongSign = { ...market, question: 'Spread: Memphis Grizzlies (-1.5)' };
  assert.equal(resolveTradingMarket(signal, state({ market: wrongSign }), options).status, 'unmatched');
});

test('rejects events whose teams do not exactly match or where the pair is ambiguous', () => {
  const original = state().events[0];
  const otherGame = { ...original, id: 'event-other', title: 'Utah Jazz vs. Memphis Grizzlies' };
  assert.equal(resolveTradingMarket(signal, state({ events: [{ ...original, title: 'Utah Jazz vs. Portland Trail Blazers' }] }), options).status, 'unmatched');
  assert.equal(resolveTradingMarket(signal, state({ events: [original, otherGame] }), options).status, 'ambiguous');
});

test('requires live mode, a full-game spread, an open accepting market, and one team outcome', () => {
  const open = state().events[0].markets[0];
  for (const changes of [
    { mode: 'demo' },
    { status: 'degraded' },
    { market: { ...open, type: 'moneyline' } },
    { market: { ...open, question: 'First Half Spread: Utah Jazz (-1.5)' } },
    { market: { ...open, closed: true } },
    { market: { ...open, acceptingOrders: false } },
    { market: { ...open, outcomes: [{ name: 'Utah Jazz', tokenId: 'uta-token' }] } },
    { market: { ...open, outcomes: [...open.outcomes, { name: 'Memphis Grizzlies', tokenId: 'mem-token-2' }] } },
  ]) assert.notEqual(resolveTradingMarket(signal, state(changes), options).status, 'matched');
});

test('rejects missing, stale, errored, mismatched, or non-executable order books', () => {
  const good = state().books['mem-token'];
  for (const book of [
    undefined,
    { ...good, verifiedAt: '2026-10-25T23:00:00.000Z' },
    { ...good, error: 'stale' },
    { ...good, source: 'demo' },
    { ...good, tokenId: 'another-token' },
    { ...good, asks: [] },
    { ...good, asks: [{ price: 1, size: 20 }] },
    { ...good, asks: [{ price: 0.45, size: 0 }] },
  ]) {
    const polState = state({ book });
    if (book === undefined) delete polState.books['mem-token'];
    assert.notEqual(resolveTradingMarket(signal, polState, options).status, 'matched');
  }
});
