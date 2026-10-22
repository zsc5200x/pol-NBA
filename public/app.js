import { eventTeams, eventTitle, marketTitle, outcomeTitle, typeName, errorMessage, timezoneName } from './chinese.js';
import { groupMarkets, preferredLine, correspondingOutcome } from './market-lines.js';

const $ = (selector) => document.querySelector(selector);
const nodes = Object.fromEntries(['connection', 'mode-label', 'clock', 'timezone-label', 'update-label', 'timezone', 'notice', 'stat-events', 'stat-markets', 'stat-spread', 'stat-depth', 'date-range', 'game-count', 'games', 'match-heading', 'market-types', 'markets', 'market-link', 'book-mode', 'book-selection', 'book-summary', 'book', 'book-footnote'].map(id => [id, document.getElementById(id)]));

let state = null;
let selectedEvent = null;
let selectedToken = null;
let selectedType = 'all';
let transportConnected = false;
let settingsPending = false;
let localError = null;
let gamesSignature = null;
let renderedMarketEvent = null;
const chosenLines = new Map();
const lineScroll = new Map();
const bookPanel = document.querySelector('.book-panel');
const primaryTypes = new Set(['moneyline', 'spreads', 'spread', 'totals', 'total']);
const money = (value, digits = 0) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits }).format(value);
const number = (value, digits = 0) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
const cents = (value) => Number.isFinite(value) ? `${number(value * 100, 2)} 分` : '—';

function el(tag, className = '', text = '') {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== '') result.textContent = text;
  return result;
}

function teamBadge(team, size = 'small') {
  const badge = el('span', `team-badge ${size}`);
  badge.style.setProperty('--team-color', team.color);
  badge.append(el('span', 'team-fallback', team.short.slice(0, 2)));
  const image = document.createElement('img');
  image.src = `/logos/${team.id}.svg`;
  image.alt = `${team.name}队徽`;
  image.width = 72; image.height = 72;
  image.decoding = 'async';
  image.addEventListener('error', () => image.remove(), { once: true });
  badge.append(image);
  return badge;
}

function gameTeams(event) {
  const teams = eventTeams(event);
  const group = el('span', 'game-teams');
  if (!teams.length) { group.append(el('strong', 'game-title', eventTitle(event))); return group; }
  for (const team of teams) {
    const row = el('span', 'game-team-row');
    row.append(teamBadge(team), el('strong', '', team.name));
    group.append(row);
  }
  return group;
}

function matchup(event) {
  const group = el('div', 'matchup');
  const teams = eventTeams(event);
  if (!teams.length) { group.append(el('strong', '', eventTitle(event))); return group; }
  teams.forEach((team, index) => {
    if (index) group.append(el('span', 'matchup-versus', '对阵'));
    const side = el('div', 'matchup-team');
    side.append(teamBadge(team, 'large'), el('strong', '', team.name));
    group.append(side);
  });
  return group;
}

function date(value, options) {
  const d = new Date(value);
  if (!value || !Number.isFinite(d.getTime())) return '时间待定';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: state?.timezone || 'Asia/Shanghai', ...options }).format(d);
}

function validLevels(book, side) {
  return (book?.[side] || []).map(row => ({ price: Number(row.price), size: Number(row.size) })).filter(row => Number.isFinite(row.price) && Number.isFinite(row.size) && row.size > 0 && row.price >= 0 && row.price <= 1).sort((a, b) => side === 'bids' ? b.price - a.price : a.price - b.price);
}

function quotes(tokenId) {
  const book = state?.books?.[tokenId];
  const bids = validLevels(book, 'bids');
  const asks = validLevels(book, 'asks');
  return { book, bids, asks, bid: bids[0]?.price ?? null, ask: asks[0]?.price ?? null };
}

function empty(title, detail, icon = '↗') {
  const box = el('div', 'empty-state');
  box.append(el('span', 'empty-icon', icon), el('strong', '', title), el('p', '', detail));
  return box;
}

function preservePageScroll(update) {
  const { scrollX, scrollY } = window;
  const restore = () => {
    if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
  };
  try {
    update();
  } finally {
    restore();
    requestAnimationFrame(restore);
  }
}

function activeGame() {
  return state?.events?.find(event => event.id === selectedEvent);
}

function selectedOutcome() {
  for (const market of activeGame()?.markets || []) {
    const outcome = market.outcomes.find(outcome => outcome.tokenId === selectedToken);
    if (outcome) return { market, outcome };
  }
  return null;
}

function preferredOutcome(event) {
  const market = event?.markets.find(market => market.acceptingOrders && !market.closed && primaryTypes.has(market.type)) || event?.markets.find(market => market.acceptingOrders && !market.closed) || event?.markets[0];
  return market?.outcomes[0]?.tokenId || null;
}

function status() {
  const verifiedAt = state?.verifiedAt || state?.updatedAt;
  const stale = verifiedAt && Date.now() - new Date(verifiedAt).getTime() > 30000;
  const healthy = state?.status === 'live' && !stale && transportConnected;
  const demo = state?.mode === 'demo';
  nodes.connection.className = `status-pill ${healthy && !demo ? 'connected' : demo ? 'demo' : 'disconnected'}`;
  nodes.connection.replaceChildren(el('i'), el('span', '', demo ? '演示模式' : healthy ? state?.stream?.connected ? '实时推送' : '3 秒行情快照' : state?.status === 'degraded' && transportConnected && !stale ? '部分行情异常' : state ? '行情连接异常' : '正在连接'));
  nodes['mode-label'].textContent = demo ? '模拟数据 / 非真实行情' : '只读行情';
  nodes['update-label'].textContent = verifiedAt ? `行情核验于 ${date(verifiedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}${stale ? ' · 已过期' : ''}` : '尚无有效行情';
  const message = settingsPending ? '正在切换筛选条件…' : errorMessage(localError || state?.error) || (demo ? '当前为演示模式：所有比赛与订单簿均为模拟数据，用于体验界面，不能用于交易判断。' : !transportConnected && state ? '页面行情通道已断开，正在重连。显示的是最近收到的数据，请留意核验时间。' : stale ? '行情已超过 30 秒未完成有效核验，显示的是上次收到的数据。' : '');
  nodes.notice.textContent = message;
  nodes.notice.className = `notice ${!message ? 'hidden' : demo && !state?.error ? 'demo-notice' : ''}`;
  const currentTime = new Date();
  nodes.clock.textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: state?.timezone || 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(currentTime);
}

function renderGames() {
  preservePageScroll(renderGamesContent);
}

function renderGamesContent() {
  const signature = JSON.stringify([state.timezone, selectedEvent, state.error,
    state.events.map(event => [event.id, event.title, event.startTime, event.markets.length])]);
  if (signature === gamesSignature) return;
  gamesSignature = signature;
  const scrollTop = nodes.games.scrollTop;
  const scrollLeft = nodes.games.scrollLeft;
  nodes.games.replaceChildren();
  if (!state.events.length) {
    nodes.games.append(empty('暂无比赛', state.error ? '暂时无法获取赛程。请检查网络配置，程序会自动重试。' : '这个时间范围内没有可展示的美职篮比赛。可以试试其他时间范围。', '◷'));
    return;
  }
  let previousDay = null;
  for (const event of state.events) {
    const day = date(event.startTime, { month: 'long', day: 'numeric', weekday: 'short' });
    if (day !== previousDay) {
      nodes.games.append(el('div', 'day-label', day));
      previousDay = day;
    }
    const button = el('button', `game-card ${selectedEvent === event.id ? 'selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedEvent === event.id));
    const gameMeta = el('div', 'game-meta');
    gameMeta.append(el('span', 'game-time mono', date(event.startTime, { hour: '2-digit', minute: '2-digit', hour12: false })), el('span', 'game-market-count', `${event.markets.length} 个盘口`));
    button.append(el('span', 'game-day-mobile', date(event.startTime, { month: 'numeric', day: 'numeric', weekday: 'short' })), gameMeta, gameTeams(event), el('span', 'game-arrow', '↗'));
    button.addEventListener('click', () => { selectedEvent = event.id; selectedToken = preferredOutcome(event); selectedType = 'all'; render(); });
    nodes.games.append(button);
  }
  nodes.games.scrollTop = scrollTop;
  nodes.games.scrollLeft = scrollLeft;
}

function renderMarkets() {
  preservePageScroll(renderMarketsContent);
}

function renderMarketsContent() {
  const game = activeGame();
  const scrollTop = renderedMarketEvent === game?.id ? nodes.markets.scrollTop : 0;
  renderedMarketEvent = game?.id;
  nodes['match-heading'].replaceChildren();
  nodes['market-types'].replaceChildren();
  nodes.markets.replaceChildren();
  nodes['market-link'].classList.add('hidden');
  if (!game) {
    bookPanel.classList.add('hidden');
    nodes.markets.append(empty('等待赛程', '获得比赛后，这里会列出可用盘口及各结果报价。', '◈'));
    return;
  }
  nodes['match-heading'].append(el('div', 'eyebrow', '美职篮 · 比赛盘口'), el('h3', 'sr-only', eventTitle(game)), matchup(game), el('p', 'match-date', date(game.startTime, { month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false })));
  if (typeof game.slug === 'string' && /^[a-zA-Z0-9_-]+$/.test(game.slug)) {
    nodes['market-link'].href = `https://polymarket.com/event/${encodeURIComponent(game.slug)}`;
    nodes['market-link'].classList.remove('hidden');
  }
  const types = ['all', ...new Set(game.markets.map(market => market.type || 'other'))];
  if (!types.includes(selectedType)) selectedType = 'all';
  for (const type of types) {
    const button = el('button', type === selectedType ? 'active' : '', type === 'all' ? '全部盘口' : typeName(type));
    button.type = 'button';
    button.addEventListener('click', () => {
      selectedType = type;
      nodes.markets.scrollTop = 0;
      if (type !== 'all' && selectedOutcome()?.market.type !== type) {
        const group = groupMarkets(game).find(group => group.type === type);
        const line = group && preferredLine(group.lines, chosenLines.get(`${game.id}:${type}`));
        selectedToken = line ? correspondingOutcome(selectedOutcome()?.outcome, line.market)?.tokenId ?? null : null;
      }
      renderMarkets(); renderBook(); renderStats();
    });
    nodes['market-types'].append(button);
  }
  const selection = selectedOutcome();
  for (const group of groupMarkets(game).filter(group => selectedType === 'all' || group.type === selectedType)) {
    const key = `${game.id}:${group.type}`;
    const selectedInGroup = selection?.market.type === group.type;
    const rememberedId = selectedInGroup ? selection.market.id : chosenLines.get(key);
    const line = preferredLine(group.lines, rememberedId);
    const market = line.market;
    chosenLines.set(key, market.id);
    const card = el('article', `market-card line-card ${selectedInGroup ? 'expanded' : ''}`);
    card.dataset.type = group.type;
    card.dataset.marketId = market.id;
    const header = el('div', 'line-card-header');
    const description = el('div', 'line-description');
    description.append(el('h4', '', typeName(group.type)), el('small', '', market.closed ? '已结束 / 已结算' : market.acceptingOrders ? `${group.lines.length} 个可选盘口 · 接受挂单` : '暂停挂单'));
    description.append(el('small', 'line-price-caption', '报价为买入价（卖一）'));
    header.append(description);
    const outcomes = el('div', 'outcomes line-quotes');
    for (const [index, outcome] of market.outcomes.entries()) {
      const quote = quotes(outcome.tokenId);
      const button = el('button', `outcome-card line-quote side-${index} ${selectedToken === outcome.tokenId ? 'active' : ''}`);
      button.type = 'button';
      button.dataset.tokenId = outcome.tokenId;
      button.setAttribute('aria-pressed', String(selectedToken === outcome.tokenId));
      button.setAttribute('aria-label', `${outcomeTitle(outcome, market)}，买入价 ${cents(quote.ask)}`);
      button.title = `买入价（卖一）：${cents(quote.ask)}；卖出价（买一）：${cents(quote.bid)}`;
      button.append(el('span', 'outcome-name', outcomeTitle(outcome, market)), el('strong', 'mono', cents(quote.ask)));
      if (market.closed) button.append(el('small', 'quote-warning', '已结束'));
      else if (quote.book?.error) button.append(el('small', 'quote-warning', '行情异常'));
      else if (!quote.book) button.append(el('small', 'quote-warning', '等待报价'));
      button.addEventListener('click', () => {
        selectedToken = outcome.tokenId;
        chosenLines.set(key, market.id);
        renderMarkets(); renderBook(); renderStats();
      });
      outcomes.append(button);
    }
    header.append(outcomes);
    card.append(header);
    if (group.type !== 'moneyline') {
      const hint = group.type === 'spreads' ? `分值以${eventTeams(game)[0]?.short ?? '第一支球队'}为准，正数为受让、负数为让分` : '选择比赛总分线，查看大分与小分报价';
      card.append(el('p', 'line-hint', hint));
      const selector = el('div', 'line-selector');
      const strip = el('div', 'line-strip');
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', `${typeName(group.type)}分值选择`);
      for (const option of group.lines) {
        const chip = el('button', `line-chip ${option.market.id === market.id ? 'active' : ''}`, option.label);
        chip.type = 'button';
        chip.dataset.marketId = option.market.id;
        chip.setAttribute('aria-pressed', String(option.market.id === market.id));
        chip.setAttribute('aria-label', marketTitle(option.market, game));
        chip.addEventListener('click', () => {
          selectedToken = correspondingOutcome(selectedOutcome()?.outcome, option.market)?.tokenId ?? null;
          chosenLines.set(key, option.market.id);
          renderMarkets(); renderBook(); renderStats();
          const active = nodes.markets.querySelector(`[data-type="${group.type}"] .line-chip.active`);
          if (active) active.parentElement.scrollLeft = Math.max(0, active.offsetLeft - active.parentElement.clientWidth / 2 + active.offsetWidth / 2);
        });
        strip.append(chip);
      }
      const arrow = (text, label, direction) => {
        const button = el('button', 'line-arrow', text);
        button.type = 'button'; button.setAttribute('aria-label', label);
        button.addEventListener('click', () => strip.scrollBy({ left: direction * 220, behavior: 'smooth' }));
        return button;
      };
      selector.append(arrow('‹', '向左查看更多分值', -1), strip, arrow('›', '向右查看更多分值', 1));
      strip.addEventListener('scroll', () => lineScroll.set(key, strip.scrollLeft), { passive: true });
      card.append(selector);
      nodes.markets.append(card);
      const active = strip.querySelector('.active');
      strip.scrollLeft = lineScroll.get(key) ?? (active ? Math.max(0, active.offsetLeft - strip.clientWidth / 2) : 0);
    } else nodes.markets.append(card);
    if (selectedInGroup) {
      card.append(bookPanel);
      bookPanel.classList.remove('hidden');
    }
  }
  nodes.markets.scrollTop = scrollTop;
}

function renderStats() {
  nodes['stat-events'].textContent = String(state.events.length).padStart(2, '0');
  nodes['stat-markets'].textContent = String(state.events.reduce((sum, event) => sum + event.markets.length, 0)).padStart(2, '0');
  const quote = quotes(selectedToken);
  nodes['stat-spread'].textContent = quote.ask !== null && quote.bid !== null ? cents(quote.ask - quote.bid) : '—';
  const depth = [...quote.bids, ...quote.asks].reduce((total, level) => total + level.price * level.size, 0);
  nodes['stat-depth'].textContent = quote.book ? money(depth) : '—';
  nodes['game-count'].textContent = `${state.events.length} 场比赛`;
  nodes['date-range'].textContent = ({ upcoming: '今天及未来两天', past: '今天及过去两天', both: '前两天至后两天 · 共 5 天' })[state.range] || '按所选时区筛选';
}

function orderRows(levels, side, maxDepth) {
  let cumulativeSize = 0;
  let cumulativeNotional = 0;
  const fragment = document.createDocumentFragment();
  const rows = [];
  for (const level of levels.slice(0, 12)) {
    cumulativeSize += level.size;
    cumulativeNotional += level.price * level.size;
    const row = el('div', `book-row ${side}`);
    row.style.setProperty('--depth', `${maxDepth ? Math.min(100, cumulativeSize / maxDepth * 100) : 0}%`);
    row.append(el('span', `${side === 'bids' ? 'bid-color' : 'ask-color'} mono`, cents(level.price)), el('span', 'mono', number(level.size, 2)), el('span', 'mono', number(cumulativeSize, 2)), el('span', 'mono', money(cumulativeNotional, 2)));
    rows.push(row);
  }
  fragment.append(...(side === 'asks' ? rows.reverse() : rows));
  return fragment;
}

function renderBook() {
  preservePageScroll(renderBookContent);
}

function renderBookContent() {
  nodes['book-selection'].replaceChildren();
  nodes['book-summary'].replaceChildren();
  nodes.book.replaceChildren();
  const selection = selectedOutcome();
  if (!selection) {
    nodes.book.append(empty('等待订单簿', '选择比赛与市场结果，查看买卖两侧挂单。', '≋'));
    nodes['book-footnote'].textContent = '订单簿数据尚未加载';
    return;
  }
  const { market, outcome } = selection;
  const quote = quotes(outcome.tokenId);
  nodes['book-selection'].append(el('span', 'market-type-label', typeName(market.type)), el('h3', '', outcomeTitle(outcome, market)), el('p', '', marketTitle(market, activeGame())));
  nodes['book-mode'].textContent = state.mode === 'demo' ? '模拟行情' : '实时买卖挂单';
  if (!quote.book) {
    nodes.book.append(empty(market.closed ? '历史盘口已结束' : '正在获取深度', market.closed ? '已结束或已结算的盘口不提供当前可交易订单簿。' : '订单簿加载后将显示各价位挂单与累计深度。', '≋'));
    nodes['book-footnote'].textContent = market.closed ? '此处不将结算价格作为买卖报价展示' : '等待订单簿快照';
    return;
  }
  const spreadBox = el('div'); spreadBox.append(el('small', '', '买卖价差'), el('strong', 'mono', quote.ask !== null && quote.bid !== null ? cents(quote.ask - quote.bid) : '—'));
  const midBox = el('div'); midBox.append(el('small', '', '中间价'), el('strong', 'mono', quote.ask !== null && quote.bid !== null ? cents((quote.ask + quote.bid) / 2) : '—'));
  nodes['book-summary'].append(spreadBox, midBox);
  if (quote.book.error) nodes.book.append(el('div', 'book-error', errorMessage(quote.book.error)));
  if (!quote.asks.length && !quote.bids.length) nodes.book.append(empty('暂无挂单', '该结果当前没有可展示的买卖订单。', '≋'));
  else {
    const heading = el('div', 'book-row book-table-heading');
    heading.append(el('span', '', '价格'), el('span', '', '份额'), el('span', '', '累计份额'), el('span', '', '累计金额'));
    nodes.book.append(heading);
    const maxDepth = Math.max(quote.bids.slice(0, 12).reduce((sum, level) => sum + level.size, 0), quote.asks.slice(0, 12).reduce((sum, level) => sum + level.size, 0));
    nodes.book.append(el('div', 'side-label ask-color', `卖方挂单 · ${quote.asks.length} 档`));
    nodes.book.append(quote.asks.length ? orderRows(quote.asks, 'asks', maxDepth) : el('div', 'no-side', '暂无卖单'));
    const separator = el('div', 'book-divider'); separator.append(el('span', '', '买卖价差'), el('strong', 'mono', quote.ask !== null && quote.bid !== null ? cents(quote.ask - quote.bid) : '—')); nodes.book.append(separator);
    nodes.book.append(el('div', 'side-label bid-color', `买方挂单 · ${quote.bids.length} 档`));
    nodes.book.append(quote.bids.length ? orderRows(quote.bids, 'bids', maxDepth) : el('div', 'no-side', '暂无买单'));
  }
  const bookVerifiedAt = quote.book.verifiedAt || quote.book.updatedAt;
  const age = bookVerifiedAt ? Math.max(0, Math.floor((Date.now() - new Date(bookVerifiedAt).getTime()) / 1000)) : null;
  const timeOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  nodes['book-footnote'].textContent = `${state.mode === 'demo' ? '模拟快照' : state.stream?.connected ? '实时推送' : '3 秒快照'} · 快照 ${quote.book.updatedAt ? date(quote.book.updatedAt, timeOptions) : '时间未知'}${quote.book.verifiedAt ? ` · 核验 ${date(quote.book.verifiedAt, timeOptions)}` : ''}${age > 30 ? ' · 数据已过期' : ''}\n每侧显示最优 12 档，按最优价起累计；金额 = 价格 × 份额。`;
  nodes['book-footnote'].classList.toggle('stale', age > 30);
}

function render() {
  if (!state) return;
  if (!state.events.some(event => event.id === selectedEvent)) {
    const preferredEvent = state.events.find(event => event.markets.some(market => market.acceptingOrders && !market.closed && primaryTypes.has(market.type))) || state.events.find(event => event.markets.some(market => market.acceptingOrders && !market.closed)) || state.events[0];
    selectedEvent = preferredEvent?.id || null;
    selectedToken = preferredOutcome(preferredEvent);
  }
  if (!selectedOutcome()) selectedToken = preferredOutcome(activeGame());
  nodes.timezone.value = state.timezone;
  nodes['timezone-label'].textContent = timezoneName(state.timezone);
  document.querySelectorAll('[data-range]').forEach(button => button.classList.toggle('active', button.dataset.range === state.range));
  renderGames(); renderMarkets(); renderBook(); renderStats(); status();
}

function acceptState(next) {
  if (!next || !Array.isArray(next.events) || !next.books) return;
  localError = null;
  state = next;
  render();
}

async function updateSettings(settings) {
  localError = null;
  settingsPending = true; status();
  document.querySelectorAll('[data-range], #timezone').forEach(node => { node.disabled = true; });
  try {
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    if (!response.ok) throw new Error('筛选条件更新失败，请稍后重试。');
    const result = await response.json();
    if (result.events) acceptState(result);
    else {
      const snapshot = await fetch('/api/state');
      if (snapshot.ok) acceptState(await snapshot.json());
    }
  } catch (error) {
    localError = error.message;
  } finally {
    settingsPending = false;
    document.querySelectorAll('[data-range], #timezone').forEach(node => { node.disabled = false; });
    status();
  }
}

document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => updateSettings({ range: button.dataset.range })));
nodes.timezone.addEventListener('change', () => updateSettings({ timezone: nodes.timezone.value }));

async function init() {
  nodes.games.append(empty('正在获取比赛', '正在读取预测市场的美职篮赛程与盘口。', '◷'));
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`服务响应 ${response.status}`);
    acceptState(await response.json());
  } catch (error) {
    localError = `无法连接监控服务：${error.message}。页面会自动尝试重新连接。`;
    status();
  }
  const stream = new EventSource('/api/stream');
  stream.addEventListener('open', () => { transportConnected = true; status(); });
  stream.addEventListener('state', event => {
    try { acceptState(JSON.parse(event.data)); } catch { /* Wait for the next valid snapshot. */ }
  });
  stream.addEventListener('error', () => { transportConnected = false; status(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetch('/api/state').then(response => response.ok ? response.json() : null).then(acceptState).catch(() => {}); });
  setInterval(() => { status(); if (state) renderBook(); }, 1000);
}

init();
