import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseMarkets } from '../src/crown/parser.mjs';
import { ENDPOINT, loadConfig } from '../src/crown/config.mjs';

const capture = async name => JSON.parse(await readFile(new URL(`./fixtures/crown/${name}.json`, import.meta.url), 'utf8'));
const match = (id = '10635242', familyId = '1540749') => ({ id, familyId });
const profile = () => {
  const base = {
    recordsPath: 'response.GAMES.*', matchReference: 'familyId', matchIdPath: 'GIDM',
    phasePath: 'MS', fullGameValue: '', rowStatusPath: 'GOPEN', rowStatusValues: { Y: 'open', N: 'closed' },
    statusValues: { Y: 'open', N: 'closed' }, oddsFormat: 'hongkong', skipEmptyLine: true,
  };
  return { id: 'captured-main', markets: [
    { ...base, type: 'spreads', linePath: 'PLAYS.R.RATIO_R', favoritePath: 'STRONG', favoriteValues: { H: 'home', C: 'away' },
      statusPath: 'PLAYS.R.SW_R', odds: { home: 'PLAYS.R.IOR_RH', away: 'PLAYS.R.IOR_RC' } },
    { ...base, type: 'totals', linePath: 'PLAYS.OU.RATIO_OUO', oppositeLinePath: 'PLAYS.OU.RATIO_OUU',
      statusPath: 'PLAYS.OU.SW_OU', odds: { over: 'PLAYS.OU.IOR_OUC', under: 'PLAYS.OU.IOR_OUH' } },
    { recordsPath: base.recordsPath, type: 'moneyline', matchIdPath: 'GID', phasePath: 'IS_MASTER', fullGameValue: 'Y',
      rowStatusPath: base.rowStatusPath, rowStatusValues: base.rowStatusValues, statusValues: base.statusValues,
      statusPath: 'PLAYS.M.SW_M', oddsFormat: 'decimal', odds: { home: 'PLAYS.M.IOR_MH', away: 'PLAYS.M.IOR_MC' } },
  ] };
};
const onlyMain = root => ({ response: { GAMES: { GAME0: structuredClone(root.response.GAMES.GAME0) } } });
const byType = (result, type) => result.markets.filter(market => market.type === type);

test('captured today response yields three full-game spreads, three totals and only the master moneyline', async () => {
  const result = parseMarkets(await capture('extra-today'), profile(), match(), 'today');
  assert.deepEqual(result.issues, []);
  assert.equal(result.markets.length, 7);
  assert.deepEqual(byType(result, 'spreads').map(m => m.line).sort((a, b) => a - b), [-4.5, -3.5, -2.5]);
  assert.deepEqual(byType(result, 'totals').map(m => m.line).sort((a, b) => a - b), [234.5, 235.5, 236.5]);
  assert.ok(result.markets.every(m => m.phase === 'full' && m.matchId === '10635242' && m.status === 'open' && m.parseStatus === 'parsed'));
  assert.deepEqual(byType(result, 'spreads').find(m => m.line === -4.5).sides.map(s => [s.direction, s.line, s.rawOdds]), [['home', -4.5, '1.080'], ['away', 4.5, '0.780']]);
  for (const [line, over, under] of [[236.5, '0.950', '0.890'], [235.5, '0.850', '0.990'], [234.5, '0.750', '1.090']]) {
    assert.deepEqual(byType(result, 'totals').find(m => m.line === line).sides.map(s => [s.direction, s.line, s.rawOdds]), [['over', line, over], ['under', line, under]]);
  }
  assert.deepEqual(byType(result, 'moneyline')[0].sides.map(s => s.rawOdds), ['1.640', '2.300']);
});

test('documented today and early market mappings agree with the captured-response regression rules', async () => {
  const example = JSON.parse(await readFile(new URL('../config/crown.example.json', import.meta.url), 'utf8'));
  for (const mode of ['today', 'early']) {
    assert.deepEqual(example.details[mode][0].markets, profile().markets);
  }
});

test('captured early placeholders do not invent zero handicaps, extra totals or collector failures', async () => {
  const result = parseMarkets(await capture('extra-early'), profile(), match('10636894', '1540985'), 'early');
  assert.deepEqual(result.issues, []);
  assert.equal(result.markets.length, 3);
  assert.deepEqual(byType(result, 'spreads').map(m => m.line), [-2]);
  assert.deepEqual(byType(result, 'totals').map(m => m.line), [224.5]);
  assert.equal(byType(result, 'moneyline')[0].status, 'closed');
  assert.equal(result.markets.filter(m => m.status === 'open' && m.parseStatus === 'parsed').length, 2);
});

test('captured away favorite uses positive home handicap and negative away handicap with the correct side prices', async () => {
  const result = parseMarkets(await capture('extra-away-favorite'), profile(), match('10636915', '1540988'), 'early');
  assert.deepEqual(result.issues, []);
  const spread = byType(result, 'spreads')[0];
  assert.equal(spread.line, 4.5);
  assert.deepEqual(spread.sides.map(s => [s.direction, s.line, s.rawOdds]), [['home', 4.5, '0.970'], ['away', -4.5, '0.890']]);
});

test('family and phase must both match; blank phase does not accept absent phase or unrelated records', async () => {
  const payload = await capture('extra-today');
  const wrongFamily = parseMarkets(payload, profile(), match('other-id', 'other-family'), 'today');
  assert.deepEqual(wrongFamily.markets, []);
  assert.deepEqual(parseMarkets(payload, profile(), { id: 'other-id' }, 'today').markets, []);
  const main = onlyMain(payload);
  delete main.response.GAMES.GAME0.MS;
  const result = parseMarkets(main, profile(), match(), 'today');
  assert.equal(byType(result, 'spreads').length, 0);
  assert.equal(byType(result, 'totals').length, 0);
});

test('zero spreads stay pick-em while negative magnitudes and unknown favorite flags are rejected', async () => {
  const payload = onlyMain(await capture('extra-today'));
  const row = payload.response.GAMES.GAME0;
  row.PLAYS.R.RATIO_R = '0';
  for (const favorite of ['H', 'C']) {
    row.STRONG = favorite;
    const spread = byType(parseMarkets(payload, profile(), match(), 'today'), 'spreads')[0];
    assert.equal(spread.line, 0);
    assert.deepEqual(spread.sides.map(side => side.line), [0, 0]);
  }
  row.PLAYS.R.RATIO_R = '-4.5';
  let result = parseMarkets(payload, profile(), match(), 'today');
  assert.equal(byType(result, 'spreads').length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'INVALID_LINE'));
  row.PLAYS.R.RATIO_R = '4.5';
  row.STRONG = '?';
  result = parseMarkets(payload, profile(), match(), 'today');
  assert.equal(byType(result, 'spreads').length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'DIRECTION_UNVERIFIED'));
});

test('row closure cannot be overridden by enabled market switches and unknown row status never becomes open', async () => {
  const payload = onlyMain(await capture('extra-today'));
  payload.response.GAMES.GAME0.GOPEN = 'N';
  assert.ok(parseMarkets(payload, profile(), match(), 'today').markets.every(market => market.status === 'closed'));
  for (const marker of ['?', 'toString']) {
    payload.response.GAMES.GAME0.GOPEN = marker;
    assert.ok(parseMarkets(payload, profile(), match(), 'today').markets.every(market => market.status === 'unknown' && market.parseStatus === 'status_unverified'));
  }
});

test('empty lines with nonzero quotes, open status, missing fields or malformed prices remain issues', async () => {
  const payload = await capture('extra-early');
  const placeholder = payload.response.GAMES.GAME7;
  for (const mutate of [
    row => { row.PLAYS.R.IOR_RH = '0.9'; },
    row => { row.GOPEN = 'Y'; },
    row => { delete row.PLAYS.R.RATIO_R; },
    row => { row.PLAYS.R.IOR_RH = 'invalid'; },
  ]) {
    const row = structuredClone(placeholder); mutate(row);
    const result = parseMarkets({ response: { GAMES: { GAME7: row } } }, profile(), match('10636894', '1540985'), 'early');
    assert.equal(byType(result, 'spreads').length, 0);
    assert.ok(result.issues.some(issue => issue.code === 'MISSING_LINE'));
  }
});

test('over and under must report the same total; differing or absent opposite line is never combined', async () => {
  const payload = onlyMain(await capture('extra-today'));
  for (const value of ['236.5', '', 'bad']) {
    payload.response.GAMES.GAME0.PLAYS.OU.RATIO_OUU = value;
    const result = parseMarkets(payload, profile(), match(), 'today');
    assert.equal(byType(result, 'totals').length, 0);
    assert.ok(result.issues.some(issue => issue.code === 'CONFLICTING_LINE'));
  }
});

async function configFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crown-extra-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writeEvidence = async (name, body) => {
    const text = JSON.stringify(body);
    await writeFile(join(dir, name), text);
    return { path: name, sha256: createHash('sha256').update(text).digest('hex'), reviewedAt: new Date().toISOString() };
  };
  const evidence = await writeEvidence('response.json', await capture('extra-today'));
  const config = { endpoint: ENDPOINT, lists: {}, details: {} };
  for (const mode of ['today', 'early']) {
    config.lists[mode] = {
      containerPath: 'response', recordsPath: 'response.GAMES.*', reviewed: true, evidence,
      fields: { id: 'GID', leagueId: 'LEAGUE_ID', league: 'LEAGUE', home: 'TEAM_H', away: 'TEAM_C', startTime: 'DATETIME' },
      leagueNames: ['NBA美国职业篮球联赛'],
      requestEvidence: await writeEvidence(`request-list-${mode}.json`, { endpoint: ENDPOINT, method: 'POST', params: { p: 'get_game_list', gtype: 'bk', showtype: mode, ltype: '3' } }),
    };
    const params = { filter: 'Main', showtype: mode };
    config.details[mode] = [{ ...profile(), containerPath: 'response', reviewed: true, evidence, params,
      requestEvidence: await writeEvidence(`request-more-${mode}.json`, { endpoint: ENDPOINT, method: 'POST', params: { p: 'get_game_more', gtype: 'bk', ltype: '3', ...params } }),
    }];
  }
  const path = join(dir, 'config.json');
  const save = () => writeFile(path, JSON.stringify(config));
  await save();
  return { config, path, save };
}

test('configuration accepts reviewed empty full-game phase and validates alternative-line direction/status controls', async t => {
  const fixture = await configFixture(t);
  const loaded = await loadConfig(fixture.path);
  assert.equal(loaded.details.today[0].markets[0].fullGameValue, '');
  assert.equal(loaded.details.today[0].markets[0].fullGamePathVerified, false);
  const original = structuredClone(fixture.config.details.today[0].markets);
  for (const mutate of [
    rules => { rules[0].favoriteValues.C = 'visitor'; },
    rules => { delete rules[0].favoritePath; },
    rules => { rules[0].lineReference = 'home'; },
    rules => { rules[0].rowStatusValues.N = 'enabled'; },
    rules => { delete rules[0].rowStatusValues; },
    rules => { rules[0].skipEmptyLine = 'yes'; },
    rules => { rules[0].matchReference = 'child'; },
    rules => { rules[1].oppositeLinePath = ''; },
    rules => { rules[1].favoritePath = 'STRONG'; rules[1].favoriteValues = { H: 'home' }; },
    rules => { rules[2].skipEmptyLine = true; },
  ]) {
    fixture.config.details.today[0].markets = structuredClone(original);
    mutate(fixture.config.details.today[0].markets);
    await fixture.save();
    await assert.rejects(loadConfig(fixture.path), /INVALID_MAPPING/);
  }
});
