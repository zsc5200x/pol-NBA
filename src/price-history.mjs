import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { eventTitle, marketTitle, outcomeTitle, spreadDetails, totalLine } from '../public/chinese.js';

const TYPES = new Set(['spreads', 'totals']);
const iso = () => new Date().toISOString();
const numeric = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const probability = value => { const n = numeric(value); return n !== null && n > 0 && n <= 1 ? n : null; };
const difference = (current, previous) => current !== null && previous !== null ? Number((current - previous).toFixed(10)) : null;
const keyOf = record => JSON.stringify([record.source, record.eventId, record.marketId]);
const fresh = (time, age, now = Date.now()) => Number.isFinite(Date.parse(time)) && now - Date.parse(time) <= age;

// Append every observed top-price transition; batching only groups disk writes,
// never coalesces A -> B -> A. This database contains public quotes, no sessions.
export class PriceHistory extends EventEmitter {
  constructor({ filename = resolve('.local/price-history.sqlite'), monitor, crown } = {}) {
    super();
    this.monitor = monitor;
    this.crown = crown;
    this.current = new Map();
    this.marketIndex = new Map();
    this.tokenIndex = new Map();
    this.queue = [];
    this.closed = false;
    this.error = null;
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS price_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL,
        event_id TEXT NOT NULL, market_id TEXT NOT NULL, type TEXT NOT NULL,
        observed_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS price_records_market ON price_records(event_id, market_id, id DESC);
      CREATE INDEX IF NOT EXISTS price_records_source ON price_records(event_id, type, source, id DESC);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('recordingSince', iso());
    this.recordingSince = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('recordingSince').value;
    this.insert = this.db.prepare('INSERT INTO price_records(source,event_id,market_id,type,observed_at,payload) VALUES(?,?,?,?,?,?)');
    // Guard listeners: a storage failure must never be reported as an upstream failure.
    this.onPol = event => this.guard(() => this.capturePol(event));
    this.onMarkets = () => this.guard(() => { this.rebuildIndex(); this.capturePol(); this.captureCrown(); });
    this.onCrown = () => this.guard(() => this.captureCrown());
    monitor?.on('quotes', this.onPol);
    monitor?.on('markets', this.onMarkets);
    crown?.on('quotes', this.onCrown);
    this.onMarkets();
    this.staleTimer = setInterval(() => this.guard(() => { this.capturePol(); this.captureCrown(); this.flush(); }), 5000);
    this.staleTimer.unref?.();
  }

  guard(work) {
    if (this.closed) return;
    try { work(); } catch {
      this.error = '价格历史暂时无法保存，正在等待重试。';
      this.emit('storageError', { code: 'PRICE_HISTORY_UNAVAILABLE' });
    }
  }

  rebuildIndex() {
    this.marketIndex.clear(); this.tokenIndex.clear();
    const state = this.monitor?.snapshot();
    if (state?.mode !== 'live') return;
    for (const event of state.events ?? []) for (const market of event.markets ?? []) {
      if (!TYPES.has(market.type)) continue;
      const identity = JSON.stringify([event.id, market.id]);
      const entry = { event, market };
      this.marketIndex.set(identity, entry);
      for (const outcome of market.outcomes ?? []) {
        const entries = this.tokenIndex.get(outcome.tokenId) ?? new Set();
        entries.add(entry); this.tokenIndex.set(outcome.tokenId, entries);
      }
    }
    for (const previous of [...this.current.values()]) {
      if (!this.marketIndex.has(JSON.stringify([previous.eventId, previous.marketId]))) this.markUnavailable(previous, iso(), 'market_removed');
    }
  }

  metadata(event, market) {
    return {
      eventId: event.id, marketId: market.id, type: market.type,
      line: market.type === 'spreads' ? spreadDetails(market)?.line ?? null : numeric(totalLine(market)),
      eventTitle: eventTitle(event), marketLabel: marketTitle(market, event), startTime: event.startTime,
    };
  }

  capturePol({ tokenIds, observedAt = iso() } = {}) {
    const state = this.monitor?.snapshot();
    if (state?.mode !== 'live') return;
    const entries = tokenIds ? new Set(tokenIds.flatMap(token => [...(this.tokenIndex.get(token) ?? [])])) : this.marketIndex.values();
    for (const { event, market } of entries) {
      const sides = market.outcomes.map(outcome => {
        const book = state.books?.[outcome.tokenId];
        const valid = book?.source === 'live' && !book.error && !market.closed && market.acceptingOrders !== false && fresh(book.verifiedAt ?? book.updatedAt, 30000);
        return {
          tokenId: outcome.tokenId, label: outcomeTitle(outcome, market),
          price: valid ? probability(book.asks?.[0]?.price) : null,
          bid: valid ? probability(book.bids?.[0]?.price) : null,
          sourceAt: book?.updatedAt ?? null, verifiedAt: book?.verifiedAt ?? null,
        };
      });
      this.record({ source: 'pol', ...this.metadata(event, market), observedAt, sides });
    }
  }

  captureCrown() {
    const state = this.monitor?.snapshot();
    if (!this.crown || state?.mode !== 'live') return;
    const now = iso();
    const snapshot = this.crown.snapshot(state);
    const seen = new Set();
    for (const match of snapshot.matches ?? []) {
      if (match.comparison?.status !== 'matched') continue;
      const event = state.events.find(item => item.id === match.comparison.polEventId);
      if (!event) continue;
      for (const comparison of match.comparison.markets ?? []) {
        if (!TYPES.has(comparison.type) || comparison.status !== 'matched') continue;
        const market = event.markets.find(item => item.id === comparison.polMarketId);
        const raw = match.markets.find(item => item.key === comparison.crownKey);
        if (!market || !raw) continue;
        const healthy = this.crown.lastDetailState?.get(match.id)?.healthy === true && snapshot.status !== 'blocked';
        const valid = healthy && raw.status === 'open' && raw.parseStatus === 'parsed' && fresh(raw.checkedAt, Math.max(90000, (this.crown.config?.intervalMs ?? 0) * 3));
        const record = {
          source: 'crown', ...this.metadata(event, market), observedAt: now,
          sourceAt: raw.checkedAt, crownMatchId: match.id, crownKey: raw.key, crownLine: raw.line,
          sides: market.outcomes.map(outcome => {
            const side = comparison.sides.find(item => item.polTokenId === outcome.tokenId);
            const rawPrice = numeric(side?.rawOdds);
            const available = valid && numeric(side?.decimalOdds) > 1 && rawPrice !== null && rawPrice !== 0;
            return {
              tokenId: outcome.tokenId, label: outcomeTitle(outcome, market),
              price: available ? rawPrice : null,
              decimalOdds: available ? numeric(side.decimalOdds) : null,
              oddsFormat: side?.oddsFormat ?? 'unknown', sourceAt: raw.checkedAt,
            };
          }),
        };
        seen.add(keyOf(record)); this.record(record);
      }
    }
    for (const previous of [...this.current.values()]) {
      if (previous.source === 'crown' && !seen.has(keyOf(previous))) this.markUnavailable(previous, now, 'quote_missing');
    }
  }

  markUnavailable(previous, observedAt, reason) {
    this.record({ ...previous, observedAt, reason, sides: previous.sides.map(side => ({ ...side, price: null, bid: side.bid === undefined ? undefined : null, decimalOdds: side.decimalOdds === undefined ? undefined : null })) });
  }

  record(candidate) {
    const key = keyOf(candidate);
    const previous = this.current.get(key);
    const fingerprint = record => JSON.stringify(record.sides.map(side => [side.tokenId, side.price, side.bid ?? null, side.oddsFormat ?? null, side.decimalOdds ?? null]));
    if (previous && fingerprint(previous) === fingerprint(candidate)) return;
    // An empty initial quote is not a baseline, and repeated failures do not add rows.
    if (!previous && !candidate.sides.some(side => side.price !== null || side.bid != null)) return;
    const lost = previous && candidate.sides.some((side, i) => side.price === null && previous.sides[i]?.price != null);
    const recovered = previous && candidate.sides.some((side, i) => side.price !== null && previous.sides[i]?.price == null);
    const kind = !previous ? 'baseline' : lost ? 'unavailable' : recovered ? 'recovered' : 'change';
    const record = {
      ...candidate, kind,
      sides: candidate.sides.map(side => {
        const old = previous?.sides.find(item => item.tokenId === side.tokenId);
        const sameFormat = !previous || candidate.source !== 'crown' || old?.oddsFormat === side.oddsFormat;
        return {
          ...side, previousPrice: old?.price ?? null,
          delta: sameFormat ? difference(side.price, old?.price ?? null) : null,
          ...(side.bid !== undefined ? { previousBid: old?.bid ?? null, bidDelta: difference(side.bid, old?.bid ?? null) } : {}),
        };
      }),
    };
    this.current.set(key, record);
    // Serialize immediately: later in-place order book updates cannot rewrite queued history.
    this.queue.push({ ...record, payload: JSON.stringify(record) });
    if (this.queue.length >= 1000) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.guard(() => this.flush()); }, 100);
      this.flushTimer.unref?.();
    }
  }

  flush() {
    if (this.closed || !this.queue.length) return;
    const rows = this.queue.slice();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) this.insert.run(row.source, row.eventId, row.marketId, row.type, row.observedAt, row.payload);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.queue.splice(0, rows.length);
    this.error = null;
    this.emit('change', { count: rows.length, observedAt: rows.at(-1).observedAt });
  }

  history({ eventId, type, marketId, source, limit = 50, before } = {}) {
    this.guard(() => this.flush());
    const where = [], args = [];
    for (const [column, value] of [['event_id', eventId], ['type', type], ['market_id', marketId], ['source', source]]) {
      if (value !== undefined && value !== null && value !== '') { where.push(`${column} = ?`); args.push(String(value)); }
    }
    const cursor = Number(before);
    if (before !== undefined && Number.isSafeInteger(cursor) && cursor > 0) { where.push('id < ?'); args.push(cursor); }
    const count = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
    const rows = this.db.prepare(`SELECT id,payload FROM price_records${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, count + 1);
    const records = rows.slice(0, count).map(row => ({ ...JSON.parse(row.payload), id: row.id }));
    return {
      records, hasMore: rows.length > count, nextBefore: rows.length > count ? records.at(-1).id : null,
      recordingSince: this.recordingSince, status: this.error ? 'error' : 'recording', error: this.error,
    };
  }

  close() {
    if (this.closed) return;
    this.monitor?.off('quotes', this.onPol); this.monitor?.off('markets', this.onMarkets); this.crown?.off('quotes', this.onCrown);
    clearTimeout(this.flushTimer); clearInterval(this.staleTimer);
    try { this.flush(); } finally { this.closed = true; this.db.close(); }
  }
}
