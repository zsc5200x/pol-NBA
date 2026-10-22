// Display-only mappings: original market IDs, asset IDs and prices remain unchanged.
export const TEAMS = [
  ['atl', 'Atlanta Hawks', '亚特兰大老鹰', '老鹰', '#e03a3e', ['Hawks', 'Atlanta']],
  ['bos', 'Boston Celtics', '波士顿凯尔特人', '凯尔特人', '#008348', ['Celtics', 'Boston']],
  ['bkn', 'Brooklyn Nets', '布鲁克林篮网', '篮网', '#777777', ['Nets', 'Brooklyn']],
  ['cha', 'Charlotte Hornets', '夏洛特黄蜂', '黄蜂', '#00b5bd', ['Hornets', 'Charlotte']],
  ['chi', 'Chicago Bulls', '芝加哥公牛', '公牛', '#ce1141', ['Bulls', 'Chicago']],
  ['cle', 'Cleveland Cavaliers', '克利夫兰骑士', '骑士', '#860038', ['Cavaliers', 'Cavs', 'Cleveland']],
  ['dal', 'Dallas Mavericks', '达拉斯独行侠', '独行侠', '#00538c', ['Mavericks', 'Mavs', 'Dallas']],
  ['den', 'Denver Nuggets', '丹佛掘金', '掘金', '#fec524', ['Nuggets', 'Denver']],
  ['det', 'Detroit Pistons', '底特律活塞', '活塞', '#c8102e', ['Pistons', 'Detroit']],
  ['gsw', 'Golden State Warriors', '金州勇士', '勇士', '#ffc72c', ['Warriors', 'Golden State']],
  ['hou', 'Houston Rockets', '休斯顿火箭', '火箭', '#ce1141', ['Rockets', 'Houston']],
  ['ind', 'Indiana Pacers', '印第安纳步行者', '步行者', '#fdbb30', ['Pacers', 'Indiana']],
  ['lac', 'Los Angeles Clippers', '洛杉矶快船', '快船', '#c8102e', ['Clippers', 'LA Clippers']],
  ['lal', 'Los Angeles Lakers', '洛杉矶湖人', '湖人', '#fdb927', ['Lakers', 'LA Lakers']],
  ['mem', 'Memphis Grizzlies', '孟菲斯灰熊', '灰熊', '#5d76a9', ['Grizzlies', 'Memphis']],
  ['mia', 'Miami Heat', '迈阿密热火', '热火', '#f9a01b', ['Heat', 'Miami']],
  ['mil', 'Milwaukee Bucks', '密尔沃基雄鹿', '雄鹿', '#47845d', ['Bucks', 'Milwaukee']],
  ['min', 'Minnesota Timberwolves', '明尼苏达森林狼', '森林狼', '#78be20', ['Timberwolves', 'Wolves', 'Minnesota']],
  ['nop', 'New Orleans Pelicans', '新奥尔良鹈鹕', '鹈鹕', '#b4975a', ['Pelicans', 'New Orleans']],
  ['nyk', 'New York Knicks', '纽约尼克斯', '尼克斯', '#f58426', ['Knicks', 'New York']],
  ['okc', 'Oklahoma City Thunder', '俄克拉荷马城雷霆', '雷霆', '#007ac1', ['Thunder', 'Oklahoma City']],
  ['orl', 'Orlando Magic', '奥兰多魔术', '魔术', '#0077c0', ['Magic', 'Orlando']],
  ['phi', 'Philadelphia 76ers', '费城76人', '76人', '#006bb6', ['76ers', 'Sixers', 'Philadelphia']],
  ['phx', 'Phoenix Suns', '菲尼克斯太阳', '太阳', '#e56020', ['Suns', 'Phoenix']],
  ['por', 'Portland Trail Blazers', '波特兰开拓者', '开拓者', '#e03a3e', ['Trail Blazers', 'Blazers', 'Portland']],
  ['sac', 'Sacramento Kings', '萨克拉门托国王', '国王', '#7c54ad', ['Kings', 'Sacramento']],
  ['sas', 'San Antonio Spurs', '圣安东尼奥马刺', '马刺', '#92999f', ['Spurs', 'San Antonio']],
  ['tor', 'Toronto Raptors', '多伦多猛龙', '猛龙', '#ce1141', ['Raptors', 'Toronto']],
  ['uta', 'Utah Jazz', '犹他爵士', '爵士', '#a0c5f7', ['Jazz', 'Utah']],
  ['was', 'Washington Wizards', '华盛顿奇才', '奇才', '#e31837', ['Wizards', 'Washington']],
].map(([id, english, name, short, color, aliases]) => ({ id, english, name, short, color, aliases: [english, ...aliases, id.toUpperCase()] }));

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliases = TEAMS.flatMap(team => team.aliases.map(alias => ({ alias, team }))).sort((a, b) => b.alias.length - a.alias.length);

export function teamFor(value) {
  const text = String(value ?? '').trim();
  return TEAMS.find(team => text === team.name || text === team.short) ??
    aliases.find(({ alias }) => alias.toLowerCase() === text.toLowerCase())?.team ?? null;
}

export function translateTeams(value) {
  const lookup = new Map(aliases.map(({ alias, team }) => [alias.toLowerCase(), team.name]));
  const pattern = new RegExp(`\\b(?:${aliases.map(({ alias }) => escape(alias)).join('|')})\\b`, 'gi');
  return String(value ?? '').replace(pattern, match => lookup.get(match.toLowerCase()));
}

export function eventTeams(event) {
  const title = String(event?.title ?? '');
  const parts = title.replace(/（演示）|\(demo\)/gi, '').split(/\s+(?:vs\.?|v\.?|versus|@|at|对阵)\s+/i);
  if (parts.length === 2) {
    const pair = parts.map(part => teamFor(part.trim()));
    if (pair.every(Boolean)) return pair;
  }
  const slug = String(event?.slug ?? '').match(/^nba-([a-z]{2,3})-([a-z]{2,3})-/);
  const codes = { no: 'nop', ny: 'nyk', gs: 'gsw', sa: 'sas', utah: 'uta', pho: 'phx' };
  if (slug) {
    const pair = slug.slice(1).map(id => TEAMS.find(team => team.id === (codes[id] ?? id)));
    if (pair.every(Boolean)) return pair;
  }
  return [];
}

export function eventTitle(event) {
  const teams = eventTeams(event);
  if (teams.length === 2) return `${teams[0].name} 对阵 ${teams[1].name}${/演示|demo/i.test(event.title) ? '（演示）' : ''}`;
  const translated = translateTeams(event?.title).replace(/\b(?:vs\.?|versus)\s*/gi, '对阵 ');
  return /[a-z]{2,}/i.test(translated) ? '篮球比赛（球队待识别）' : translated || '篮球比赛';
}

export const typeName = value => ({ moneyline: '胜负', spreads: '让分', spread: '让分', totals: '大小分', total: '大小分' })[value] ?? '其他盘口';

export function spreadDetails(market) {
  const text = String(market?.question ?? '');
  const match = text.match(/(?:Spread:\s*)?([^:·]+?)\s*[（(]([+-]?\d+(?:\.\d+)?)[）)]/i) ??
    text.match(/(?:Spread:\s*)?([^:·]+?)\s+([+-]\d+(?:\.\d+)?)(?:\s*·.*)?$/i);
  return match && teamFor(match[1].trim()) ? { team: teamFor(match[1].trim()), line: Number(match[2]) } : null;
}

const signed = n => `${n > 0 ? '+' : ''}${n}`;
export function totalLine(market) {
  const question = String(market?.question ?? '');
  return question.match(/(?:O\/U|Over\/Under|Total(?:s)?|总分)\s*:?\s*(\d+(?:\.\d+)?)/i)?.[1] ?? '';
}

export function marketTitle(market, event) {
  if (market.type === 'moneyline') return `${eventTitle(event)} · 胜负`;
  if (market.type === 'spreads') {
    const details = spreadDetails(market);
    if (details) return `${details.team.name}（${signed(details.line)}）· 让分`;
    const translated = translateTeams(market.question).replace(/\bSpread\s*:/gi, '让分：').replace(/\bvs\.?\s*/gi, '对阵 ');
    return /[a-z]{2,}/i.test(translated) ? `${eventTitle(event)} · 让分盘口（线位待识别）` : translated;
  }
  if (market.type === 'totals') return `${eventTitle(event)} · 总分${totalLine(market) ? ` ${totalLine(market)}` : '盘口'}`;
  return '其他盘口';
}

export function outcomeTitle(outcome, market) {
  const text = String(outcome.name ?? '').trim();
  const team = teamFor(text);
  if (team) {
    const details = market.type === 'spreads' && spreadDetails(market);
    return `${team.name}${details ? `（${signed(team.id === details.team.id ? details.line : -details.line)}）` : ''}`;
  }
  if (/^(over|under)\b/i.test(text)) {
    const line = text.match(/\d+(?:\.\d+)?/)?.[0] ?? totalLine(market);
    return `${/^over/i.test(text) ? '大于' : '小于'}${line ? ` ${line}` : ''}`;
  }
  if (/^(yes|no)$/i.test(text)) return /^yes$/i.test(text) ? '是' : '否';
  const translated = translateTeams(text);
  return /[a-z]{2,}/i.test(translated) ? '其他结果（名称待识别）' : translated;
}

export function errorMessage(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (!/[a-z]{2,}/i.test(text)) return text;
  if (/403|forbidden|denied/i.test(text)) return '行情接口访问受限，请检查网络连接或代理设置，程序会自动重试。';
  if (/429|rate.?limit/i.test(text)) return '行情请求过于频繁，正在等待重试。';
  if (/timeout|timed out/i.test(text)) return '行情请求超时，正在重新连接。';
  if (/network|fetch|ENOTFOUND|ECONN|socket|certificate|TLS|proxy/i.test(text)) return '行情网络连接失败，请检查网络及代理设置，程序会自动重试。';
  return '行情暂时不可用，正在重新获取数据。';
}

export const timezoneName = zone => ({ 'Asia/Shanghai': '北京时间', 'America/New_York': '美国东部时间', UTC: '协调世界时' })[zone] ?? '北京时间';
