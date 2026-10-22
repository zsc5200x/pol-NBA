import { eventTeams, spreadDetails, totalLine, teamFor } from './chinese.js';

// A spread is always displayed relative to the first team in the matchup.
// Opposite handicaps stay distinct; books from different markets are never merged.
export function lineFor(market, event) {
  if (market.type === 'totals') {
    const text = totalLine(market);
    return { value: text ? Number(text) : null, label: text || '线位待识别' };
  }
  if (market.type === 'spreads') {
    const details = spreadDetails(market);
    const teams = eventTeams(event);
    if (!details || teams.length !== 2 || !teams.some(t => t.id === details.team.id)) return { value: null, label: '线位待识别' };
    const value = details.team.id === teams[0].id ? details.line : -details.line;
    return { value, label: `${value > 0 ? '+' : ''}${value}` };
  }
  return { value: null, label: '胜负' };
}

export function groupMarkets(event) {
  return ['moneyline', 'spreads', 'totals'].map(type => ({
    type,
    lines: (event.markets ?? []).filter(market => market.type === type)
      .map(market => ({ market, ...lineFor(market, event) }))
      .sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity) || a.market.id.localeCompare(b.market.id)),
  })).filter(group => group.lines.length);
}

export function preferredLine(lines, rememberedId) {
  const remembered = lines.find(line => line.market.id === rememberedId);
  if (remembered) return remembered;
  const candidates = lines.filter(({ market }) => market.acceptingOrders && !market.closed);
  const score = ({ market }) => {
    const p = market.outcomes[0]?.referencePrice;
    return typeof p === 'number' && Number.isFinite(p) ? Math.abs(p - 0.5) : Infinity;
  };
  return [...(candidates.length ? candidates : lines)].sort((a, b) => score(a) - score(b))[0];
}

function identity(outcome) {
  const team = teamFor(outcome?.name);
  if (team) return team.id;
  const name = String(outcome?.name ?? '').trim();
  if (/^(over\b|大于)/i.test(name)) return 'over';
  if (/^(under\b|小于)/i.test(name)) return 'under';
  return name;
}

export function correspondingOutcome(previous, nextMarket) {
  return nextMarket.outcomes.find(outcome => identity(outcome) === identity(previous)) ?? nextMarket.outcomes[0];
}
