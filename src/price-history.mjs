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
const polSideKey = (eventId, marketId, tokenId) => JSON.stringify([eventId, marketId, tokenId]);
const crownSideKey = polSideKey;
const fresh = (time, age, now = Date.now()) => Number.isFinite(Date.parse(time)) && now - Date.parse(time) <= age;

// Append every observed top-price transition; batching only groups disk writes,
// never coalesces A -> B -> A. This database contains public quotes, no sessions.
export class PriceHistory extends EventEmitter {
  constructor({ filename = resolve('.local/price-history.sqlite'), monitor, crown } = {}) {
    super();
    this.monitor = monitor;
    this.crown = crown;
    this.marketIndex = new Map();
    this.tokenIndex = new Map();
    this.polLastValid = new Map();
    this.polHydrated = new Set();
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
      CREATE TABLE IF NOT EXISTS pol_ask_history (
        record_id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, market_id TEXT NOT NULL,
        type TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pol_ask_history_market ON pol_ask_history(event_id, market_id, record_id DESC);
      CREATE INDEX IF NOT EXISTS pol_ask_history_source ON pol_ask_history(event_id, type, record_id DESC);
      CREATE TABLE IF NOT EXISTS crown_price_history (
        record_id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, market_id TEXT NOT NULL,
        type TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS crown_price_history_market ON crown_price_history(event_id, market_id, record_id DESC);
      CREATE INDEX IF NOT EXISTS crown_price_history_source ON crown_price_history(event_id, type, record_id DESC);
      CREATE TABLE IF NOT EXISTS pol_ask_last (
        event_id TEXT NOT NULL, market_id TEXT NOT NULL, token_id TEXT NOT NULL,
        price REAL NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(event_id, market_id, token_id)
      );
      CREATE TABLE IF NOT EXISTS crown_price_last (
        event_id TEXT NOT NULL, market_id TEXT NOT NULL, token_id TEXT NOT NULL,
        price REAL NOT NULL, odds_format TEXT NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(event_id, market_id, token_id)
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('recordingSince', iso());
    this.recordingSince = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('recordingSince').value;
    this.insert = this.db.prepare('INSERT INTO price_records(source,event_id,market_id,type,observed_at,payload) VALUES(?,?,?,?,?,?)');
    this.insertPolAskHistory = this.db.prepare('INSERT OR REPLACE INTO pol_ask_history(record_id,event_id,market_id,type,observed_at,payload) VALUES(?,?,?,?,?,?)');
    this.insertCrownHistory = this.db.prepare('INSERT OR REPLACE INTO crown_price_history(record_id,event_id,market_id,type,observed_at,payload) VALUES(?,?,?,?,?,?)');
    this.upsertPolAskLast = this.db.prepare(`INSERT INTO pol_ask_last(event_id,market_id,token_id,price,observed_at) VALUES(?,?,?,?,?)
      ON CONFLICT(event_id,market_id,token_id) DO UPDATE SET price=excluded.price, observed_at=excluded.observed_at`);
    this.upsertCrownLast = this.db.prepare(`INSERT INTO crown_price_last(event_id,market_id,token_id,price,odds_format,observed_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(event_id,market_id,token_id) DO UPDATE SET price=excluded.price, odds_format=excluded.odds_format, observed_at=excluded.observed_at`);
    this.backfillPolHistory();
    this.backfillCrownHistory();
    this.crownLastValid = new Map(this.db.prepare('SELECT event_id,market_id,token_id,price,odds_format FROM crown_price_last').all()
      .map(row => [crownSideKey(row.event_id, row.market_id, row.token_id), { price: Number(row.price), oddsFormat: row.odds_format }]));
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
      this.hydratePolMarket(event.id, market.id);
      for (const outcome of market.outcomes ?? []) {
        const entries = this.tokenIndex.get(outcome.tokenId) ?? new Set();
        entries.add(entry); this.tokenIndex.set(outcome.tokenId, entries);
      }
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
          sourceAt: book?.updatedAt ?? null, verifiedAt: book?.verifiedAt ?? null,
        };
      });
      this.recordPol({ source: 'pol', ...this.metadata(event, market), observedAt, sides });
    }
  }

  hydratePolMarket(eventId, marketId) {
    const key = JSON.stringify([eventId, marketId]);
    if (this.polHydrated.has(key)) return;
    const rows = this.db.prepare('SELECT token_id,price FROM pol_ask_last WHERE event_id=? AND market_id=?').all(String(eventId), String(marketId));
    for (const row of rows) this.polLastValid.set(polSideKey(eventId, marketId, row.token_id), Number(row.price));
    this.polHydrated.add(key);
  }

  recordPol(candidate) {
    const key = JSON.stringify([candidate.eventId, candidate.marketId]);
    if (!this.polHydrated.has(key)) this.hydratePolMarket(candidate.eventId, candidate.marketId);
    const changes = candidate.sides.map(side => {
      const price = probability(side.price);
      const lastKey = polSideKey(candidate.eventId, candidate.marketId, side.tokenId);
      const previousPrice = this.polLastValid.get(lastKey) ?? null;
      return { side, price, lastKey, previousPrice, changed: price !== null && previousPrice !== price };
    });
    if (!changes.some(item => item.changed)) return;
    const hasPrevious = changes.some(item => item.previousPrice !== null);
    const record = {
      ...candidate, kind: hasPrevious ? 'change' : 'baseline',
      sides: changes.map(({ side, price, previousPrice }) => ({
        tokenId: side.tokenId, label: side.label,
        price, previousPrice,
        delta: price === null ? null : difference(price, previousPrice),
        sourceAt: side.sourceAt ?? null, verifiedAt: side.verifiedAt ?? null,
      })),
    };
    // Keep all valid asks independently, even when only another side changed.
    for (const item of changes) if (item.price !== null) this.polLastValid.set(item.lastKey, item.price);
    this.queue.push({ ...record, polAsk: true, payload: JSON.stringify(record) });
    if (this.queue.length >= 1000) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.guard(() => this.flush()); }, 100);
      this.flushTimer.unref?.();
    }
  }

  backfillPolHistory() {
    const latest = this.db.prepare('SELECT event_id,market_id,token_id,price FROM pol_ask_last').all();
    const last = new Map(latest.map(row => [polSideKey(row.event_id, row.market_id, row.token_id), Number(row.price)]));
    const cursorStatement = this.db.prepare('SELECT value FROM metadata WHERE key=?');
    const saveCursor = this.db.prepare(`INSERT INTO metadata(key,value) VALUES('polAskHistoryCursor',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    const batchQuery = this.db.prepare("SELECT id,event_id,market_id,type,observed_at,payload FROM price_records WHERE source='pol' AND id>? ORDER BY id ASC LIMIT 500");
    let cursor = Number(cursorStatement.get('polAskHistoryCursor')?.value ?? 0) || 0;
    for (;;) {
      const rows = batchQuery.all(cursor);
      if (!rows.length) break;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const legacy = JSON.parse(row.payload);
          const sides = (legacy.sides ?? []).map(side => {
            const price = probability(side.price);
            const lastKey = polSideKey(row.event_id, row.market_id, side.tokenId);
            const previousPrice = last.get(lastKey) ?? null;
            if (price !== null) last.set(lastKey, price);
            return {
              tokenId: side.tokenId, label: side.label,
              price, previousPrice,
              delta: price === null ? null : difference(price, previousPrice),
              sourceAt: side.sourceAt ?? null, verifiedAt: side.verifiedAt ?? null,
            };
          });
          const changed = sides.some(side => side.price !== null && side.price !== side.previousPrice);
          if (changed) {
            const payload = JSON.stringify({
              ...legacy, source: 'pol', kind: sides.some(side => side.previousPrice !== null) ? 'change' : 'baseline', sides,
            });
            this.insertPolAskHistory.run(row.id, row.event_id, row.market_id, row.type, row.observed_at, payload);
          }
          for (const side of sides) if (side.price !== null) {
            this.upsertPolAskLast.run(row.event_id, row.market_id, side.tokenId, side.price, row.observed_at);
          }
          cursor = row.id;
        }
        saveCursor.run(String(cursor));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }

  backfillCrownHistory() {
    const cursorStatement = this.db.prepare('SELECT value FROM metadata WHERE key=?');
    const saveCursor = this.db.prepare(`INSERT INTO metadata(key,value) VALUES('crownPriceHistoryCursor',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    const batchQuery = this.db.prepare("SELECT id,event_id,market_id,type,observed_at,payload FROM price_records WHERE source='crown' AND id>? ORDER BY id ASC LIMIT 500");
    let cursor = Number(cursorStatement.get('crownPriceHistoryCursor')?.value ?? 0) || 0;
    const last = new Map();
    if (cursor > 0) {
      for (const row of this.db.prepare('SELECT event_id,market_id,token_id,price,odds_format FROM crown_price_last').all()) {
        last.set(crownSideKey(row.event_id, row.market_id, row.token_id), { price: Number(row.price), oddsFormat: row.odds_format });
      }
    }
    for (;;) {
      const rows = batchQuery.all(cursor);
      if (!rows.length) break;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const legacy = JSON.parse(row.payload);
          let rowChanged = false;
          const sides = (legacy.sides ?? []).map(side => {
            const price = numeric(side.price);
            const valid = price !== null && price !== 0 && numeric(side.decimalOdds) > 1;
            const oddsFormat = side.oddsFormat ?? 'unknown';
            const lastKey = crownSideKey(row.event_id, row.market_id, side.tokenId);
            const previous = last.get(lastKey) ?? null;
            const changed = valid && (!previous || price !== previous.price || oddsFormat !== previous.oddsFormat);
            if (changed) rowChanged = true;
            if (valid) last.set(lastKey, { price, oddsFormat });
            return {
              ...side, price: valid ? price : null,
              previousPrice: previous?.price ?? null,
              delta: valid && previous?.oddsFormat === oddsFormat ? difference(price, previous.price) : null,
            };
          });
          if (rowChanged) {
            const payload = JSON.stringify({ ...legacy, source: 'crown', kind: sides.some(side => side.previousPrice !== null) ? 'change' : 'baseline', sides });
            this.insertCrownHistory.run(row.id, row.event_id, row.market_id, row.type, row.observed_at, payload);
          }
          for (const side of sides) if (side.price !== null) {
            this.upsertCrownLast.run(row.event_id, row.market_id, side.tokenId, side.price, side.oddsFormat ?? 'unknown', row.observed_at);
          }
          cursor = row.id;
        }
        saveCursor.run(String(cursor));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }

  captureCrown() {
    const state = this.monitor?.snapshot();
    if (!this.crown || state?.mode !== 'live') return;
    const now = iso();
    const snapshot = this.crown.snapshot(state);
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
        const valid = healthy && raw.status === 'open' && ['parsed', 'incomplete_odds'].includes(raw.parseStatus) && fresh(raw.checkedAt, Math.max(90000, (this.crown.config?.intervalMs ?? 0) * 3));
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
        this.recordCrown(record);
      }
    }
  }

  recordCrown(candidate) {
    const changes = candidate.sides.map(side => {
      const price = numeric(side.price);
      const valid = price !== null && price !== 0 && numeric(side.decimalOdds) > 1;
      const oddsFormat = side.oddsFormat ?? 'unknown';
      const lastKey = crownSideKey(candidate.eventId, candidate.marketId, side.tokenId);
      const previous = this.crownLastValid.get(lastKey) ?? null;
      return { side, price: valid ? price : null, valid, oddsFormat, lastKey, previous,
        changed: valid && (!previous || price !== previous.price || oddsFormat !== previous.oddsFormat) };
    });
    if (!changes.some(item => item.changed)) return;
    const record = {
      ...candidate, kind: changes.some(item => item.changed && item.previous) ? 'change' : 'baseline',
      sides: changes.map(({ side, price, oddsFormat, previous }) => ({
        ...side, price, oddsFormat,
        previousPrice: previous?.price ?? null,
        delta: previous?.oddsFormat === oddsFormat ? difference(price, previous.price) : null,
      })),
    };
    for (const item of changes) if (item.valid) this.crownLastValid.set(item.lastKey, { price: item.price, oddsFormat: item.oddsFormat });
    this.queue.push({ ...record, crownPrice: true, payload: JSON.stringify(record) });
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
      for (const row of rows) {
        this.insert.run(row.source, row.eventId, row.marketId, row.type, row.observedAt, row.payload);
        if (row.polAsk) {
          const id = Number(this.db.prepare('SELECT last_insert_rowid() AS id').get().id);
          this.insertPolAskHistory.run(id, row.eventId, row.marketId, row.type, row.observedAt, row.payload);
          for (const side of row.sides) if (side.price !== null) {
            this.upsertPolAskLast.run(row.eventId, row.marketId, side.tokenId, side.price, row.observedAt);
          }
          this.db.prepare(`INSERT INTO metadata(key,value) VALUES('polAskHistoryCursor',?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(id));
        }
        if (row.crownPrice) {
          const id = Number(this.db.prepare('SELECT last_insert_rowid() AS id').get().id);
          this.insertCrownHistory.run(id, row.eventId, row.marketId, row.type, row.observedAt, row.payload);
          for (const side of row.sides) if (side.price !== null) {
            this.upsertCrownLast.run(row.eventId, row.marketId, side.tokenId, side.price, side.oddsFormat ?? 'unknown', row.observedAt);
          }
          this.db.prepare(`INSERT INTO metadata(key,value) VALUES('crownPriceHistoryCursor',?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(id));
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.queue.splice(0, rows.length);
    this.error = null;
    this.emit('change', { count: rows.length, observedAt: rows.at(-1).observedAt });
  }

  history({ eventId, type, marketId, source, limit = 50, before } = {}) {
    this.guard(() => this.flush());
    const where = [], args = [];
    for (const [column, value] of [['event_id', eventId], ['type', type], ['market_id', marketId]]) {
      if (value !== undefined && value !== null && value !== '') { where.push(`${column} = ?`); args.push(String(value)); }
    }
    const cursor = Number(before);
    const count = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
    const filters = where.length ? ` AND ${where.join(' AND ')}` : '';
    let query, queryArgs;
    if (source === 'pol') {
      query = `SELECT record_id AS id,payload FROM pol_ask_history WHERE 1=1${filters}${before !== undefined && Number.isSafeInteger(cursor) && cursor > 0 ? ' AND record_id < ?' : ''} ORDER BY record_id DESC LIMIT ?`;
      queryArgs = [...args];
      if (before !== undefined && Number.isSafeInteger(cursor) && cursor > 0) queryArgs.push(cursor);
    } else if (source === 'crown') {
      query = `SELECT record_id AS id,payload FROM crown_price_history WHERE 1=1${filters}${before !== undefined && Number.isSafeInteger(cursor) && cursor > 0 ? ' AND record_id < ?' : ''} ORDER BY record_id DESC LIMIT ?`;
      queryArgs = [...args];
      if (before !== undefined && Number.isSafeInteger(cursor) && cursor > 0) queryArgs.push(cursor);
    } else if (source) {
      query = `SELECT id,payload FROM price_records WHERE source=?${filters}${before !== undefined && Number.isSafeInteger(cursor) && cursor > 0 ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ?`;
      queryArgs = [String(source), ...args];
      if (before !== undefined && Number.isSafeInteger(cursor) && cursor > 0) queryArgs.push(cursor);
    } else {
      const cursorFilter = before !== undefined && Number.isSafeInteger(cursor) && cursor > 0 ? ' AND id < ?' : '';
      query = `SELECT id,payload FROM price_records WHERE source NOT IN ('pol','crown')${filters}${cursorFilter}
        UNION ALL SELECT record_id AS id,payload FROM pol_ask_history WHERE 1=1${filters}${before !== undefined && Number.isSafeInteger(cursor) && cursor > 0 ? ' AND record_id < ?' : ''}
        UNION ALL SELECT record_id AS id,payload FROM crown_price_history WHERE 1=1${filters}${before !== undefined && Number.isSafeInteger(cursor) && cursor > 0 ? ' AND record_id < ?' : ''}
        ORDER BY id DESC LIMIT ?`;
      queryArgs = [...args];
      if (before !== undefined && Number.isSafeInteger(cursor) && cursor > 0) queryArgs.push(cursor);
      queryArgs.push(...args);
      if (before !== undefined && Number.isSafeInteger(cursor) && cursor > 0) queryArgs.push(cursor);
      queryArgs.push(...args);
      if (before !== undefined && Number.isSafeInteger(cursor) && cursor > 0) queryArgs.push(cursor);
    }
    queryArgs.push(count + 1);
    const rows = this.db.prepare(query).all(...queryArgs);
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
