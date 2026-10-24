import { eventTeams, eventTitle, outcomeTitle, teamFor, timezoneName, typeName } from './chinese.js';

const SOURCES = ['pol', 'crown'];
const SOURCE_NAMES = { pol: 'Polymarket', crown: '皇冠' };
const KINDS = { baseline: '首次记录' };

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

export function historyPrice(value, source) {
  if (!Number.isFinite(value)) return '—';
  return source === 'pol'
    ? `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value * 100)} 分`
    : value.toFixed(2);
}

export function historyMovement(value, previous, source, explicitDelta) {
  const delta = explicitDelta !== undefined
    ? Number.isFinite(value) && Number.isFinite(explicitDelta) ? explicitDelta : null
    : Number.isFinite(value) && Number.isFinite(previous) ? value - previous : null;
  if (delta === null) return { text: '—', className: '', description: '无前次有效报价' };
  if (Math.abs(delta) < 1e-9) return { text: '持平', className: '', description: '与上次价格相同' };
  const up = delta > 0;
  return {
    text: `${up ? '↑ +' : '↓ −'}${historyPrice(Math.abs(delta), source)}`,
    className: up ? 'price-up' : 'price-down',
    description: `${up ? '上涨' : '下跌'} ${historyPrice(Math.abs(delta), source)}`,
  };
}

export function historyTime(value, timezone = 'Asia/Shanghai') {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return { date: '时间未知', time: '—' };
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = name => parts.find(item => item.type === name)?.value ?? '';
  return { date: `${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}:${part('second')}` };
}

// Never let a late response or another line's rows appear under the selected line.
export function recordsForSelection(records, context, source) {
  return (Array.isArray(records) ? records : []).filter(record =>
    String(record.eventId) === String(context.event?.id) &&
    String(record.marketId) === String(context.market?.id) &&
    record.type === context.type && record.source === source &&
    (source !== 'crown' || record.sides?.some(side => Number.isFinite(side.price))),
  ).sort((a, b) => Number(b.id) - Number(a.id));
}

export function historyOutcomes(market, event) {
  const outcomes = [...(market?.outcomes ?? [])];
  if (market?.type === 'spreads') {
    const teams = eventTeams(event);
    if (teams.length === 2) outcomes.sort((a, b) => {
      const rank = outcome => { const index = teams.findIndex(team => team.id === teamFor(outcome.name)?.id); return index < 0 ? 2 : index; };
      return rank(a) - rank(b);
    });
  } else if (market?.type === 'totals') outcomes.sort((a, b) => {
    const rank = outcome => /^(over\b|大于)/i.test(outcome.name) ? 0 : /^(under\b|小于)/i.test(outcome.name) ? 1 : 2;
    return rank(a) - rank(b);
  });
  return outcomes.slice(0, 2);
}

export function orderedHistorySides(record, market, event) {
  return historyOutcomes(market, event).map(outcome =>
    record.sides?.find(side => String(side.tokenId) === String(outcome.tokenId)) ??
    { tokenId: outcome.tokenId, label: outcome.name, price: null, previousPrice: null, delta: null },
  );
}

function shortOutcome(outcome, market) {
  return teamFor(outcome?.name)?.short ?? outcomeTitle(outcome, market).replace(/\s*\d+(?:\.\d+)?$/, '').trim();
}

export function createPriceHistoryPanel(root, { onType, onMarket, intervalMs = 2500, fetcher = fetch } = {}) {
  let context = null;
  let key = null;
  let epoch = 0;
  const views = new Map();
  const heading = element('div', 'panel-heading');
  heading.append(element('h2', '', '价格变动'));
  const live = element('span', 'history-live', '等待行情');
  heading.append(live);
  const controls = element('div', 'history-controls');
  const types = element('div', 'history-types');
  types.setAttribute('role', 'group');
  types.setAttribute('aria-label', '价格历史盘口类型');
  const typeButtons = ['spreads', 'totals'].map(type => {
    const button = element('button', '', type === 'spreads' ? '让分' : '大小分');
    button.type = 'button';
    button.dataset.type = type;
    button.addEventListener('click', () => onType?.(type));
    types.append(button);
    return button;
  });
  const lineLabel = element('label', 'history-line-control');
  lineLabel.append(element('span', '', '盘口'));
  const lineSelect = element('select');
  lineSelect.setAttribute('aria-label', '价格历史盘口分值');
  lineSelect.addEventListener('change', () => onMarket?.(context.type, lineSelect.value));
  lineLabel.append(lineSelect);
  controls.append(types, lineLabel);
  const matchup = element('p', 'history-match');
  const selectionNote = element('p', 'history-selection-note');
  const overallStatus = element('p', 'history-status');
  overallStatus.setAttribute('role', 'status');
  overallStatus.setAttribute('aria-live', 'polite');
  root.append(heading, controls, matchup, selectionNote, overallStatus);

  for (const source of SOURCES) {
    const section = element('section', `history-source history-source-${source}`);
    const sourceHeader = element('div', 'history-source-heading');
    const sourceTitle = element('h3', '', SOURCE_NAMES[source]);
    sourceTitle.id = `history-${source}-title`;
    section.setAttribute('aria-labelledby', sourceTitle.id);
    sourceHeader.append(sourceTitle, element('span', '', source === 'pol' ? '报价 · 分' : '原始水位'));
    const scroll = element('div', 'history-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('aria-label', `${SOURCE_NAMES[source]}价格历史表，可滚动查看`);
    const table = element('table', 'history-table');
    const caption = element('caption', 'sr-only');
    const thead = element('thead');
    const headerRow = element('tr');
    const headers = [element('th'), element('th', 'history-line-cell', '盘'), element('th'), element('th', 'history-time-cell', '变化时间')];
    headers.forEach(header => { header.scope = 'col'; headerRow.append(header); });
    thead.append(headerRow);
    const body = element('tbody');
    table.append(caption, thead, body);
    const placeholder = element('p', 'history-empty', '选择比赛后开始查看价格变化');
    scroll.append(table, placeholder);
    const status = element('p', 'history-source-status');
    const pagination = element('div', 'history-pagination');
    const newer = element('button', '', '较新记录');
    const older = element('button', '', '更早记录');
    const latest = element('button', 'history-latest', '返回最新');
    const count = element('span', 'history-page-label', '0 条');
    for (const button of [newer, older, latest]) button.type = 'button';
    pagination.append(newer, older, count, latest);
    section.append(sourceHeader, scroll, status, pagination);
    root.append(section);
    const view = { source, body, headers, caption, table, placeholder, scroll, status, newer, older, latest, count,
      records: [], cursors: [null], cursor: null, hasMore: false, nextBefore: null, busy: false,
      requestId: 0, controller: null, signature: null, recordingSince: null, error: false };
    newer.addEventListener('click', () => {
      if (view.busy || view.cursors.length <= 1) return;
      const cursors = view.cursors.slice(0, -1);
      request(view, { cursor: cursors.at(-1), cursors });
    });
    older.addEventListener('click', () => {
      if (view.busy || !view.hasMore || !view.nextBefore) return;
      request(view, { cursor: view.nextBefore, cursors: [...view.cursors, view.nextBefore] });
    });
    latest.addEventListener('click', () => { if (!view.busy) request(view, { cursor: null, cursors: [null] }); });
    views.set(source, view);
  }
  const legend = element('div', 'history-legend');
  const rise = element('span', 'price-up', '上涨 · 红色');
  const fall = element('span', 'price-down', '下跌 · 绿色');
  const zone = element('span', '', '北京时间 · 记录采集时刻');
  legend.append(rise, fall, zone);
  root.append(legend);

  function updateLiveStatus() {
    const error = [...views.values()].some(view => view.error);
    live.textContent = error ? '记录更新异常' : context?.connected ? '自动记录中' : '等待行情连接';
    live.classList.toggle('connected', Boolean(context?.connected && !error));
  }

  function updateNavigation(view) {
    const available = Boolean(context?.market);
    view.newer.disabled = !available || view.busy || view.cursors.length <= 1;
    view.older.disabled = !available || view.busy || !view.hasMore;
    view.latest.hidden = view.cursors.length <= 1;
    view.latest.disabled = view.busy;
    view.count.textContent = `${view.records.length} 条${view.cursors.length > 1 ? ` · 第 ${view.cursors.length} 页` : ' · 最新'}`;
  }

  function renderRows(view, { resetScroll = false } = {}) {
    const signature = JSON.stringify([view.records, context.timezone]);
    if (view.signature === signature) return;
    view.signature = signature;
    // Anchor a visible existing row when new rows arrive above it.
    const oldTop = view.scroll.scrollTop;
    const anchor = oldTop > 0 ? [...view.body.rows].find(row => row.offsetTop >= oldTop) : null;
    const anchorId = anchor?.dataset.recordId;
    const anchorOffset = anchor ? anchor.offsetTop - oldTop : 0;
    const fragment = document.createDocumentFragment();
    for (const record of view.records) {
      const row = element('tr');
      row.dataset.recordId = String(record.id);
      const sides = orderedHistorySides(record, context.market, context.event);
      const priceCell = side => {
        const cell = element('td');
        const movement = historyMovement(side.price, side.previousPrice, view.source, side.delta);
        if (view.source === 'pol') {
          // Pol rows represent actual ask-price changes only. A missing side is
          // left blank; it is neither a zero quote nor an unavailable event.
          if (Number.isFinite(side.price)) {
            const price = element('strong', `history-price ${movement.className}`, historyPrice(side.price, 'pol'));
            price.setAttribute('aria-label', `${movement.className === 'price-up' ? '上涨' : movement.className === 'price-down' ? '下跌' : '基准报价'}，${historyPrice(side.price, 'pol')}`);
            cell.append(price);
          }
          return cell;
        }
        if (Number.isFinite(side.price)) {
          cell.append(element('strong', `history-price ${movement.className}`, historyPrice(side.price, view.source)));
          const change = element('span', `history-change ${movement.className}`, movement.text);
          change.setAttribute('aria-label', movement.description);
          cell.append(change);
        }
        return cell;
      };
      const line = element('td', 'history-line-cell mono', context.lineLabel || '—');
      const timeCell = element('td', 'history-time-cell');
      const observed = historyTime(record.observedAt, context.timezone);
      const time = element('time', 'mono', observed.time);
      if (record.observedAt) time.dateTime = record.observedAt;
      time.title = `${observed.date} ${observed.time} · ${timezoneName(context.timezone)}`;
      timeCell.append(element('span', 'history-date mono', observed.date), time);
      if (view.source !== 'pol' && record.kind === 'baseline') timeCell.append(element('small', `history-kind kind-${record.kind}`, KINDS.baseline));
      row.append(priceCell(sides[0] ?? {}), line, priceCell(sides[1] ?? {}), timeCell);
      fragment.append(row);
    }
    view.body.replaceChildren(fragment);
    if (resetScroll) view.scroll.scrollTop = 0;
    else if (anchorId) {
      const nextAnchor = [...view.body.rows].find(row => row.dataset.recordId === anchorId);
      view.scroll.scrollTop = nextAnchor ? nextAnchor.offsetTop - anchorOffset : oldTop;
    } else view.scroll.scrollTop = oldTop;
  }

  async function request(view, { cursor = view.cursor, cursors = view.cursors, manual = false } = {}) {
    if (!context?.market || view.busy && !manual) return;
    view.controller?.abort();
    const controller = new AbortController();
    view.controller = controller;
    const capturedEpoch = epoch;
    const requestId = ++view.requestId;
    const capturedContext = context;
    const changedPage = cursor !== view.cursor;
    view.busy = true;
    updateNavigation(view);
    if (!view.records.length) { view.placeholder.hidden = false; view.placeholder.textContent = '正在读取价格记录…'; }
    const query = new URLSearchParams({ eventId: context.event.id, type: context.type, marketId: context.market.id, source: view.source, limit: '50' });
    if (cursor !== null) query.set('before', String(cursor));
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetcher(`/api/price-history?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (capturedEpoch !== epoch || requestId !== view.requestId) return;
      if (!payload || !Array.isArray(payload.records)) throw new Error('历史记录格式异常');
      view.records = recordsForSelection(payload.records, capturedContext, view.source);
      view.cursor = cursor;
      view.cursors = cursors;
      view.nextBefore = payload.nextBefore ?? null;
      view.hasMore = Boolean(payload.hasMore && view.nextBefore);
      view.recordingSince = payload.recordingSince;
      view.error = payload.status === 'error';
      view.status.classList.toggle('has-error', view.error);
      const since = historyTime(payload.recordingSince, context.timezone);
      view.status.textContent = view.error ? payload.error || '价格记录保存失败，显示的是已保存的历史记录。'
        : cursor !== null ? '正在查看历史记录，返回最新可继续实时更新。'
        : payload.recordingSince ? `从 ${since.date} ${since.time} 开始记录 · 每 2.5 秒检查更新`
          : '每 2.5 秒检查更新 · 仅记录实际报价和状态变化';
      view.placeholder.hidden = Boolean(view.records.length);
      view.placeholder.textContent = view.source === 'crown'
        ? '该盘口暂无皇冠记录，取得对应水位后自动显示。'
        : '该盘口暂无价格记录，取得有效报价后自动显示。';
      renderRows(view, { resetScroll: changedPage });
    } catch {
      if (capturedEpoch !== epoch || requestId !== view.requestId) return;
      view.error = true;
      view.status.classList.add('has-error');
      view.status.textContent = '记录更新暂时中断，保留已加载记录，正在重试。';
      if (!view.records.length) view.placeholder.textContent = '暂时无法读取历史记录';
    } finally {
      clearTimeout(timeout);
      if (capturedEpoch === epoch && requestId === view.requestId) {
        view.busy = false;
        updateNavigation(view);
        updateLiveStatus();
      }
    }
  }

  function update(next) {
    context = next;
    const nextKey = next?.event && next?.market ? `${next.event.id}:${next.type}:${next.market.id}` : null;
    updateLiveStatus();
    matchup.textContent = next?.event ? eventTitle(next.event) : '请选择比赛';
    typeButtons.forEach(button => {
      button.classList.toggle('active', button.dataset.type === next?.type);
      button.setAttribute('aria-pressed', String(button.dataset.type === next?.type));
    });
    const optionsSignature = JSON.stringify((next?.lines ?? []).map(line => [line.market.id, line.label]));
    if (lineSelect.dataset.signature !== optionsSignature) {
      lineSelect.replaceChildren(...(next?.lines ?? []).map(line => {
        const option = element('option', '', line.label);
        option.value = line.market.id;
        return option;
      }));
      lineSelect.dataset.signature = optionsSignature;
    }
    lineSelect.value = next?.market?.id ?? '';
    lineSelect.disabled = !next?.market;
    selectionNote.textContent = next?.market ? next.type === 'spreads'
      ? `全场让分 · 盘口以${eventTeams(next.event)[0]?.short ?? '第一支球队'}为准 · ${next.lineLabel}`
      : `全场大小分 · 总分 ${next.lineLabel}` : '当前比赛暂无此类盘口';
    overallStatus.textContent = next?.connected ? '' : next?.event ? '行情连接中断，以下为已保存的历史记录。' : '';
    zone.textContent = `${timezoneName(next?.timezone)} · 记录采集时刻`;
    for (const view of views.values()) {
      const outcomes = historyOutcomes(next?.market, next?.event);
      view.headers[0].textContent = outcomes[0] ? shortOutcome(outcomes[0], next.market) : '一方';
      view.headers[2].textContent = outcomes[1] ? shortOutcome(outcomes[1], next.market) : '另一方';
      view.headers[0].title = outcomes[0] ? outcomeTitle(outcomes[0], next.market) : '';
      view.headers[2].title = outcomes[1] ? outcomeTitle(outcomes[1], next.market) : '';
      view.caption.textContent = `${SOURCE_NAMES[view.source]} ${typeName(next?.type)}价格记录，最新变化在前`;
    }
    if (key === nextKey) return;
    key = nextKey;
    epoch++;
    for (const view of views.values()) {
      view.controller?.abort();
      Object.assign(view, { records: [], cursors: [null], cursor: null, hasMore: false, nextBefore: null, busy: false, signature: null, error: false });
      view.body.replaceChildren();
      view.scroll.scrollTop = 0;
      view.status.textContent = '';
      view.placeholder.hidden = false;
      view.placeholder.textContent = next?.market ? '正在读取价格记录…' : '当前比赛暂无此类盘口';
      updateNavigation(view);
      if (nextKey) request(view);
    }
    updateLiveStatus();
  }

  const timer = setInterval(() => {
    if (document.hidden) return;
    for (const view of views.values()) if (view.cursor === null && !view.busy) request(view);
  }, intervalMs);
  return {
    update,
    destroy() { clearInterval(timer); epoch++; for (const view of views.values()) view.controller?.abort(); },
  };
}
