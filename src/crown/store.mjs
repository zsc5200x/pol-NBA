import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class CrownStore {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, payload TEXT NOT NULL, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS markets(key TEXT PRIMARY KEY, match_id TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, market_key TEXT NOT NULL, payload TEXT NOT NULL, observed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_lookup ON snapshots(market_key, observed_at);
      CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, status TEXT NOT NULL, code TEXT, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
  }
  upsertMatch(match) { this.db.prepare('INSERT INTO matches VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,checked_at=excluded.checked_at').run(match.id, JSON.stringify(match), match.checkedAt); }
  saveMarket(market, heartbeatMs = 300000) {
    const fingerprint = JSON.stringify([market.sides, market.status, market.parseStatus]);
    const old = this.db.prepare('SELECT fingerprint FROM markets WHERE key=?').get(market.key);
    const last = this.db.prepare('SELECT observed_at FROM snapshots WHERE market_key=? ORDER BY id DESC LIMIT 1').get(market.key);
    this.db.prepare('INSERT INTO markets VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,fingerprint=excluded.fingerprint,checked_at=excluded.checked_at').run(market.key, market.matchId, JSON.stringify(market), fingerprint, market.checkedAt);
    if (!old || old.fingerprint !== fingerprint || !last || Date.parse(market.checkedAt) - Date.parse(last.observed_at) >= heartbeatMs) this.db.prepare('INSERT INTO snapshots(market_key,payload,observed_at) VALUES(?,?,?)').run(market.key, JSON.stringify(market), market.checkedAt);
  }
  transaction(work) { this.db.exec('BEGIN IMMEDIATE'); try { work(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  task(operation, status, code = null) { this.db.prepare('INSERT INTO tasks(operation,status,code,observed_at) VALUES(?,?,?,?)').run(operation, status, code, new Date().toISOString()); }
  setMeta(key, value) { this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key, JSON.stringify(value)); }
  meta(key) { const row = this.db.prepare('SELECT payload FROM metadata WHERE key=?').get(key); return row ? JSON.parse(row.payload) : null; }
  matches() { return this.db.prepare('SELECT payload FROM matches ORDER BY checked_at DESC').all().map(row => JSON.parse(row.payload)); }
  markets(matchId) { return this.db.prepare('SELECT payload FROM markets WHERE match_id=? ORDER BY key').all(matchId).map(row => JSON.parse(row.payload)); }
  history(matchId, limit = 100) { return this.db.prepare('SELECT s.id,s.payload,s.observed_at FROM snapshots s JOIN markets m ON m.key=s.market_key WHERE m.match_id=? ORDER BY s.id DESC LIMIT ?').all(matchId, Math.max(1, Math.min(500, limit))).map(row => ({ id: row.id, ...JSON.parse(row.payload), observedAt: row.observed_at })); }
  tasks() { return this.db.prepare('SELECT operation,status,code,observed_at AS observedAt FROM tasks ORDER BY id DESC LIMIT 30').all(); }
  close() { this.db.close(); }
}
