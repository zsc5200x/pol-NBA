import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTradingSignal, SignalParseError } from '../src/trading/signal.mjs';

const signal = `🤣NBA美国职业篮球联赛
🤣犹他爵士 v 孟菲斯灰熊

📍 状态：早盘
玩法：让球
时段：全场
选择：孟菲斯灰熊 +1.5 @0.84

💰 原注金额：100
💲 跟单金额：0
🐦‍⬛跟单成功：0

来源后台：Hmbvs1799
来源会员：chfh67972
🧠单号：25594626127
🗓时间：10-26-2026 07:47:07`;

test('parses an NBA full-game spread signal and canonicalizes teams without resolving a token', () => {
  const result = parseTradingSignal(signal);
  assert.equal(result.sport, 'NBA');
  assert.deepEqual(result.teams.map(team => team.id), ['uta', 'mem']);
  assert.equal(result.marketType, 'spreads');
  assert.equal(result.period, 'full');
  assert.equal(result.selection.teamId, 'mem');
  assert.equal(result.selection.handicap, 1.5);
  assert.equal(result.selection.sourceOdds, 0.84);
  assert.equal(result.originalStake, 100);
  assert.equal(result.sourceCopyStake, 0);
  assert.equal(result.sourceFollowedAmount, 0);
  assert.equal(result.sourceBackend, 'Hmbvs1799');
  assert.equal(result.sourceMember, 'chfh67972');
  assert.equal(result.externalId, '25594626127');
  assert.equal(result.idempotencyKey, result.externalId);
  assert.equal(result.sourceTime.instant, '2026-10-25T23:47:07.000Z');
  assert.equal(Object.hasOwn(result.selection, 'tokenId'), false);
});

test('supports a signed away-team handicap and does not infer line sign from team position', () => {
  const changed = signal.replace('孟菲斯灰熊 +1.5', '犹他爵士 -1.5');
  const result = parseTradingSignal(changed);
  assert.equal(result.selection.teamId, 'uta');
  assert.equal(result.selection.handicap, -1.5);
});

test('rejects missing or unsupported sports, phase, market and ambiguous selection inputs', () => {
  const cases = [
    [signal.replace('NBA美国职业篮球联赛', 'WNBA'), 'UNSUPPORTED_LEAGUE'],
    [signal.replace('时段：全场', '时段：半场'), 'UNSUPPORTED_PERIOD'],
    [signal.replace('玩法：让球', '玩法：大小分'), 'UNSUPPORTED_MARKET'],
    [signal.replace('选择：孟菲斯灰熊 +1.5 @0.84', '选择：孟菲斯灰熊 1.5 @0.84'), 'INVALID_SELECTION'],
    [signal.replace('选择：孟菲斯灰熊 +1.5 @0.84', '选择：洛杉矶湖人 +1.5 @0.84'), 'SELECTION_TEAM_NOT_IN_MATCHUP'],
    [signal.replace('单号：25594626127', ''), 'MISSING_FIELD'],
    [signal.replace('时间：10-26-2026 07:47:07', '时间：2026-10-26T07:47:07Z'), 'INVALID_TIME'],
  ];
  for (const [text, code] of cases) assert.throws(() => parseTradingSignal(text), error => error instanceof SignalParseError && error.code === code);
});

test('rejects malformed odds, invalid dates, duplicate conflicting fields and repeated matchups', () => {
  const cases = [
    [signal.replace('@0.84', '@0'), 'INVALID_SOURCE_ODDS'],
    [signal.replace('10-26-2026 07:47:07', '02-30-2026 07:47:07'), 'INVALID_OR_AMBIGUOUS_TIME'],
    [signal.replace('跟单金额：0', '跟单金额：10\n跟单金额：20'), 'CONFLICTING_FIELD'],
    [signal.replace('🤣犹他爵士 v 孟菲斯灰熊', '🤣犹他爵士 v 孟菲斯灰熊\n犹他爵士 v 孟菲斯灰熊'), 'DUPLICATE_MATCHUP'],
    [signal.replace('选择：孟菲斯灰熊 +1.5 @0.84', '选择：未识别球队 +1.5 @0.84'), 'UNKNOWN_SELECTION_TEAM'],
  ];
  for (const [text, code] of cases) assert.throws(() => parseTradingSignal(text), error => error instanceof SignalParseError && error.code === code);
});

test('source time conversion requires an unambiguous configured timezone', () => {
  assert.throws(() => parseTradingSignal(signal, { timeZone: 'Not/AZone' }), error => error.code === 'INVALID_OR_AMBIGUOUS_TIME');
});
