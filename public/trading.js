const $ = selector => document.querySelector(selector);
const dialog = $('#trading-dialog');
const statusNode = $('#trading-status');
const actionStatus = $('#trading-action-status');
const form = $('#trading-settings-form');
const fields = {
  stakeUsdc: $('#trading-stake'),
  buySlippage: $('#trading-slippage'),
  takeProfitIncrement: $('#trading-take-profit'),
};

let latest = null;
let busy = false;

const statusText = value => value ? '已连接' : '未配置';
const usd = value => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)} USDC` : '—';
const price = value => Number.isFinite(Number(value)) ? `${Number(value).toFixed(3)} 美元` : '—';
const statusNames = {
  processing: '处理中',
  skipped: '已跳过',
  manual_review: '需人工核对',
  take_profit_ordered: '止盈卖单已挂',
  failed: '失败',
};
const timeText = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
};

async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error('本机服务返回了无法识别的响应'); }
  if (!response.ok) throw new Error(payload?.error || '本机交易操作失败');
  return payload;
}

function setActionMessage(message = '', kind = '') {
  actionStatus.textContent = message;
  actionStatus.dataset.kind = kind;
}

function fillSettings(settings) {
  fields.stakeUsdc.value = settings?.stakeUsdc ?? '';
  fields.buySlippage.value = settings?.buySlippage ?? 0.02;
  fields.takeProfitIncrement.value = settings?.takeProfitIncrement ?? 0.02;
}

function renderRecords(records = []) {
  const list = $('#trading-record-list');
  const count = $('#trading-record-count');
  const rows = Array.isArray(records) ? records.slice(0, 20) : [];
  count.textContent = `${rows.length} 条`;
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'trading-empty';
    empty.textContent = '暂无交易记录';
    list.append(empty);
    return;
  }

  for (const record of rows) {
    const item = document.createElement('article');
    item.className = 'trading-record';
    const top = document.createElement('div');
    top.className = 'trading-record-top';
    const matchup = document.createElement('strong');
    matchup.textContent = `${record.team || '未知球队'} ${formatHandicap(record.handicap)}`;
    const badge = document.createElement('span');
    badge.className = `trading-record-state state-${safeState(record.status)}`;
    badge.textContent = statusNames[record.status] || record.status || '未知状态';
    top.append(matchup, badge);

    const details = document.createElement('p');
    details.className = 'trading-record-details';
    details.textContent = `${usd(record.stakeUsdc)} · 买入均价 ${price(record.entryPrice)} · ${record.shares == null ? '份额待核对' : `${Number(record.shares).toFixed(3)} 份`} · 卖出 ${price(record.exitPrice)}`;
    const meta = document.createElement('p');
    meta.className = 'trading-record-meta';
    meta.textContent = `${timeText(record.createdAt)}${record.reason ? ` · ${record.reason}` : ''}`;
    item.append(top, details, meta);
    list.append(item);
  }
}

function formatHandicap(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed > 0 ? '+' : ''}${parsed}` : '';
}

function safeState(value) {
  return String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
}

function render(data, { populate = false } = {}) {
  latest = data;
  if (populate) fillSettings(data.settings);
  const enabled = Boolean(data.enabled);
  const telegramReady = Boolean(data.credentials?.telegram);
  const polyReady = Boolean(data.credentials?.polymarket);
  const receiver = data.receiver ?? {};
  $('#trading-toolbar-label').textContent = enabled ? '自动交易已启用' : '自动交易关闭';
  $('#trading-open').dataset.enabled = enabled ? 'true' : 'false';
  $('#trading-telegram-state').textContent = statusText(telegramReady);
  $('#trading-telegram-state').dataset.ready = String(telegramReady);
  $('#trading-polymarket-state').textContent = statusText(polyReady);
  $('#trading-polymarket-state').dataset.ready = String(polyReady);
  const receiverText = receiver.running ? '监听中' : receiver.configured ? '已停止' : '未配置';
  $('#trading-receiver-state').textContent = receiver.lastError ? `异常：${receiver.lastError}` : receiver.stopReason ? `停止：${receiver.stopReason}` : receiverText;
  $('#trading-receiver-state').dataset.ready = String(Boolean(receiver.running));

  const stake = Number(fields.stakeUsdc.value);
  const saved = data.settings ?? {};
  const unchanged = Number(fields.stakeUsdc.value) === Number(saved.stakeUsdc)
    && Number(fields.buySlippage.value) === Number(saved.buySlippage)
    && Number(fields.takeProfitIncrement.value) === Number(saved.takeProfitIncrement);
  const ready = Boolean(data.ready && unchanged && Number.isFinite(stake) && stake > 0);
  $('#trading-enable').disabled = busy || enabled || !ready;
  $('#trading-disable').hidden = !enabled;
  $('#trading-disable').disabled = busy;
  $('#trading-save').disabled = busy || enabled;
  for (const input of Object.values(fields)) input.disabled = busy || enabled;

  const issues = [];
  if (!telegramReady) issues.push('缺少 Telegram 配置');
  if (!polyReady) issues.push('缺少 Polymarket 凭据');
  if (!receiver.configured) issues.push('信号监听未配置');
  if (receiver.configured && !receiver.running) issues.push('Telegram 监听未运行');
  if (receiver.running && !receiver.lastPollAt) issues.push('等待 Telegram 首次成功轮询');
  if (data.storageReady === false) issues.push('本机交易记录不可用');
  if (!Number.isFinite(stake) || stake <= 0) issues.push('请先设置每单金额');
  if (!unchanged) issues.push('交易参数尚未保存');
  if (!data.ready && !issues.length) issues.push('实时行情尚未就绪');
  if (data.error) issues.push(data.error);
  statusNode.textContent = enabled
    ? '实盘跟单已启用；停止后不会撤销已经提交的卖出限价单。'
    : issues.length ? `未启用：${issues.join('；')}` : '已就绪，交易仍需你手动启用。';
  statusNode.dataset.enabled = String(enabled);
  renderRecords(data.records);
}

async function refresh({ populate = false } = {}) {
  try {
    const data = await request('/api/trading/status');
    delete statusNode.dataset.error;
    render(data, { populate });
  } catch (error) {
    statusNode.textContent = error.message;
    statusNode.dataset.error = 'true';
    $('#trading-toolbar-label').textContent = '交易状态不可用';
  }
}

async function postAction(path, body, successMessage) {
  if (busy) return;
  busy = true;
  setActionMessage('正在处理…');
  if (latest) render(latest);
  try {
    const data = await request(path, body);
    render(data, { populate: path.endsWith('/settings') });
    setActionMessage(successMessage, 'success');
  } catch (error) {
    setActionMessage(error.message, 'error');
  } finally {
    busy = false;
    if (latest) render(latest);
  }
}

$('#trading-open').addEventListener('click', async () => {
  if (!dialog.open) dialog.showModal();
  await refresh({ populate: true });
});

$('#trading-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
});
form.addEventListener('input', () => { if (latest) render(latest); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, Number(input.value)]));
  if (Object.values(values).some(value => !Number.isFinite(value))) {
    setActionMessage('请填写有效的交易参数。', 'error');
    return;
  }
  await postAction('/api/trading/settings', values, '参数已保存。');
});

$('#trading-enable').addEventListener('click', async () => {
  if (!latest?.ready || Number(fields.stakeUsdc.value) <= 0) {
    setActionMessage('先设置有效金额并确认连接状态。', 'error');
    return;
  }
  const accepted = window.confirm('即将启用真实 USDC 交易。信号会自动提交买单和止盈卖单，可能发生亏损。确认启用？');
  if (!accepted) return;
  await postAction('/api/trading/enable', {}, '实盘跟单已启用。');
});

$('#trading-disable').addEventListener('click', async () => {
  await postAction('/api/trading/disable', {}, '已停止接收新单。');
});

void refresh({ populate: true });
window.setInterval(() => { void refresh(); }, 10000);
