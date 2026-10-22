import test from 'node:test';
import assert from 'node:assert/strict';
import { lineFor, groupMarkets, preferredLine, correspondingOutcome } from '../public/market-lines.js';

const event = { title: 'Nuggets vs. Thunder', markets: [] };
const market = (id, type, question, price = 0.5) => ({ id, type, question, acceptingOrders: true, closed: false,
  outcomes: [{ name: 'Nuggets', tokenId: `${id}-den`, referencePrice: price }, { name: 'Thunder', tokenId: `${id}-okc`, referencePrice: 1 - price }] });

test('spread selectors use one team as the reference and retain opposite handicaps', () => {
  assert.deepEqual(lineFor(market('a', 'spreads', 'Spread: Thunder (-8.5)'), event), { value: 8.5, label: '+8.5' });
  assert.deepEqual(lineFor(market('b', 'spreads', 'Spread: Nuggets (-8.5)'), event), { value: -8.5, label: '-8.5' });
  assert.equal(lineFor(market('c', 'spreads', 'Spread: Lakers (-3.5)'), event).value, null);
});

test('grouped line cards sort numeric lines and preserve original asset identities', () => {
  const markets = [market('a', 'totals', 'Nuggets vs. Thunder: O/U 240.5'), market('b', 'totals', 'Nuggets vs. Thunder: O/U 99.5'),
    market('c', 'spreads', 'Spread: Thunder (-8.5)'), market('d', 'spreads', 'Spread: Nuggets (-8.5)'), market('e', 'moneyline', 'Nuggets vs. Thunder')];
  const original = JSON.stringify(markets);
  const groups = groupMarkets({ ...event, markets });
  assert.deepEqual(groups.map(group => group.type), ['moneyline', 'spreads', 'totals']);
  assert.deepEqual(groups[1].lines.map(line => line.label), ['-8.5', '+8.5']);
  assert.deepEqual(groups[2].lines.map(line => line.label), ['99.5', '240.5']);
  assert.equal(groups[1].lines[0].market, markets[3]);
  assert.equal(JSON.stringify(markets), original);
});

test('default line prefers an open balanced market and keeps a remembered user choice', () => {
  const a = { market: { ...market('a', 'spreads', 'Spread: Nuggets (-2.5)', 0.5), closed: true, acceptingOrders: false } };
  const b = { market: market('b', 'spreads', 'Spread: Nuggets (-3.5)', 0.95) };
  const c = { market: market('c', 'spreads', 'Spread: Nuggets (-4.5)', 0.55) };
  assert.equal(preferredLine([a, b, c]).market.id, 'c');
  assert.equal(preferredLine([a, b, c], 'b').market.id, 'b');
  assert.equal(preferredLine([a, b, c], 'removed').market.id, 'c');
});

test('switching lines preserves the team or over/under side even when the outcome array reverses', () => {
  const next = { outcomes: [{ name: 'Thunder', tokenId: 'okc' }, { name: 'Denver Nuggets', tokenId: 'den' }] };
  assert.equal(correspondingOutcome({ name: 'Nuggets' }, next).tokenId, 'den');
  const totals = { outcomes: [{ name: 'Under', tokenId: 'under-new' }, { name: 'Over', tokenId: 'over-new' }] };
  assert.equal(correspondingOutcome({ name: 'Over 235.5' }, totals).tokenId, 'over-new');
  assert.equal(correspondingOutcome({ name: 'Under 235.5' }, totals).tokenId, 'under-new');
});
