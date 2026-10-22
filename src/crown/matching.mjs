import { TEAMS, eventTeams, spreadDetails, totalLine, teamFor } from '../../public/chinese.js';

const aliases = {
 '克里夫兰骑士':'cle','克里夫蘭騎士':'cle','克利夫蘭騎士':'cle','費城76人':'phi','費城七十六人':'phi','费城七十六人':'phi',
 '洛杉磯湖人':'lal','洛杉磯快艇':'lac','洛杉矶快艇':'lac','金州勇士':'gsw','波士頓塞爾提克':'bos','波士顿塞尔提克':'bos',
 '紐約尼克':'nyk','纽约尼克':'nyk','布魯克林籃網':'bkn','多倫多暴龍':'tor','多伦多暴龙':'tor','密爾瓦基公鹿':'mil','密尔沃基公鹿':'mil',
 '亞特蘭大老鷹':'atl','夏洛特黃蜂':'cha','芝加哥公牛':'chi','達拉斯獨行俠':'dal','丹佛金塊':'den','丹佛金块':'den',
 '底特律活塞':'det','休士頓火箭':'hou','休士顿火箭':'hou','印第安納溜馬':'ind','印第安纳溜马':'ind','曼菲斯灰熊':'mem',
 '邁阿密熱火':'mia','明尼蘇達灰狼':'min','明尼苏达灰狼':'min','紐奧良鵜鶘':'nop','紐奧良塘鵝':'nop','新奥尔良塘鹅':'nop',
 '奧克拉荷馬雷霆':'okc','奧克拉荷馬城雷霆':'okc','俄克拉荷马雷霆':'okc','奧蘭多魔術':'orl','鳳凰城太陽':'phx','凤凰城太阳':'phx',
 '波特蘭拓荒者':'por','波特兰拓荒者':'por','沙加緬度國王':'sac','沙加缅度国王':'sac','聖安東尼奧馬刺':'sas','猶他爵士':'uta','華盛頓巫師':'was','华盛顿巫师':'was',
};
const clean = value => String(value ?? '').replace(/\s+/g, '').replace(/队$/, '').toLowerCase();
export function teamId(value, custom = {}) {
  const direct = teamFor(value);
  if (direct) return direct.id;
  const name = clean(value);
  const extra = [...Object.entries(aliases), ...Object.entries(custom)].find(([alias]) => clean(alias) === name)?.[1];
  if (extra && TEAMS.some(t => t.id === extra)) return extra;
  return TEAMS.find(t => [t.name, t.short, ...t.aliases].some(alias => clean(alias) === name))?.id ?? null;
}
export function matchEvent(match, events, { toleranceMinutes = 15, teamAliases = {} } = {}) {
  const home = teamId(match.home, teamAliases), away = teamId(match.away, teamAliases);
  if (!home || !away || home === away || !Number.isFinite(Date.parse(match.startTime))) return { status: 'unmatched', reason: '球队或时间无法识别' };
  const candidates = events.filter(event => {
    const teams = eventTeams(event).map(t => t.id);
    return teams.length === 2 && teams.includes(home) && teams.includes(away) && Math.abs(Date.parse(event.startTime) - Date.parse(match.startTime)) <= Math.min(60, Math.max(0, toleranceMinutes)) * 60000;
  });
  if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous' : 'unmatched', reason: candidates.length ? '存在多场同队伍时间候选，需人工核对' : '当前 Polymarket 范围内无同队伍同时间比赛' };
  return { status: 'matched', event: candidates[0], homeId: home, awayId: away };
}
function mappedLine(market, homeId, awayId) {
  if (market.type === 'moneyline') return null;
  if (market.type === 'totals') { const n = totalLine(market); return n ? Number(n) : undefined; }
  const d = spreadDetails(market);
  if (!d || ![homeId, awayId].includes(d.team.id)) return undefined;
  return d.team.id === homeId ? d.line : -d.line;
}
export function compareMarkets(match, crownMarkets, polState, options = {}) {
  if (polState.mode !== 'live') return { status: 'unmatched', reason: '模拟行情不参与真实跨平台比较', markets: [] };
  const linked = matchEvent(match, polState.events ?? [], options);
  if (linked.status !== 'matched') return { ...linked, markets: [] };
  const event = linked.event;
  const comparisons = crownMarkets.map(crown => {
    const candidates = event.markets.filter(p => p.type === crown.type && mappedLine(p, linked.homeId, linked.awayId) === crown.line);
    const pol = candidates.length === 1 ? candidates[0] : null;
    return { crownKey: crown.key, type: crown.type, line: crown.line,
      status: !candidates.length ? 'line_unmatched' : candidates.length > 1 ? 'ambiguous' : 'matched', polMarketId: pol?.id ?? null,
      sides: crown.sides.map(side => {
        const identity = side.direction === 'home' ? linked.homeId : side.direction === 'away' ? linked.awayId : side.direction;
        const outcome = pol?.outcomes.find(o => crown.type === 'totals' ? /^over\b|大于/i.test(o.name) ? identity === 'over' : /^under\b|小于/i.test(o.name) && identity === 'under' : teamId(o.name, options.teamAliases) === identity);
        const book = outcome && polState.books?.[outcome.tokenId];
        const polFresh = book && book.source === 'live' && !book.error && Date.now() - Date.parse(book.verifiedAt ?? book.updatedAt) <= 30000;
        const crownFresh = Date.now() - Date.parse(crown.checkedAt) <= (options.staleMs ?? 90000);
        const comparable = options.collectionHealthy !== false && polFresh && crownFresh && !pol?.closed && crown.status === 'open' && crown.parseStatus === 'parsed' && side.decimalOdds > 1 && outcome;
        const ask = polFresh ? book.asks?.[0]?.price ?? null : null;
        const bid = polFresh ? book.bids?.[0]?.price ?? null : null;
        const impliedProbability = side.decimalOdds > 1 ? 1 / side.decimalOdds : null;
        return { ...side, impliedProbability, polTokenId: outcome?.tokenId ?? null, polAsk: ask, polBid: bid,
          polAskDecimal: ask > 0 ? 1 / ask : null, differencePoints: comparable && ask !== null && ask > 0 ? (impliedProbability - ask) * 100 : null,
          comparisonStatus: !outcome ? 'outcome_unmatched' : !crownFresh || !polFresh ? 'stale' : comparable ? 'comparable_quote' : 'unavailable' };
      }) };
  });
  return { status: 'matched', polEventId: event.id, markets: comparisons };
}
