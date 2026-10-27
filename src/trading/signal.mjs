import { teamFor } from '../../public/chinese.js';
import { parseStartTime } from '../crown/parser.mjs';

export class SignalParseError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SignalParseError';
    this.code = code;
  }
}

const normalizeKey = value => String(value).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const cleanDecorations = value => String(value).trim().replace(/^[^\p{L}\p{N}]+/u, '').trim();

function parseFields(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) {
    throw new SignalParseError('INVALID_MESSAGE');
  }
  const fields = new Map();
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(cleanDecorations).filter(Boolean);
  let league = null;
  let matchup = null;
  for (const line of lines) {
    if (!league && /^NBA(?:\b|[\p{Script=Han}])/iu.test(line)) league = line;
    const parsed = line.match(/^([^:：]+)\s*[:：]\s*(.*)$/u);
    if (!parsed) {
      const game = line.match(/^(.+?)\s+(?:v|vs\.?|versus)\s+(.+)$/iu)
        ?? line.match(/^(.+?)\s*对阵\s*(.+)$/u);
      if (game) {
        if (matchup) throw new SignalParseError('DUPLICATE_MATCHUP');
        matchup = [game[1].trim(), game[2].trim()];
      }
      continue;
    }
    const key = normalizeKey(cleanDecorations(parsed[1]));
    if (!key) continue;
    const value = parsed[2].trim();
    if (fields.has(key) && fields.get(key) !== value) throw new SignalParseError('CONFLICTING_FIELD', `conflicting ${key}`);
    fields.set(key, value);
  }
  return { fields, league, matchup };
}

function required(fields, key) {
  const value = fields.get(key);
  if (typeof value !== 'string' || !value.trim()) throw new SignalParseError('MISSING_FIELD', key);
  return value.trim();
}

function decimal(value, { allowZero = false } = {}) {
  const cleaned = String(value).replace(/[，,]/g, '').trim();
  if (!/^(?:\d+)(?:\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : null;
}

function parseSelection(value) {
  const match = value.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*@\s*(\d+(?:\.\d+)?)$/u);
  if (!match) throw new SignalParseError('INVALID_SELECTION');
  const team = teamFor(match[1].trim());
  const handicap = Number(match[2]);
  const sourceOdds = Number(match[3]);
  if (!team || !Number.isFinite(handicap) || Math.abs(handicap) > 100) throw new SignalParseError('UNKNOWN_SELECTION_TEAM');
  if (!Number.isFinite(sourceOdds) || sourceOdds <= 0 || sourceOdds > 100) throw new SignalParseError('INVALID_SOURCE_ODDS');
  return { team, handicap, sourceOdds };
}

function parseTime(value, timeZone) {
  const match = value.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/u);
  if (!match) throw new SignalParseError('INVALID_TIME');
  const [, month, day, year, hour, minute, second] = match;
  const localTime = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  const instant = parseStartTime(localTime, timeZone);
  if (!instant) throw new SignalParseError('INVALID_OR_AMBIGUOUS_TIME');
  return { text: value, timeZone, instant };
}

/**
 * Parse the signal source's NBA full-game spread format. This returns team/line
 * identity only; it deliberately does not resolve a Polymarket token.
 */
export function parseTradingSignal(text, { timeZone = 'Asia/Shanghai' } = {}) {
  const { fields, league, matchup } = parseFields(text);
  if (!league) throw new SignalParseError('UNSUPPORTED_LEAGUE');
  if (!matchup) throw new SignalParseError('MISSING_MATCHUP');

  const teams = matchup.map(name => teamFor(name));
  if (teams.some(team => !team) || teams[0].id === teams[1].id) throw new SignalParseError('UNKNOWN_OR_AMBIGUOUS_MATCHUP');

  const session = required(fields, '状态');
  if (!['早盘', '今日'].includes(session)) throw new SignalParseError('UNSUPPORTED_SESSION');
  const marketType = required(fields, '玩法');
  if (!['让球', '让分'].includes(marketType)) throw new SignalParseError('UNSUPPORTED_MARKET');
  const period = required(fields, '时段');
  if (period !== '全场') throw new SignalParseError('UNSUPPORTED_PERIOD');

  const selection = parseSelection(required(fields, '选择'));
  if (!teams.some(team => team.id === selection.team.id)) throw new SignalParseError('SELECTION_TEAM_NOT_IN_MATCHUP');
  const externalId = required(fields, '单号');
  if (externalId.length > 100 || /\s/u.test(externalId)) throw new SignalParseError('INVALID_EXTERNAL_ID');
  const sourceTime = parseTime(required(fields, '时间'), timeZone);

  const originalStake = decimal(required(fields, '原注金额'));
  if (originalStake === null) throw new SignalParseError('INVALID_ORIGINAL_STAKE');
  const copyStakeText = fields.get('跟单金额');
  const copyStake = copyStakeText === undefined ? null : decimal(copyStakeText, { allowZero: true });
  if (copyStakeText !== undefined && copyStake === null) throw new SignalParseError('INVALID_COPY_STAKE');
  const followedText = fields.get('跟单成功');
  const followed = followedText === undefined ? null : decimal(followedText, { allowZero: true });
  if (followedText !== undefined && followed === null) throw new SignalParseError('INVALID_FOLLOWED_AMOUNT');

  return {
    sport: 'NBA',
    teams: teams.map(team => ({ id: team.id, name: team.english, sourceName: team.name })),
    marketType: 'spreads',
    period: 'full',
    session,
    selection: {
      teamId: selection.team.id,
      teamName: selection.team.english,
      teamSourceName: selection.team.name,
      handicap: selection.handicap,
      sourceOdds: selection.sourceOdds,
    },
    originalStake,
    sourceCopyStake: copyStake,
    sourceFollowedAmount: followed,
    sourceBackend: fields.get('来源后台') ?? null,
    sourceMember: fields.get('来源会员') ?? null,
    externalId,
    idempotencyKey: externalId,
    sourceTime,
  };
}
