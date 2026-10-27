import { eventTeams, spreadDetails, teamFor } from '../../public/chinese.js';

const blocked = reason => ({ status: 'unmatched', reason });
const idsOf = event => eventTeams(event).map(team => team.id).sort();
const priceIsValid = value => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) < 1;

function isFullGame(market) {
  // The monitor normalizes only Gamma's exact "spreads" type; first-half and
  // quarter types do not pass that filter. If richer period metadata exists,
  // honor it and reject any value that does not explicitly mean full game.
  for (const value of [market.period, market.gamePeriod, market.timePeriod]) {
    if (value !== undefined && !['full', 'full_game', 'game', 'match'].includes(String(value).toLowerCase())) return false;
  }
  const label = `${market.question ?? ''} ${market.groupItemTitle ?? ''}`;
  return !/(?:1st|first|1h|half\s*time|half-time|2nd|second\s*half|quarter|1q|2q|3q|4q|上半场|下半场|半场|第[一二三四]节)/i.test(label);
}

function matchingLines(event, selection) {
  const all = [];
  for (const market of event.markets ?? []) {
    if (market.type !== 'spreads' || !isFullGame(market)) continue;
    const details = spreadDetails(market);
    if (!details) continue;
    const teamLine = details.team.id === selection.teamId ? details.line : -details.line;
    if (details.team.id !== selection.teamId && !idsOf(event).includes(details.team.id)) continue;
    if (teamLine === selection.handicap) all.push(market);
  }
  return all;
}

function freshBook(book, tokenId, now, maxBookAgeMs) {
  if (!book || book.source !== 'live' || book.error || book.tokenId !== tokenId) return false;
  const observedAt = Date.parse(book.verifiedAt ?? book.updatedAt ?? '');
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > maxBookAgeMs) return false;
  const ask = book.asks?.[0];
  return Boolean(ask && priceIsValid(Number(ask.price)) && Number.isFinite(Number(ask.size)) && Number(ask.size) > 0);
}

/**
 * Resolve a parsed full-game NBA spread signal to one live Polymarket result
 * and its fresh order book. Any non-unique or non-actionable match is rejected.
 */
export function resolveTradingMarket(signal, polState, { now = Date.now(), maxBookAgeMs = 30000 } = {}) {
  if (signal?.sport !== 'NBA' || signal?.marketType !== 'spreads' || signal?.period !== 'full') {
    return blocked('仅支持 NBA 全场让分信号');
  }
  if (!Number.isFinite(signal?.selection?.handicap) || !signal.selection.teamId) return blocked('信号方向或分值无效');
  if (polState?.mode !== 'live' || polState?.status !== 'live') return blocked('Polymarket 实时行情不可用');

  const wantedTeams = [...new Set((signal.teams ?? []).map(team => team.id))].sort();
  if (wantedTeams.length !== 2 || !wantedTeams.includes(signal.selection.teamId)) return blocked('信号球队不属于该场比赛');
  const events = (polState.events ?? []).filter(event => {
    const teams = idsOf(event);
    return teams.length === 2 && teams[0] === wantedTeams[0] && teams[1] === wantedTeams[1];
  });
  if (events.length !== 1) {
    return { status: events.length ? 'ambiguous' : 'unmatched', reason: events.length ? '同队比赛存在多个候选' : '当前盘口范围内没有该场比赛' };
  }
  const event = events[0];
  const lineMarkets = matchingLines(event, signal.selection);
  if (lineMarkets.length !== 1) {
    return { status: lineMarkets.length ? 'ambiguous' : 'unmatched', reason: lineMarkets.length ? '同一让分线存在多个盘口' : '没有完全匹配的全场让分线' };
  }
  const market = lineMarkets[0];
  if (market.closed !== false || market.acceptingOrders !== true) return blocked('盘口已关闭或不接收订单');

  const outcomes = (market.outcomes ?? []).filter(outcome => teamFor(outcome?.name)?.id === signal.selection.teamId);
  if (outcomes.length !== 1) {
    return { status: outcomes.length ? 'ambiguous' : 'unmatched', reason: outcomes.length ? '球队结果对应多个标的' : '找不到信号球队对应的市场结果' };
  }
  const outcome = outcomes[0];
  const tokenId = typeof outcome.tokenId === 'string' ? outcome.tokenId.trim() : '';
  if (!tokenId) return blocked('市场结果缺少可交易标的');

  const book = polState.books?.[tokenId];
  if (!freshBook(book, tokenId, now, maxBookAgeMs)) return blocked('目标订单簿缺失、过期或没有有效卖盘');
  return {
    status: 'matched',
    event,
    market,
    outcome,
    tokenId,
    book,
    bestAsk: Number(book.asks[0].price),
    bestBid: priceIsValid(Number(book.bids?.[0]?.price)) ? Number(book.bids[0].price) : null,
    lineForTeam: signal.selection.handicap,
  };
}
