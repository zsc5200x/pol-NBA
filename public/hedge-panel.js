import { DEFAULT_HEDGE_SETTINGS, validateHedgeSettings, rankHedgeOpportunities } from './hedge-calculator.js';

const STORAGE_KEY = 'pol-nba.hedge-settings.v1';
const FIELDS = { crownStake: 'hedge-crown-stake', exchangeRate: 'hedge-exchange-rate', rebatePercent: 'hedge-rebate-percent' };
const fixed = (value, digits = 2) => Number.isFinite(value) ? value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const signed = (value, digits = 2) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${fixed(Math.abs(value), digits)}`;
const rmb = value => `¥${fixed(value)}`;
const profit = value => `${value < 0 ? '−' : value > 0 ? '+' : ''}¥${fixed(Math.abs(value))}`;

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

function errorList(errors) {
  return Array.isArray(errors) ? errors.filter(Boolean) : errors && typeof errors === 'object' ? Object.values(errors).filter(Boolean) : errors ? [errors] : [];
}

// Only these non-sensitive calculator preferences are persisted in the browser.
function storedFields(settings) {
  return { crownStake: settings.crownStake, exchangeRate: settings.exchangeRate, rebatePercent: settings.rebatePercent };
}

export function createHedgePanel({ onSelect, onSettingsChange } = {}) {
  const element = node('article', 'hedge-panel');
  element.setAttribute('aria-labelledby', 'hedge-panel-title');
  const heading = node('div', 'hedge-heading');
  const titleGroup = node('div');
  const title = node('h3', '', '对冲计算');
  title.id = 'hedge-panel-title';
  titleGroup.append(title, node('p', 'hedge-subtitle', '含反水 · 理论估算'));
  const configButton = node('button', 'hedge-button', '打水配置');
  configButton.type = 'button';
  heading.append(titleGroup, configButton);
  const controls = node('div', 'hedge-controls');
  const scopeLabel = node('label', 'hedge-scope-label', '计算范围');
  const scope = node('select', 'hedge-scope');
  scope.setAttribute('aria-label', '对冲计算范围');
  for (const [value, label] of [['current', '当前比赛'], ['all', '全部比赛']]) {
    const option = node('option', '', label);
    option.value = value;
    scope.append(option);
  }
  scopeLabel.append(scope);
  const configSummary = node('p', 'hedge-config-summary');
  controls.append(scopeLabel, configSummary);
  const status = node('p', 'hedge-status', '选择比赛，等待双方有效报价。');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const list = node('div', 'hedge-list');
  const footnote = node('p', 'hedge-footnote', '同场同线半分盘 · 按卖一及相同结算规则估算 · 不计费用与成交数量');
  element.append(heading, controls, status, list, footnote);

  const form = document.getElementById('hedge-settings-form');
  const inputs = Object.fromEntries(Object.entries(FIELDS).map(([key, id]) => [key, document.getElementById(id)]));
  const formStatus = document.getElementById('hedge-settings-status');
  let settings = { ...DEFAULT_HEDGE_SETTINGS };
  let context = null;
  let dirty = false;
  let storageMessage = '';
  let lastSignature = '';
  const cards = new Map();

  function showFormStatus(message, state = '') {
    if (!formStatus) return;
    formStatus.textContent = message;
    formStatus.dataset.state = state;
  }

  function fillInputs() {
    for (const [field, input] of Object.entries(inputs)) {
      if (!input) continue;
      input.value = settings[field];
      input.removeAttribute('aria-invalid');
    }
  }

  function parseSaved(raw) {
    if (raw === null) return { ...DEFAULT_HEDGE_SETTINGS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid settings');
    const result = validateHedgeSettings(storedFields(parsed));
    if (errorList(result.errors).length || !result.settings) throw new Error('invalid settings');
    return result.settings;
  }

  try {
    settings = parseSaved(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    storageMessage = '本地配置无法读取，已使用初始值；可以重新填写并保存。';
  }
  fillInputs();
  if (storageMessage) showFormStatus(storageMessage, 'pending');

  function createCard(candidate) {
    const root = node('section', 'hedge-result');
    root.dataset.candidateId = candidate.id;
    const locate = node('button', 'hedge-button', '查看盘口');
    locate.type = 'button';
    const legs = node('div', 'hedge-legs');
    const makeLeg = (className, name) => {
      const container = node('div', `hedge-leg ${className}`);
      const label = node('span', 'hedge-leg-name', name);
      const direction = node('strong', 'hedge-direction');
      const amount = node('span', 'hedge-amount');
      const cost = node('span', 'hedge-cost');
      const price = node('span', 'hedge-cost');
      container.append(label, direction, amount, price, cost);
      legs.append(container);
      return { direction, amount, cost, price };
    };
    const pol = makeLeg('hedge-leg-pol', 'Pol 买入');
    const crown = makeLeg('hedge-leg-crown', '皇冠对手盘');
    const rebate = node('p', 'hedge-rebate');
    const footer = node('div', 'hedge-result-footer');
    footer.append(rebate, locate);
    const metrics = node('div', 'hedge-metrics');
    const makeMetric = (className, label) => {
      const container = node('div', `hedge-metric ${className}`);
      const value = node('strong');
      container.append(node('span', '', label), value);
      metrics.append(container);
      return value;
    };
    const total = makeMetric('', '两边总投入');
    const before = makeMetric('', '反水前利润');
    const after = makeMetric('hedge-profit', '含反水预计利润');
    const roi = makeMetric('hedge-roi', '含反水收益率');
    root.append(legs, footer, metrics);
    const card = { root, locate, pol, crown, rebate, total, before, after, roi, candidate };
    locate.addEventListener('click', () => onSelect?.(card.candidate));
    return card;
  }

  function renderCard(card, candidate) {
    card.candidate = candidate;
    card.root.dataset.positive = String(candidate.profitRmb > 0);
    card.root.setAttribute('aria-label', `${candidate.eventTitle}，Pol ${candidate.polLabel}，皇冠 ${candidate.crownLabel}`);
    card.root.title = candidate.eventTitle;
    card.locate.setAttribute('aria-label', `查看${candidate.eventTitle}的${candidate.polLabel}盘口`);
    card.pol.direction.textContent = candidate.polLabel;
    card.pol.amount.textContent = `${fixed(candidate.polShares, 3)} 份`;
    card.pol.price.textContent = `卖一 $${fixed(candidate.polPrice, 3)} / 份`;
    card.pol.cost.textContent = `成本 $${fixed(candidate.polCostUsd)}（${rmb(candidate.polCostRmb)}）`;
    card.crown.direction.textContent = candidate.crownLabel;
    card.crown.amount.textContent = `下注 ${rmb(candidate.crownStakeRmb)}`;
    card.crown.price.textContent = `水位 ${fixed(candidate.crownOdds)}`;
    card.crown.cost.textContent = `有效金额 ${rmb(candidate.effectiveStakeRmb)}`;
    card.rebate.textContent = `反水 ${fixed(settings.rebatePercent)}% · ¥${fixed(candidate.rebateRmb, 3)}`;
    card.total.textContent = rmb(candidate.totalCostRmb);
    card.before.textContent = profit(candidate.profitBeforeRebateRmb);
    card.after.textContent = profit(candidate.profitRmb);
    card.roi.textContent = `${signed(candidate.roiPercent, 3)}%`;
    for (const value of [card.after, card.roi]) {
      value.classList.toggle('hedge-positive', candidate.profitRmb > 0);
      value.classList.toggle('hedge-negative', candidate.profitRmb < 0);
    }
  }

  function render() {
    configSummary.textContent = `皇冠 ${rmb(settings.crownStake)} · 汇率 ${fixed(settings.exchangeRate, 4).replace(/0+$/, '').replace(/\.$/, '')} · 反水 ${fixed(settings.rebatePercent, 2)}%`;
    let opportunities = [];
    let message = '';
    const validation = validateHedgeSettings(settings);
    if (errorList(validation.errors).length || !validation.settings) {
      message = '计算配置无效，请打开打水配置检查本金、汇率及反水比例。';
    } else if (!context?.state) {
      message = '等待行情数据，获取双方有效报价后自动计算。';
    } else if (!context.connected) {
      message = '行情连接已断开，暂停显示计算结果；连接恢复后自动重新计算。';
    } else if (scope.value === 'current' && !context.eventId) {
      message = '请先选择一场比赛，或切换为全部比赛。';
    } else {
      ({ opportunities } = rankHedgeOpportunities(context.state, settings, {
        eventId: scope.value === 'current' ? context.eventId : null,
        connected: context.connected,
      }));
      if (!opportunities.length) {
        message = '暂无可计算的共同半分盘：需要双方同场、同线且未过期的有效报价。';
      }
    }
    // Always show the game card's highest RMB profit in the current-game view,
    // even when that opportunity falls outside the top three by ROI.
    const featured = scope.value === 'current' && opportunities.find(candidate => candidate.id === context?.featuredOpportunityId);
    const selected = featured ? [featured, ...opportunities.filter(candidate => candidate.id !== featured.id).slice(0, 2)] : opportunities.slice(0, 3);
    const signature = JSON.stringify([message, selected, settings]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    const scrollContainer = element.closest('.market-list');
    const scrollTop = scrollContainer?.scrollTop;
    const focused = element.contains(document.activeElement) ? document.activeElement : null;
    status.textContent = message;
    status.hidden = !message;
    const keep = new Set(selected.map(candidate => candidate.id));
    for (const [id, card] of cards) {
      if (!keep.has(id)) { card.root.remove(); cards.delete(id); }
    }
    selected.forEach((candidate, index) => {
      let card = cards.get(candidate.id);
      if (!card) { card = createCard(candidate); cards.set(candidate.id, card); }
      renderCard(card, candidate);
      if (list.children[index] !== card.root) list.insertBefore(card.root, list.children[index] ?? null);
    });
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    if (scrollContainer) scrollContainer.scrollTop = scrollTop;
  }

  function onInput() {
    dirty = true;
    for (const input of Object.values(inputs)) input?.removeAttribute('aria-invalid');
    showFormStatus('尚未保存。保存后立即应用到计算结果。', 'pending');
  }

  function onSubmit(event) {
    event.preventDefault();
    const raw = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input?.value ?? '']));
    const result = validateHedgeSettings(raw);
    const errors = errorList(result.errors);
    if (errors.length || !result.settings) {
      for (const [key, input] of Object.entries(inputs)) {
        if (input) input.setAttribute('aria-invalid', String(!input.validity.valid || Boolean(result.errors?.[key])));
      }
      showFormStatus(errors.join('；') || '请填写有效的本金、汇率和反水比例。', 'error');
      Object.values(inputs).find(input => input?.getAttribute('aria-invalid') === 'true')?.focus();
      return;
    }
    settings = result.settings;
    dirty = false;
    fillInputs();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedFields(settings)));
      storageMessage = '';
      showFormStatus('已保存在此浏览器，计算结果已更新。');
    } catch {
      storageMessage = '浏览器无法保存配置，已应用于当前页面；刷新后需重新设置。';
      showFormStatus(storageMessage, 'pending');
    }
    render();
    onSettingsChange?.({ ...settings });
  }

  function onStorage(event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try {
      settings = parseSaved(event.key === null ? null : event.newValue);
      if (!dirty) fillInputs();
      showFormStatus(dirty ? '其他页面已更新生效配置；保留你正在编辑的内容，保存后可应用。' : '已同步其他页面保存的打水配置。', dirty ? 'pending' : '');
      render();
      onSettingsChange?.({ ...settings });
    } catch {
      showFormStatus('其他页面的配置无法读取，继续使用当前生效配置。', 'pending');
    }
  }

  configButton.addEventListener('click', () => {
    const dialog = document.getElementById('crown-login-dialog');
    if (!dialog?.open) document.getElementById('crown-login-open')?.click();
    requestAnimationFrame(() => { inputs.crownStake?.focus(); });
  });
  scope.addEventListener('change', render);
  form?.addEventListener('input', onInput);
  form?.addEventListener('submit', onSubmit);
  window.addEventListener('storage', onStorage);
  render();

  return {
    element,
    getSettings() { return { ...settings }; },
    update(nextContext) { context = nextContext; render(); },
    destroy() {
      form?.removeEventListener('input', onInput);
      form?.removeEventListener('submit', onSubmit);
      window.removeEventListener('storage', onStorage);
    },
  };
}
