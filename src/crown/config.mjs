import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { CrownError } from './parser.mjs';

export const ENDPOINT = 'https://m321.mos077.com/transform.php';
export const CORE = {
 today: { p: 'get_game_list', gtype: 'bk', showtype: 'today', ltype: '3' },
 early: { p: 'get_game_list', gtype: 'bk', showtype: 'early', ltype: '3', date: 'all', lid: '100828', action: 'click_league' },
};
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new CrownError('CONFIG_UNREADABLE'); }
}
export async function verifyEvidence(evidence, base) {
  if (!evidence?.path || !/^[a-f0-9]{64}$/i.test(evidence.sha256 ?? '') || !Number.isFinite(Date.parse(evidence.reviewedAt))) throw new CrownError('MAPPING_UNVERIFIED');
  let data;
  try { data = await readFile(resolve(base, evidence.path)); } catch { throw new CrownError('EVIDENCE_MISSING'); }
  if (createHash('sha256').update(data).digest('hex') !== evidence.sha256.toLowerCase()) throw new CrownError('EVIDENCE_CHANGED');
}
export async function loadConfig(filename) {
  const path = resolve(filename), base = dirname(path);
  const config = await readJson(path);
  if (config.endpoint !== ENDPOINT || !config.sessionFile) throw new CrownError('INVALID_CONFIG');
  const profiles = [config.lists?.today, config.lists?.early, ...(config.details?.today ?? []), ...(config.details?.early ?? [])];
  if (profiles.slice(0, 2).some(p => !p) || !config.details?.today?.length || !config.details?.early?.length) throw new CrownError('MAPPING_UNVERIFIED');
  for (const profile of profiles) {
    if (!profile.reviewed) throw new CrownError('MAPPING_UNVERIFIED');
    await verifyEvidence(profile.evidence, base);
    if (profile.timeZone) await verifyEvidence(profile.timeZoneEvidence, base);
    if (profile.params?.p && !['get_game_list', 'get_game_more'].includes(profile.params.p)) throw new CrownError('READ_ONLY_ONLY');
  }
  for (const mode of ['today', 'early']) {
    for (const [operation, profile] of [['get_game_list', config.lists[mode]], ...config.details[mode].map(profile => ['get_game_more', profile])]) {
      await verifyEvidence(profile.requestEvidence, base);
      const captured = await readJson(resolve(base, profile.requestEvidence.path));
      if (captured.endpoint !== ENDPOINT || captured.method !== 'POST' || captured.params?.p !== operation || captured.params?.gtype !== 'bk' || captured.params?.showtype !== mode || String(captured.params?.ltype) !== '3') throw new CrownError('REQUEST_UNVERIFIED');
      if (operation === 'get_game_more' && (captured.params?.filter !== profile.params?.filter || !/^[A-Za-z0-9_-]{1,40}$/.test(profile.id ?? ''))) throw new CrownError('REQUEST_UNVERIFIED');
      for (const [key,value] of Object.entries(profile.params ?? {})) if (String(captured.params[key]) !== String(value)) throw new CrownError('REQUEST_UNVERIFIED');
      if (config.timestamp?.reviewed && !Object.hasOwn(captured.params, config.timestamp.field ?? '')) throw new CrownError('REQUEST_UNVERIFIED');
    }
    const p = config.lists[mode];
    if (!p.containerPath || !p.recordsPath || !p.fields || !Array.isArray(p.leagueNames) || !p.leagueNames.length || !['id', 'leagueId', 'league', 'home', 'away', 'startTime'].every(key => p.fields[key])) throw new CrownError('INVALID_MAPPING');
    for (const profile of config.details[mode]) {
      if (!profile.containerPath || !profile.id || !profile.params?.filter || !['today', 'early'].includes(profile.params.showtype) || profile.params.showtype !== mode || !profile.markets?.length) throw new CrownError('MAPPING_UNVERIFIED');
      for (const m of profile.markets) {
        m.fullGamePathVerified = false;
        if (!m.matchIdPath || !m.statusPath || !m.statusValues || !m.odds) throw new CrownError('INVALID_MAPPING');
        if (!m.phasePath || m.fullGameValue == null) {
          if (m.phase !== 'full') throw new CrownError('INVALID_MAPPING');
          await verifyEvidence(m.phaseEvidence, base); m.fullGamePathVerified = true;
        }
      }
    }
  }
  if (![config.intervalMs ?? 30000, config.requestGapMs ?? 1000, config.timeoutMs ?? 15000].every(value => Number.isFinite(Number(value)) && Number(value) > 0)) throw new CrownError('INVALID_CONFIG');
  if (config.timestamp?.reviewed && !['seconds','milliseconds'].includes(config.timestamp.unit)) throw new CrownError('INVALID_CONFIG');
  const intervalMs = Math.min(86400000, Math.max(10000, Number(config.intervalMs) || 30000));
  const requestGapMs = Math.max(500, Number(config.requestGapMs) || 1000);
  return { ...config, intervalMs, requestGapMs, timeoutMs: Math.min(60000, Math.max(1000, Number(config.timeoutMs) || 15000)), sessionFile: resolve(base, config.sessionFile), base };
}
export async function loadSession(path) {
  let info;
  try { info = await stat(path); } catch { throw new CrownError('SESSION_MISSING'); }
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new CrownError('SESSION_PERMISSIONS');
  const session = await readJson(path);
  if (typeof session.params?.uid !== 'string' || !session.params.uid.trim() || typeof session.params?.ver !== 'string' || !session.params.ver.trim() || typeof session.cookie !== 'string' || !session.cookie.trim()) throw new CrownError('SESSION_MISSING');
  if (/\r|\n/.test(session.cookie)) throw new CrownError('INVALID_CONFIG');
  return session;
}
