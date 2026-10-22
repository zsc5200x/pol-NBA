import { XMLParser, XMLValidator } from 'fast-xml-parser';

export class CrownError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function decode(body) {
  const text = String(body).trim();
  if (!text || text.length > 8 * 1024 * 1024) throw new CrownError('EMPTY_OR_OVERSIZE');
  try {
    if (/^[\[{]/.test(text)) return JSON.parse(text);
    if (/<!DOCTYPE|<!ENTITY|<html\b|<script\b/i.test(text)) throw new CrownError('UNEXPECTED_RESPONSE');
    if (XMLValidator.validate(text) !== true) throw new CrownError('INVALID_RESPONSE');
    return new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, processEntities: false }).parse(text);
  } catch (error) { if (error instanceof CrownError) throw error; throw new CrownError('INVALID_RESPONSE'); }
}
export function at(root, path) {
  if (path === '$') return root;
  let values = [root];
  for (const segment of String(path ?? '').split('.').filter(Boolean)) {
    if (['__proto__', 'constructor', 'prototype'].includes(segment)) throw new CrownError('INVALID_MAPPING');
    values = values.flat(Infinity).flatMap(value => segment === '*' && value && typeof value === 'object' ? Object.values(value) : value?.[segment] === undefined ? [] : [value[segment]]);
  }
  return values.length === 1 ? values[0] : values.length ? values.flat(Infinity) : undefined;
}
export function scalar(root, path) {
  if (!path) return null;
  const value = at(root, path);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : null;
}
export function rows(root, path) {
  const value = at(root, path);
  return value === undefined || value === null ? [] : (Array.isArray(value) ? value.flat(Infinity) : [value]).filter(value => value && typeof value === 'object');
}
const numeric = value => value === null || value === undefined || String(value).trim() === '' ? null : /^[-+]?\d+(?:\.\d+)?$/.test(String(value).trim()) ? Number(value) : null;
export function decimalOdds(value, format) {
  const n = numeric(value);
  if (!Number.isFinite(n)) return null;
  if (format === 'decimal') return n > 1 ? n : null;
  if (format === 'hongkong') return n > 0 ? 1 + n : null;
  if (format === 'american') return n >= 100 ? 1 + n / 100 : n <= -100 ? 1 + 100 / Math.abs(n) : null;
  return null;
}
export function parseStartTime(value, timeZone) {
  if (!value) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match || !timeZone) return null;
  try {
    const target = match.slice(1).map(Number); const base = Date.UTC(target[0], target[1]-1, ...target.slice(2));
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
    const parts = ms => { const p=formatter.formatToParts(new Date(ms));return ['year','month','day','hour','minute','second'].map(key=>Number(p.find(x=>x.type===key).value)); };
    let guess=base;
    for(let i=0;i<3;i++){const p=parts(guess);guess+=base-Date.UTC(p[0],p[1]-1,...p.slice(2));}
    const valid=[];
    for(let delta=-7200000;delta<=7200000;delta+=1800000)if(parts(guess+delta).every((n,i)=>n===target[i]))valid.push(guess+delta);
    return valid.length===1?new Date(valid[0]).toISOString():null;
  } catch { return null; }
}
export function parseList(root, profile, mode, now = new Date().toISOString()) {
  if (profile.sourceModePath && scalar(root, profile.sourceModePath) !== mode) throw new CrownError('SOURCE_MODE_CONFLICT');
  const matches = new Map();
  const conflicts = new Set();
  const issues = [];
  for (const row of rows(root, profile.recordsPath)) {
    const field = name => scalar(row, profile.fields[name]);
    const leagueId = field('leagueId'), league = field('league');
    if (leagueId !== '100828' || !profile.leagueNames.includes(league)) continue;
    const id = field('id'), home = field('home'), away = field('away'), start = field('startTime');
    // An unzoned capture remains unusable unless a separately evidenced source timezone is configured.
    const startTime = parseStartTime(start, profile.timeZone);
    if (!id || !home || !away || home === away || !startTime) {
      issues.push({ code: 'INCOMPLETE_MATCH' }); continue;
    }
    if (profile.parentIdPath && scalar(row, profile.parentIdPath) !== id) { issues.push({ code: 'CHILD_MATCH_RECORD' }); continue; }
    const match = { id, familyId: field('familyId'), leagueId, league, home, away, startTime, status: profile.statusValues?.[field('status')] ?? 'unknown', sources: [mode], checkedAt: now };
    if (conflicts.has(id)) continue;
    const old = matches.get(id);
    if (old && (old.home !== home || old.away !== away || old.startTime !== match.startTime)) { issues.push({ code: 'CONFLICTING_MATCH', id }); matches.delete(id); conflicts.add(id); continue; }
    matches.set(id, match);
  }
  let more = false, next = null, paginationVerified = false;
  if (profile.pagination?.reviewed) {
    const p = profile.pagination;
    const marker = scalar(root, p.hasMorePath);
    if ((p.moreValues ?? []).map(String).includes(marker)) { more = true; next = scalar(root, p.nextPath); }
    else if ((p.endValues ?? []).map(String).includes(marker)) paginationVerified = true;
    else throw new CrownError('PAGINATION_UNKNOWN');
    if (more && !next) throw new CrownError('PAGINATION_UNKNOWN');
  }
  return { matches: [...matches.values()], issues, more, next, paginationVerified };
}
export function parseMarkets(root, profile, match, mode, now = new Date().toISOString()) {
  const markets = new Map(), issues = [];
  for (const mapping of profile.markets ?? []) {
    if (!['totals', 'spreads', 'moneyline'].includes(mapping.type)) throw new CrownError('INVALID_MAPPING');
    for (const row of rows(root, mapping.recordsPath)) {
      // Each rule must prove parent match and full-game phase from reviewed sample paths/values.
      const parentId = mapping.matchReference === 'familyId' ? match.familyId : match.id;
      if (!parentId || scalar(row, mapping.matchIdPath) !== parentId) continue;
      if (!mapping.fullGamePathVerified && scalar(row, mapping.phasePath) !== String(mapping.fullGameValue)) continue;
      const rawLine = mapping.type === 'moneyline' ? null : numeric(scalar(row, mapping.linePath));
      if (mapping.type !== 'moneyline' && (rawLine === null || !Number.isFinite(rawLine))) { issues.push({ code: 'MISSING_LINE', type: mapping.type }); continue; }
      if (mapping.type === 'totals' && rawLine <= 0) { issues.push({ code: 'INVALID_LINE', type: mapping.type }); continue; }
      if (mapping.type === 'spreads' && !['home', 'away'].includes(mapping.lineReference)) throw new CrownError('DIRECTION_UNVERIFIED');
      const line = mapping.type === 'spreads' && mapping.lineReference === 'away' ? -rawLine : rawLine;
      const key = `${match.id}:${mapping.type}:full:${line ?? ''}`;
      const statusMarker = scalar(row, mapping.statusPath);
      const status = mapping.statusValues?.[statusMarker] ?? 'unknown';
      const directions = mapping.type === 'totals' ? ['over', 'under'] : ['home', 'away'];
      const sides = directions.map(direction => {
        const candidate = scalar(row, mapping.odds?.[direction]);
        const rawOdds = numeric(candidate) === null ? null : candidate;
        return { direction, line: mapping.type === 'spreads' && direction === 'away' ? -line : line,
          rawOdds, decimalOdds: decimalOdds(rawOdds, mapping.oddsFormat), oddsFormat: mapping.oddsFormat ?? 'unknown' };
      });
      const market = { key, matchId: match.id, type: mapping.type, phase: 'full', line, sides, status,
        parseStatus: status === 'unknown' ? 'status_unverified' : sides.some(side => side.rawOdds === null || side.decimalOdds === null) ? 'incomplete_odds' : 'parsed',
        checkedAt: now, source: `crown:${mode}:${profile.id}`, sources: [mode] };
      const old = markets.get(key);
      if (old && JSON.stringify([old.sides, old.status]) !== JSON.stringify([market.sides, market.status])) { issues.push({ code: 'CONFLICTING_MARKET', key }); old.parseStatus = 'conflict'; old.status = 'unknown'; }
      else markets.set(key, market);
    }
  }
  return { markets: [...markets.values()], issues };
}
export function coverageFor(markets, evidence, now = Date.now()) {
  const result = {};
  for (const type of ['totals', 'spreads', 'moneyline']) {
    const actual = markets.filter(m => m.type === type).map(m => m.line === null ? 'moneyline' : String(m.line)).sort();
    const e = evidence?.[type];
    const fresh = e && Number.isFinite(Date.parse(e.observedAt)) && now - Date.parse(e.observedAt) <= 5 * 60 * 1000 && now >= Date.parse(e.observedAt);
    const expected = Array.isArray(e?.lines) ? e.lines.map(String).sort() : [];
    result[type] = { discovered: actual.length, status: !e || !fresh ? 'unverified' : JSON.stringify(actual) === JSON.stringify(expected) && !markets.some(m => m.type === type && ['conflict', 'incomplete_odds', 'status_unverified'].includes(m.parseStatus)) ? 'verified' : 'mismatch', expected: e ? expected.length : null };
  }
  return result;
}
