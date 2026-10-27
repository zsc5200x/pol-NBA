import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingExecutor } from '../src/trading/executor.mjs';

const now = Date.parse('2026-10-26T00:01:00.000Z');
const signalText = [
  '🤣NBA美国职业篮球联赛',
  '🤣犹他爵士 v 孟菲斯灰熊',
  '',
  '📍 状态：早盘',
  '玩法：让球',
  '时段：全场',
  '选择：孟菲斯灰熊 +1.5 @0.84',
  '',
  '💰 原注金额：100',
  '💲 跟单金额：0',
  '🐦‍⬛跟单成功：0',
  '',
  '来源后台：Hmbvs1799',
  '来源会员：chfh67972',
  '🧠单号：25594626127',
  '🗓时间：10-26-2026 08:00:00',
].join('\n');

function marketState({ mode = 'live', status = 'live', line = 'Utah Jazz (-1.5)', verifiedAt = new Date(now - 10000).toISOString() } = {}) {
  const market = {
    id: 'spread-1', type: 'spreads', question: 'Spread: ' + line, closed: false, acceptingOrders: true,
    outcomes: [{ name: 'Utah Jazz', tokenId: 'uta-token' }, { name: 'Memphis Grizzlies', tokenId: 'mem-token' }],
  };
  return {
    mode, status,
    events: [{ id: 'event-1', title: 'Utah Jazz vs. Memphis Grizzlies', startTime: '2026-10-26T02:00:00.000Z', markets: [market] }],
    books: { 'mem-token': { tokenId: 'mem-token', source: 'live', error: null, verifiedAt, asks: [{ price: 0.45, size: 30 }], bids: [{ price: 0.42, size: 30 }] } },
  };
}

function fakeReceiver({ running = true, lastPollAt = new Date(now - 1000).toISOString() } = {}) {
  return { status: () => ({ configured: true, running, lastPollAt, lastError: null, stopReason: null }), start() {}, async stop() {} };
}

const env = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_ALLOWED_CHAT_IDS: '-100123',
  POLYMARKET_PRIVATE_KEY: '0xprivate-test-value',
  POLYMARKET_WALLET: '0x0000000000000000000000000000000000000001',
};

function makeExecutor({ state, client, clientFactory, store, env: envOverride, clock = () => now, receiver = fakeReceiver() } = {}) {
  return new TradingExecutor({
    monitor: { snapshot: () => state ?? marketState() },
    store,
    receiver,
    env: envOverride ?? env,
    clock,
    clientFactory: clientFactory ?? (async () => client ?? {}),
  });
}

const telegramMessage = (text = signalText) => ({ chatId: '-100123', senderId: '42', kind: 'message', text });

async function enable(ex) {
  await ex.init();
  await ex.configureSettings({ stakeUsdc: 5, buySlippage: 0.02, takeProfitIncrement: 0.02 });
  await ex.enable();
}

function successfulClient(overrides = {}) {
  const calls = [];
  const client = {
    async fetchOrderBook(args) { calls.push(['book', args]); return { assetId: 'mem-token', asks: [{ price: '0.45', size: '20' }] }; },
    async fetchTickSize(args) { calls.push(['tick', args]); return 0.01; },
    async placeMarketOrder(args) { calls.push(['buy', args]); return { ok: true, status: 'matched', orderId: 'buy-1', makingAmount: '5', takingAmount: '10', tradeIds: ['trade-1'], transactionsHashes: [] }; },
    async waitForOrderFillSettlement(order, options) { calls.push(['settle', order, options]); return ['0xhash']; },
    listAccountTrades(args) {
      calls.push(['trades', args]);
      const page = { items: [{ id: 'trade-1', status: 'TRADE_STATUS_CONFIRMED', takerOrderId: 'buy-1', traderSide: 'TAKER', side: 'BUY', assetId: 'mem-token', size: '10' }], nextCursor: null };
      return { async firstPage() { return page; }, from() { return (async function* () {})(); } };
    },
    async placeLimitOrder(args) { calls.push(['sell', args]); return { ok: true, status: 'live', orderId: 'sell-1' }; },
    ...overrides,
  };
  return { client, calls };
}

test('starts disabled, hides credentials, and requires a successful Telegram poll before enabling', async () => {
  let clientCalls = 0;
  const ex = makeExecutor({
    clientFactory: async () => { clientCalls++; return {}; },
    receiver: fakeReceiver({ lastPollAt: null }),
  });
  await ex.init();
  assert.equal(ex.status().enabled, false);
  assert.equal(ex.status().settings.stakeUsdc, null);
  assert.equal(JSON.stringify(ex.status()).includes('test-token'), false);
  assert.equal(JSON.stringify(ex.status()).includes('0xprivate-test-value'), false);
  await ex.configureSettings({ stakeUsdc: 5, buySlippage: 0.02, takeProfitIncrement: 0.02 });
  await assert.rejects(ex.enable(), /首次轮询/);
  assert.equal(clientCalls, 0);
});

test('rejects invalid editable stake and price settings', async () => {
  const ex = makeExecutor();
  await ex.init();
  for (const settings of [
    { stakeUsdc: 0, buySlippage: 0.02, takeProfitIncrement: 0.02 },
    { stakeUsdc: 10001, buySlippage: 0.02, takeProfitIncrement: 0.02 },
    { stakeUsdc: 5, buySlippage: 0.21, takeProfitIncrement: 0.02 },
    { stakeUsdc: 5, buySlippage: 0.02, takeProfitIncrement: 0 },
  ]) await assert.rejects(ex.configureSettings(settings));
});

test('records stale signals without placing a Polymarket order', async () => {
  let clientCalls = 0;
  const oldText = signalText.replace('10-26-2026 08:00:00', '10-26-2026 07:40:00');
  const ex = makeExecutor({ clientFactory: async () => { clientCalls++; return {}; } });
  await enable(ex);
  await ex.onTelegramMessage(telegramMessage(oldText));
  assert.equal(clientCalls, 1, 'client initializes on explicit enable only');
  assert.equal(ex.status().records[0].status, 'skipped');
  assert.match(ex.status().records[0].reason, /过期/);
});

test('skips a signal with no unique exact handicap market', async () => {
  const { client, calls } = successfulClient();
  const ex = makeExecutor({ state: marketState({ line: 'Utah Jazz (-2.5)' }), client });
  await enable(ex);
  await ex.onTelegramMessage(telegramMessage());
  assert.equal(ex.status().records[0].status, 'skipped');
  assert.match(ex.status().records[0].reason, /完全匹配/);
  assert.equal(calls.length, 0);
});

test('persists source order IDs before action and never duplicates a signal', async () => {
  const saved = [];
  const store = { async load() { return null; }, async save(state) { saved.push(state); } };
  const { client, calls } = successfulClient();
  const ex = makeExecutor({ client, store });
  await enable(ex);
  await ex.onTelegramMessage(telegramMessage());
  await ex.onTelegramMessage(telegramMessage());
  assert.equal(ex.status().records.length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'buy').length, 1);
  assert.ok(saved.some(state => state.processedIds.includes('25594626127')));
  assert.equal(saved.some(state => Object.keys(state).some(key => /token|private/i.test(key))), false);
});

test('submits a protected FAK buy then a confirmed-quantity take-profit limit sell', async () => {
  const { client, calls } = successfulClient();
  const ex = makeExecutor({ client });
  await enable(ex);
  await ex.onTelegramMessage(telegramMessage());
  const buy = calls.find(([kind]) => kind === 'buy')[1];
  assert.deepEqual(buy, {
    assetId: 'mem-token', amount: 5, maxSpend: 5, maxPrice: 0.47, side: 'BUY', orderType: 'FAK',
  });
  assert.deepEqual(calls.find(([kind]) => kind === 'settle').slice(2), [{ timeoutMs: 30_000 }]);
  assert.deepEqual(calls.find(([kind]) => kind === 'sell')[1], {
    assetId: 'mem-token', side: 'SELL', price: 0.52, size: 10,
  });
  assert.equal(ex.status().records[0].status, 'take_profit_ordered');
  assert.equal(ex.status().records[0].entryPrice, 0.5);
  assert.equal(ex.status().records[0].shares, 10);
});

test('does not place a sell when the fill records are not confirmed or do not reconcile', async () => {
  const { client, calls } = successfulClient();
  client.listAccountTrades = () => ({
    async firstPage() { return { items: [{ id: 'trade-1', status: 'TRADE_STATUS_MINED', takerOrderId: 'buy-1', traderSide: 'TAKER', side: 'BUY', assetId: 'mem-token', size: '10' }] }; },
    from() { return (async function* () {})(); },
  });
  const ex = makeExecutor({ client });
  await enable(ex);
  await ex.onTelegramMessage(telegramMessage());
  assert.equal(calls.some(([kind]) => kind === 'sell'), false);
  assert.equal(ex.status().records[0].status, 'manual_review');
  assert.match(ex.status().records[0].reason, /需人工核对/);
});

test('requires credentials, local allowlists, and a live market before trading can be enabled', async () => {
  const missingEnv = makeExecutor({ env: { TELEGRAM_ALLOWED_CHAT_IDS: '-100123' } });
  await missingEnv.init();
  await missingEnv.configureSettings({ stakeUsdc: 5, buySlippage: 0.02, takeProfitIncrement: 0.02 });
  await assert.rejects(missingEnv.enable(), /Telegram Bot token/);

  const demo = makeExecutor({ state: marketState({ mode: 'demo' }) });
  await demo.init();
  await demo.configureSettings({ stakeUsdc: 5, buySlippage: 0.02, takeProfitIncrement: 0.02 });
  await assert.rejects(demo.enable(), /模拟模式/);
  assert.equal(demo.status().enabled, false);
});

test('accepts a confirmed partial FAK fill but sells only the confirmed shares', async () => {
  const { client, calls } = successfulClient({
    async placeMarketOrder(args) {
      calls.push(['buy', args]);
      return { ok: true, status: 'matched', orderId: 'buy-1', makingAmount: '2.5', takingAmount: '5', tradeIds: ['trade-1'], transactionsHashes: [] };
    },
    listAccountTrades(args) {
      calls.push(['trades', args]);
      const page = { items: [{ id: 'trade-1', status: 'TRADE_STATUS_CONFIRMED', takerOrderId: 'buy-1', traderSide: 'TAKER', side: 'BUY', assetId: 'mem-token', size: '5' }], nextCursor: null };
      return { async firstPage() { return page; }, from() { return (async function* () {})(); } };
    },
  });
  const ex = makeExecutor({ client });
  await enable(ex);
  await ex.onTelegramMessage(telegramMessage());
  assert.equal(calls.find(([kind]) => kind === 'sell')[1].size, 5);
  assert.equal(ex.status().records[0].entryPrice, 0.5);
});

test('keeps a fill for manual review when confirmed USDC spend exceeds the configured cap', async () => {
  const { client, calls } = successfulClient({
    async placeMarketOrder(args) {
      calls.push(['buy', args]);
      return { ok: true, status: 'matched', orderId: 'buy-1', makingAmount: '5.01', takingAmount: '10', tradeIds: ['trade-1'], transactionsHashes: [] };
    },
  });
  const ex = makeExecutor({ client });
  await enable(ex);
  await ex.onTelegramMessage(telegramMessage());
  assert.equal(calls.some(([kind]) => kind === 'sell'), false);
  assert.equal(ex.status().records[0].status, 'manual_review');
  assert.match(ex.status().records[0].reason, /支出超过/);
});

test('recovers persisted in-flight work as manual review before becoming ready', async () => {
  let persisted;
  const store = {
    async load() {
      return {
        settings: { stakeUsdc: 5, buySlippage: 0.02, takeProfitIncrement: 0.02 },
        processedIds: ['25594626127'],
        records: [{ id: '25594626127', status: 'processing', createdAt: new Date(now).toISOString() }],
      };
    },
    async save(state) { persisted = state; },
  };
  const ex = makeExecutor({ store });
  await ex.init();
  assert.equal(ex.status().records[0].status, 'manual_review');
  assert.match(ex.status().records[0].reason, /中断/);
  assert.equal(persisted.records[0].status, 'manual_review');
});
