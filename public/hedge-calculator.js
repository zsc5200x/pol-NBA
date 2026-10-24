import { eventTitle, outcomeTitle, teamFor } from './chinese.js';
import { lineForReference } from './market-lines.js';

export const DEFAULT_HEDGE_SETTINGS = Object.freeze({ crownStake: 100, exchangeRate: 7, rebatePercent: 3.1 });

const TYPES = new Set(['spreads', 'totals']);
const OPPOSITE = { home: 'away', away: 'home', over: 'under', under: 'over' };
const list = value => Array.isArray(value) ? value : [];
const numeric = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const sameNumber = (left, right) => numeric(left) !== null && numeric(right) !== null && Math.abs(Number(left) - Number(right)) < 1e-10;
const halfLine = value => numeric(value) !== null && Math.abs(Number(value) % 1) === 0.5;
const fresh = (value, now, maxAge) => {
  const timestamp = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= maxAge;
};

export function validateHedgeSettings(input) {
  const crownStake = numeric(input?.crownStake);
  const exchangeRate = numeric(input?.exchangeRate);
  const rebatePercent = numeric(input?.rebatePercent);
  const errors = {};
  if (crownStake === null || crownStake <= 0 || crownStake > 1e9) errors.crownStake = '皇冠本金须大于 0 且不超过 10 亿元。';
  if (exchangeRate === null || exchangeRate <= 0 || exchangeRate > 1000) errors.exchangeRate = '汇率须大于 0 且不超过 1000。';
  if (rebatePercent === null || rebatePercent < 0 || rebatePercent > 100) errors.rebatePercent = '反水比例须在 0% 到 100% 之间。';
  return { settings: Object.keys(errors).length ? null : { crownStake, exchangeRate, rebatePercent }, errors };
}

// Match the two gross payouts in RMB. Rebate uses stake × Hong Kong odds,
// including odds above 1, and is added equally to either settlement outcome.
export function calculateHedge(input) {
  const { settings } = validateHedgeSettings(input);
  const polPrice = numeric(input?.polPrice);
  const crownOdds = numeric(input?.crownOdds);
  if (!settings || polPrice === null || polPrice <= 0 || polPrice >= 1 || crownOdds === null || crownOdds <= 0) return null;
  const { crownStake: crownStakeRmb, exchangeRate, rebatePercent } = settings;
  const decimalOdds = 1 + crownOdds;
  const polShares = crownStakeRmb * decimalOdds / exchangeRate;
  const polCostUsd = polShares * polPrice;
  const polCostRmb = polCostUsd * exchangeRate;
  const totalCostRmb = crownStakeRmb + polCostRmb;
  const effectiveStakeRmb = crownStakeRmb * crownOdds;
  const rebateRmb = effectiveStakeRmb * rebatePercent / 100;
  const profitBeforeRebateRmb = crownStakeRmb * decimalOdds - totalCostRmb;
  const polWinProfitRmb = polShares * exchangeRate - totalCostRmb + rebateRmb;
  const crownWinProfitRmb = crownStakeRmb * decimalOdds - totalCostRmb + rebateRmb;
  const profitRmb = Math.min(polWinProfitRmb, crownWinProfitRmb);
  const result = { crownStakeRmb, crownOdds, decimalOdds, polPrice, polShares, polCostUsd, polCostRmb, totalCostRmb,
    effectiveStakeRmb, rebateRmb, profitBeforeRebateRmb, polWinProfitRmb, crownWinProfitRmb, profitRmb,
    roiPercent: profitRmb / totalCostRmb * 100 };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function outcomeDirection(outcome, market, comparison) {
  if (market.type === 'totals') {
    const name = String(outcome?.name ?? '').trim();
    return /^(over\b|大于)/i.test(name) ? 'over' : /^(under\b|小于)/i.test(name) ? 'under' : null;
  }
  const team = teamFor(outcome?.name);
  if (!team) return null;
  return team.id === comparison.homeId ? 'home' : team.id === comparison.awayId ? 'away' : null;
}

function validCrownSide(side, comparedSide) {
  const odds = numeric(side?.rawOdds);
  return side?.oddsFormat === 'hongkong' && comparedSide?.oddsFormat === 'hongkong' && odds !== null && odds > 0 &&
    sameNumber(side.decimalOdds, odds + 1) && sameNumber(comparedSide.rawOdds, odds) && sameNumber(comparedSide.decimalOdds, odds + 1) &&
    comparedSide.comparisonStatus === 'comparable_quote';
}

export function rankHedgeOpportunities(state, settings, { eventId = null, now = Date.now(), connected = true } = {}) {
  const events = list(state?.events).filter(event => eventId === null || event.id === eventId);
  const candidates = events.flatMap(event => list(event.markets).filter(market => TYPES.has(market.type)).map(market => ({ event, market })));
  const result = { opportunities: [], eligibleMarketCount: 0, excludedMarketCount: candidates.length };
  const validated = validateHedgeSettings(settings).settings;
  if (!validated || !Number.isFinite(now) || !connected || state?.mode !== 'live' || state.status === 'blocked' ||
      !state.crown || state.crown.status === 'blocked' || state.crown.mappingVerified === false) return result;
  const matches = list(state.crown.matches);
  for (const { event, market } of candidates) {
    if (event.closed || event.ended || market.closed || market.acceptingOrders !== true) continue;
    // A single event must have a single Crown identity, and a single exact line mapping.
    const eventMatches = matches.filter(match => match.comparison?.polEventId === event.id);
    if (eventMatches.length !== 1) continue;
    const match = eventMatches[0], comparison = match.comparison;
    if (comparison.status !== 'matched') continue;
    const linkedMarkets = list(comparison.markets).filter(item => item.polMarketId === market.id);
    if (linkedMarkets.length !== 1) continue;
    const linked = linkedMarkets[0];
    const line = lineForReference(market, comparison.homeId, comparison.awayId).value;
    if (linked.status !== 'matched' || linked.type !== market.type || !halfLine(line) || !sameNumber(linked.line, line)) continue;
    const rawMarkets = list(match.markets).filter(item => item.key === linked.crownKey);
    if (rawMarkets.length !== 1) continue;
    const raw = rawMarkets[0];
    if (raw.type !== market.type || raw.phase !== 'full' || !sameNumber(raw.line, line) || raw.status !== 'open' ||
        raw.parseStatus !== 'parsed' || !fresh(raw.checkedAt, now, 90000)) continue;
    const outcomes = list(market.outcomes);
    if (outcomes.length !== 2 || new Set(outcomes.map(outcome => outcome.tokenId)).size !== 2) continue;
    const directions = market.type === 'spreads' ? ['home', 'away'] : ['over', 'under'];
    const mappedSides = list(linked.sides), rawSides = list(raw.sides);
    if (directions.some(direction => mappedSides.filter(side => side.direction === direction).length !== 1 ||
        rawSides.filter(side => side.direction === direction).length !== 1)) continue;
    const mappedOutcomes = new Map();
    for (const direction of directions) {
      const side = mappedSides.find(item => item.direction === direction);
      const found = outcomes.filter(outcome => outcome.tokenId === side.polTokenId && outcomeDirection(outcome, market, comparison) === direction);
      if (found.length === 1) mappedOutcomes.set(direction, found[0]);
    }
    if (mappedOutcomes.size !== 2) continue;
    let eligible = false;
    for (const direction of directions) {
      const outcome = mappedOutcomes.get(direction), opposite = OPPOSITE[direction];
      const crownSide = rawSides.find(side => side.direction === opposite);
      const comparedSide = mappedSides.find(side => side.direction === opposite);
      const book = state.books?.[outcome.tokenId];
      const firstAsk = list(book?.asks)[0], price = numeric(firstAsk?.price), size = numeric(firstAsk?.size);
      if (!validCrownSide(crownSide, comparedSide) || book?.source !== 'live' || book.error || !fresh(book.verifiedAt, now, 30000) ||
          price === null || price <= 0 || price >= 1 || size === null || size <= 0) continue;
      const calculation = calculateHedge({ ...validated, polPrice: price, crownOdds: crownSide.rawOdds });
      if (!calculation) continue;
      eligible = true;
      result.opportunities.push({ id: `${event.id}:${market.id}:${outcome.tokenId}`, eventId: event.id, eventTitle: eventTitle(event),
        marketId: market.id, type: market.type, line, polTokenId: outcome.tokenId,
        polLabel: outcomeTitle(outcome, market), crownLabel: outcomeTitle(mappedOutcomes.get(opposite), market),
        polUpdatedAt: book.verifiedAt, crownUpdatedAt: raw.checkedAt, ...calculation });
    }
    if (eligible) result.eligibleMarketCount++;
  }
  result.excludedMarketCount -= result.eligibleMarketCount;
  result.opportunities.sort((left, right) => right.roiPercent - left.roiPercent || right.profitRmb - left.profitRmb || left.id.localeCompare(right.id));
  return result;
}

// The game list summarizes all events by RMB profit, independently of the
// calculator panel's selected event and ROI ordering.
export function bestProfitableHedgesByEvent(state, settings, { now = Date.now(), connected = true } = {}) {
  const bestByEvent = new Map();
  const { opportunities } = rankHedgeOpportunities(state, settings, { now, connected });
  for (const candidate of opportunities) {
    if (!Number.isFinite(candidate.profitRmb) || candidate.profitRmb <= 0) continue;
    const current = bestByEvent.get(candidate.eventId);
    if (!current || candidate.profitRmb > current.profitRmb ||
        (candidate.profitRmb === current.profitRmb && (candidate.roiPercent > current.roiPercent ||
          (candidate.roiPercent === current.roiPercent && candidate.id.localeCompare(current.id) < 0)))) {
      bestByEvent.set(candidate.eventId, candidate);
    }
  }
  return bestByEvent;
}
