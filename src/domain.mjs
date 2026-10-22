export const RANGES = new Set(['upcoming', 'past', 'both']);
export const TIMEZONES = new Set(['Asia/Shanghai', 'America/New_York', 'UTC']);

export function dayKey(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('-');
}

export function rangeKeys(now, range, timezone) {
  const today = dayKey(now, timezone);
  const base = new Date(`${today}T12:00:00Z`);
  const offsets = range === 'past' ? [-2, -1, 0] : range === 'both' ? [-2, -1, 0, 1, 2] : [0, 1, 2];
  return new Set(offsets.map(n => new Date(base.getTime() + n * 86400000).toISOString().slice(0, 10)));
}

function array(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

export function price(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function normalizeLevels(levels, side) {
  const byPrice = new Map();
  for (const level of levels ?? []) {
    const p = price(level.price);
    const size = Number(level.size);
    if (p !== null && Number.isFinite(size) && size > 0) byPrice.set(p, { price: p, size });
  }
  return [...byPrice.values()].sort((a, b) => side === 'bids' ? b.price - a.price : a.price - b.price);
}

export function normalizeBook(raw, now = new Date().toISOString()) {
  return {
    tokenId: String(raw.asset_id ?? raw.token_id),
    bids: normalizeLevels(raw.bids, 'bids'),
    asks: normalizeLevels(raw.asks, 'asks'),
    updatedAt: now,
    verifiedAt: now,
    source: 'live',
    error: null,
    timestamp: Number(raw.timestamp) || 0,
  };
}

export function updateLevel(book, change, now = new Date().toISOString()) {
  const p = price(change.price);
  const size = Number(change.size);
  const side = change.side === 'BUY' ? 'bids' : change.side === 'SELL' ? 'asks' : null;
  if (p === null || !side || !Number.isFinite(size) || size < 0) return false;
  const levels = book[side].filter(level => level.price !== p);
  if (size > 0) levels.push({ price: p, size });
  book[side] = normalizeLevels(levels, side);
  book.updatedAt = now;
  book.verifiedAt = now;
  book.error = null;
  return true;
}

export function normalizeEvent(raw) {
  const markets = (raw.markets ?? []).filter(m =>
    ['moneyline', 'spreads', 'totals'].includes(m.sportsMarketType) &&
    (m.closed || m.enableOrderBook !== false)).map(m => {
    const outcomes = array(m.outcomes);
    const legacyTokens = array(m.clobTokenIds);
    const tokens = legacyTokens.length ? legacyTokens : array(m.positionIds);
    const prices = array(m.outcomePrices);
    if (!tokens.length || tokens.length !== outcomes.length ||
      tokens.some(t => typeof t !== 'string' || !t.trim()) ||
      outcomes.some(o => typeof o !== 'string' || !o.trim())) return null;
    return {
      id: String(m.id), question: m.question ?? raw.title,
      type: m.sportsMarketType ?? 'other',
      closed: Boolean(m.closed),
      acceptingOrders: !m.closed && m.acceptingOrders !== false,
      outcomes: outcomes.map((name, i) => ({ name: String(name), tokenId: String(tokens[i]), referencePrice: price(prices[i]) })),
    };
  }).filter(Boolean);
  const start = raw.startTime ?? raw.gameStartTime ?? (raw.markets ?? []).find(m => m.gameStartTime)?.gameStartTime;
  if (!start || !Number.isFinite(Date.parse(start)) || !markets.length) return null;
  return { id: String(raw.id), title: raw.title ?? raw.slug, slug: raw.slug ?? '', startTime: new Date(start).toISOString(), markets };
}

export function selectEvents(rawEvents, { now = new Date(), range = 'upcoming', timezone = 'Asia/Shanghai' } = {}) {
  const days = rangeKeys(now, range, timezone);
  const unique = new Map();
  for (const raw of rawEvents) {
    const event = normalizeEvent(raw);
    if (event && days.has(dayKey(new Date(event.startTime), timezone))) unique.set(event.id, event);
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

export function summarizeBook(book) {
  const bid = book?.bids?.[0]?.price ?? null;
  const ask = book?.asks?.[0]?.price ?? null;
  return { bid, ask, spread: bid !== null && ask !== null ? ask - bid : null };
}
