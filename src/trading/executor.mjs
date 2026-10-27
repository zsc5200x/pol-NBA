import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parseTradingSignal } from './signal.mjs';
import { resolveTradingMarket } from './matcher.mjs';
import { TelegramReceiver, parseTelegramAllowlist } from './telegram.mjs';

const DEFAULT_SETTINGS = Object.freeze({ stakeUsdc: null, buySlippage: 0.02, takeProfitIncrement: 0.02 });
const MAX_RECORDS = 200;
const MAX_PROCESSED_IDS = 2000;
const TRADE_CONFIRMED = 'TRADE_STATUS_CONFIRMED';

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatPrice(value, tick) {
  const precision = Math.min(8, Math.max(
    decimalPlaces(tick),
    decimalPlaces(value),
  ));
  const scale = 10 ** precision;
  const tickUnits = Math.round(tick * scale);
  if (!tickUnits) return null;
  const units = Math.ceil((value * scale - 1e-8) / tickUnits) * tickUnits;
  return Number((units / scale).toFixed(precision));
}

function decimalPlaces(value) {
  const text = String(value).toLowerCase();
  if (text.includes('e-')) return Number(text.split('e-')[1]) || 0;
  return (text.split('.')[1] ?? '').length;
}

function safeMessageReason(code) {
  const reasons = {
    INVALID_MESSAGE: '消息格式无效',
    UNSUPPORTED_LEAGUE: '仅支持 NBA 信号',
    MISSING_MATCHUP: '缺少比赛信息',
    DUPLICATE_MATCHUP: '比赛信息重复',
    CONFLICTING_FIELD: '信号字段冲突',
    MISSING_FIELD: '缺少必要字段',
    INVALID_SELECTION: '盘口选择格式无效',
    UNKNOWN_SELECTION_TEAM: '无法识别选择的球队',
    INVALID_SOURCE_ODDS: '信号赔率无效',
    INVALID_TIME: '信号时间格式无效',
    INVALID_OR_AMBIGUOUS_TIME: '信号时间无效或存在歧义',
    UNKNOWN_OR_AMBIGUOUS_MATCHUP: '无法唯一识别比赛球队',
    UNSUPPORTED_SESSION: '不支持该信号时段',
    UNSUPPORTED_MARKET: '仅支持让分盘口',
    UNSUPPORTED_PERIOD: '仅支持全场盘口',
    SELECTION_TEAM_NOT_IN_MATCHUP: '选择球队不属于该场比赛',
    INVALID_EXTERNAL_ID: '信号单号无效',
    INVALID_ORIGINAL_STAKE: '原注金额无效',
    INVALID_COPY_STAKE: '跟单金额无效',
    INVALID_FOLLOWED_AMOUNT: '跟单成功金额无效',
  };
  return reasons[code] ?? '信号无法解析';
}

async function createSdkClient(env) {
  const [{ createSecureClient }, { privateKey }] = await Promise.all([
    import('@polymarket/client'),
    import('@polymarket/client/viem'),
  ]);
  return createSecureClient({
    wallet: env.POLYMARKET_WALLET,
    signer: privateKey(env.POLYMARKET_PRIVATE_KEY),
  });
}

export class TradingExecutor extends EventEmitter {
  constructor({ monitor, store, env = process.env, clientFactory = createSdkClient, receiver, clock = Date.now } = {}) {
    super();
    this.monitor = monitor;
    this.store = store;
    this.env = env;
    this.clientFactory = clientFactory;
    this.clock = clock;
    this.enabled = false;
    this.client = null;
    this.storageReady = !store;
    this.storageFaulted = false;
    this.settings = { ...DEFAULT_SETTINGS };
    this.records = [];
    this.processedIds = [];
    this.activeOrderWork = null;
    this.messageQueue = Promise.resolve();
    this.saveQueue = Promise.resolve();
    this.allowedChats = this.#parseIds(env.TELEGRAM_ALLOWED_CHAT_IDS) ?? new Set();
    this.allowedSenders = this.#parseIds(env.TELEGRAM_ALLOWED_SENDER_IDS) ?? new Set();
    this.senderAllowlistValid = !String(env.TELEGRAM_ALLOWED_SENDER_IDS ?? '').trim()
      || this.#parseIds(env.TELEGRAM_ALLOWED_SENDER_IDS) !== null;

    const hasTelegramConfig = typeof env.TELEGRAM_BOT_TOKEN === 'string'
      && env.TELEGRAM_BOT_TOKEN.trim() && this.allowedChats.size > 0 && this.senderAllowlistValid;
    this.receiver = receiver ?? (hasTelegramConfig ? new TelegramReceiver({
      token: env.TELEGRAM_BOT_TOKEN,
      allowedChatIds: this.allowedChats,
      allowedSenderIds: this.allowedSenders,
      onSignal: message => this.onTelegramMessage(message),
    }) : null);
    this.receiverConfigured = Boolean(receiver || hasTelegramConfig);
    this.initialization = null;
  }

  #parseIds(value) {
    try { return parseTelegramAllowlist(value); } catch { return null; }
  }

  async init() {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      if (!this.store) {
        this.storageReady = true;
        return this.status();
      }
      try {
        const saved = await this.store.load();
        if (saved && typeof saved === 'object') {
          this.settings = this.#validateSettings(saved.settings ?? DEFAULT_SETTINGS);
          this.records = Array.isArray(saved.records) ? saved.records
            .filter(record => record && typeof record === 'object').slice(-MAX_RECORDS) : [];
          this.processedIds = Array.isArray(saved.processedIds)
            ? [...new Set(saved.processedIds.filter(id => typeof id === 'string'))].slice(-MAX_PROCESSED_IDS) : [];
          let recoveredWork = false;
          for (const record of this.records) {
            if (record.status === 'processing') {
              Object.assign(record, { status: 'manual_review', reason: '服务中断前订单处理未完成，需人工核对' });
              recoveredWork = true;
            }
          }
          if (recoveredWork) await this.#persist();
        }
        this.storageReady = true;
      } catch {
        this.storageReady = false;
        this.storageFaulted = true;
      }
      return this.status();
    })();
    return this.initialization;
  }

  startReceiver() {
    if (!this.receiver || !this.receiverConfigured) return false;
    void this.init().then(() => this.receiver.start());
    return true;
  }

  status() {
    const receiverStatus = this.receiver?.status?.() ?? {};
    const telegramConfigured = this.receiverConfigured
      && typeof this.env.TELEGRAM_BOT_TOKEN === 'string' && this.env.TELEGRAM_BOT_TOKEN.trim()
      && this.allowedChats.size > 0 && this.senderAllowlistValid;
    const polymarketConfigured = Boolean(
      typeof this.env.POLYMARKET_PRIVATE_KEY === 'string' && this.env.POLYMARKET_PRIVATE_KEY.trim()
      && typeof this.env.POLYMARKET_WALLET === 'string' && this.env.POLYMARKET_WALLET.trim(),
    );
    const snapshot = this.#marketState();
    const ready = this.storageReady && telegramConfigured && polymarketConfigured
      && receiverStatus.running === true && Boolean(receiverStatus.lastPollAt)
      && this.settings.stakeUsdc !== null && snapshot?.mode === 'live' && snapshot?.status === 'live';
    return {
      enabled: this.enabled,
      ready,
      storageReady: this.storageReady,
      settings: { ...this.settings },
      credentials: { telegram: telegramConfigured, polymarket: polymarketConfigured },
      receiver: {
        configured: telegramConfigured,
        running: receiverStatus.running === true,
        lastPollAt: receiverStatus.lastPollAt ?? null,
        lastError: receiverStatus.lastError ?? null,
        stopReason: receiverStatus.stopReason ?? null,
      },
      records: this.records.slice(-50).reverse().map(record => this.#publicRecord(record)),
    };
  }

  #publicRecord(record) {
    const allowed = ['id', 'status', 'reason', 'team', 'handicap', 'stakeUsdc', 'entryPrice', 'shares',
      'exitPrice', 'buyOrderId', 'sellOrderId', 'createdAt'];
    return Object.fromEntries(allowed.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  }

  #marketState() {
    try { return this.monitor?.snapshot?.() ?? null; } catch { return null; }
  }

  #validateSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('配置格式无效');
    if (Object.keys(input).some(key => !['stakeUsdc', 'buySlippage', 'takeProfitIncrement'].includes(key))) {
      throw new TypeError('包含不支持的交易设置');
    }
    const stakeUsdc = input.stakeUsdc === null ? null : Number(input.stakeUsdc);
    const buySlippage = Number(input.buySlippage);
    const takeProfitIncrement = Number(input.takeProfitIncrement);
    if (stakeUsdc !== null && (!Number.isFinite(stakeUsdc) || stakeUsdc < 1 || stakeUsdc > 10000)) {
      throw new RangeError('每单金额需在 1 至 10000 USDC 之间');
    }
    if (!Number.isFinite(buySlippage) || buySlippage < 0 || buySlippage > 0.2) {
      throw new RangeError('买入滑点需在 0 至 0.20 之间');
    }
    if (!Number.isFinite(takeProfitIncrement) || takeProfitIncrement < 0.001 || takeProfitIncrement > 0.1) {
      throw new RangeError('止盈加价需在 0.001 至 0.10 之间');
    }
    return { stakeUsdc, buySlippage, takeProfitIncrement };
  }

  async configureSettings(settings) {
    await this.init();
    if (this.enabled || this.activeOrderWork) throw new Error('请先停止自动交易并等待当前订单处理完成');
    const next = this.#validateSettings(settings);
    this.settings = next;
    await this.#persist();
    this.#publish();
    return this.status();
  }

  async enable() {
    await this.init();
    const current = this.status();
    if (!current.storageReady) throw new Error('本机交易记录不可用，已阻止启用');
    if (this.settings.stakeUsdc === null) throw new Error('请先设置每单 USDC 金额');
    if (!current.credentials.telegram) throw new Error('未配置 Telegram Bot token 或允许的 chat ID');
    if (!current.credentials.polymarket) throw new Error('未配置 Polymarket 私钥和钱包地址');
    if (!current.receiver.running || !current.receiver.lastPollAt) throw new Error('Telegram 尚未完成首次轮询');
    const snapshot = this.#marketState();
    if (snapshot?.mode !== 'live' || snapshot?.status !== 'live') throw new Error('实时行情尚未就绪，或当前处于模拟模式');
    if (!this.client) {
      try { this.client = await this.clientFactory(this.env); }
      catch { throw new Error('Polymarket 客户端初始化失败，请检查本机密钥和钱包配置'); }
    }
    this.enabled = true;
    this.#publish();
    return this.status();
  }

  async disable() {
    this.enabled = false;
    this.#publish();
    if (this.activeOrderWork) await this.activeOrderWork.catch(() => {});
    return this.status();
  }

  async close() {
    this.enabled = false;
    this.#publish();
    if (this.activeOrderWork) await this.activeOrderWork.catch(() => {});
    await this.receiver?.stop?.();
  }

  onTelegramMessage(message) {
    const task = this.messageQueue.then(() => this.#handleTelegramMessage(message));
    this.messageQueue = task.catch(() => {});
    return task;
  }

  async #handleTelegramMessage(message) {
    await this.init();
    if (!this.#authorizedMessage(message)) return null;

    let signal;
    try { signal = parseTradingSignal(message.text); }
    catch (error) {
      await this.#appendRecord({
        id: randomUUID(), status: 'skipped', reason: safeMessageReason(error.code), createdAt: new Date(this.clock()).toISOString(),
      });
      return null;
    }

    if (this.processedIds.includes(signal.idempotencyKey)) return null;
    this.processedIds.push(signal.idempotencyKey);
    if (this.processedIds.length > MAX_PROCESSED_IDS) this.processedIds.splice(0, this.processedIds.length - MAX_PROCESSED_IDS);
    const record = {
      id: signal.externalId,
      status: 'processing',
      reason: null,
      team: signal.selection.teamName,
      handicap: signal.selection.handicap,
      stakeUsdc: this.settings.stakeUsdc,
      createdAt: new Date(this.clock()).toISOString(),
    };
    await this.#appendRecord(record);

    const now = this.clock();
    const signalTime = Date.parse(signal.sourceTime.instant);
    if (!Number.isFinite(signalTime) || signalTime < now - 15 * 60_000 || signalTime > now + 2 * 60_000) {
      await this.#updateRecord(record, { status: 'skipped', reason: '信号已过期或时间超前' });
      return this.#publicRecord(record);
    }
    if (!this.enabled) {
      await this.#updateRecord(record, { status: 'skipped', reason: '自动交易未启用' });
      return this.#publicRecord(record);
    }

    const state = this.#marketState();
    const match = resolveTradingMarket(signal, state, { now });
    if (match.status !== 'matched') {
      await this.#updateRecord(record, { status: 'skipped', reason: match.reason ?? '没有可执行的盘口' });
      return this.#publicRecord(record);
    }

    const execution = this.#execute(signal, match, record);
    this.activeOrderWork = execution;
    try { return await execution; }
    finally { if (this.activeOrderWork === execution) this.activeOrderWork = null; }
  }

  #authorizedMessage(message) {
    if (!message || typeof message.text !== 'string' || !this.allowedChats.has(String(message.chatId ?? ''))) return false;
    if (this.allowedSenders.size && message.kind !== 'channel_post') {
      return Boolean(message.senderId && this.allowedSenders.has(String(message.senderId)));
    }
    return true;
  }

  async #execute(signal, match, record) {
    let buyAttempted = false;
    try {
      if (!this.enabled) {
        await this.#updateRecord(record, { status: 'skipped', reason: '自动交易已停止' });
        return this.#publicRecord(record);
      }
      const [book, tickValue] = await Promise.all([
        this.client.fetchOrderBook({ assetId: match.tokenId }),
        this.client.fetchTickSize({ assetId: match.tokenId }),
      ]);
      const tick = finitePositive(tickValue);
      const asks = Array.isArray(book?.asks) ? book.asks : [];
      const bestAsk = asks.filter(level => Number.isFinite(Number(level.size)) && Number(level.size) > 0)
        .map(level => Number(level.price))
        .filter(price => Number.isFinite(price) && price > 0 && price < 1)
        .sort((left, right) => left - right)[0];
      if (!tick || !bestAsk || (book.assetId && book.assetId !== match.tokenId)) {
        await this.#updateRecord(record, { status: 'skipped', reason: 'Polymarket 最新订单簿无有效卖价或价格精度' });
        return this.#publicRecord(record);
      }
      const maxPrice = formatPrice(bestAsk + this.settings.buySlippage, tick);
      if (!maxPrice || maxPrice >= 1) {
        await this.#updateRecord(record, { status: 'skipped', reason: '买入限价需要达到或超过 1.00，已跳过' });
        return this.#publicRecord(record);
      }

      if (!this.enabled) {
        await this.#updateRecord(record, { status: 'skipped', reason: '下单前自动交易已停止' });
        return this.#publicRecord(record);
      }
      buyAttempted = true;
      const buy = await this.client.placeMarketOrder({
        assetId: match.tokenId,
        amount: this.settings.stakeUsdc,
        maxSpend: this.settings.stakeUsdc,
        maxPrice,
        side: 'BUY',
        orderType: 'FAK',
      });
      if (!buy?.ok) {
        await this.#updateRecord(record, { status: 'skipped', reason: 'Polymarket 拒绝买入订单' });
        return this.#publicRecord(record);
      }

      const makingAmount = finitePositive(buy.makingAmount);
      const takingAmount = finitePositive(buy.takingAmount);
      const tradeIds = Array.isArray(buy.tradeIds) ? [...new Set(buy.tradeIds.filter(id => typeof id === 'string' && id))] : [];
      if (String(buy.status).toLowerCase() !== 'matched' || !makingAmount || !takingAmount
        || tradeIds.length === 0 || tradeIds.length !== buy.tradeIds.length) {
        await this.#updateRecord(record, {
          status: 'manual_review', buyOrderId: buy.orderId ?? null,
          reason: '买入成交数量或成交标识异常，需人工核对',
        });
        return this.#publicRecord(record);
      }
      if (makingAmount > this.settings.stakeUsdc + 1e-6) {
        await this.#updateRecord(record, {
          status: 'manual_review', buyOrderId: buy.orderId ?? null,
          entryPrice: makingAmount / takingAmount, shares: takingAmount,
          reason: '买入回报支出超过每单 USDC 上限，需人工核对',
        });
        return this.#publicRecord(record);
      }

      await this.client.waitForOrderFillSettlement(buy, { timeoutMs: 30_000 });
      const shares = await this.#confirmedBuyShares(tradeIds, buy.orderId, match.tokenId);
      if (Math.abs(shares - takingAmount) > 1e-6) {
        await this.#updateRecord(record, {
          status: 'manual_review', buyOrderId: buy.orderId, entryPrice: makingAmount / takingAmount,
          shares, reason: '确认成交份额与买单回报不一致，未提交卖单',
        });
        return this.#publicRecord(record);
      }

      const entryPrice = makingAmount / takingAmount;
      const exitPrice = formatPrice(entryPrice + this.settings.takeProfitIncrement, tick);
      if (!exitPrice || exitPrice >= 0.99) {
        await this.#updateRecord(record, {
          status: 'manual_review', buyOrderId: buy.orderId, entryPrice, shares,
          reason: '止盈价达到 0.99 或以上，未提交卖单',
        });
        return this.#publicRecord(record);
      }

      const sell = await this.client.placeLimitOrder({
        assetId: match.tokenId,
        side: 'SELL',
        price: exitPrice,
        size: shares,
      });
      if (!sell?.ok) {
        await this.#updateRecord(record, {
          status: 'manual_review', buyOrderId: buy.orderId, entryPrice, shares, exitPrice,
          reason: '止盈卖单未被 Polymarket 接受，需人工核对持仓',
        });
        return this.#publicRecord(record);
      }
      await this.#updateRecord(record, {
        status: 'take_profit_ordered', reason: '买入成交已确认，止盈限价卖单已提交',
        buyOrderId: buy.orderId, sellOrderId: sell.orderId, entryPrice, shares, exitPrice,
      });
      return this.#publicRecord(record);
    } catch {
      await this.#updateRecord(record, {
        status: buyAttempted ? 'manual_review' : 'skipped',
        reason: buyAttempted ? '买入后处理未完成，需人工核对成交与持仓' : '读取最新盘口或准备交易失败',
      });
      return this.#publicRecord(record);
    }
  }

  async #confirmedBuyShares(tradeIds, orderId, assetId) {
    let total = 0;
    for (const tradeId of tradeIds) {
      const paginator = this.client.listAccountTrades({ id: tradeId });
      const first = await paginator.firstPage();
      const items = Array.isArray(first?.items) ? [...first.items] : [];
      if (first?.nextCursor) {
        for await (const page of paginator.from(first.nextCursor)) {
          if (!Array.isArray(page?.items)) throw new Error('trade page invalid');
          items.push(...page.items);
        }
      }
      const trades = items.filter(trade => trade?.id === tradeId);
      if (trades.length !== 1) throw new Error('trade missing or ambiguous');
      const trade = trades[0];
      if (trade.status !== TRADE_CONFIRMED || trade.takerOrderId !== orderId || trade.traderSide !== 'TAKER'
        || trade.side !== 'BUY' || trade.assetId !== assetId) throw new Error('trade is not a confirmed taker buy');
      const size = finitePositive(trade.size);
      if (!size) throw new Error('invalid trade size');
      total += size;
    }
    if (!Number.isFinite(total) || total <= 0) throw new Error('invalid confirmed share count');
    return total;
  }

  async #appendRecord(record) {
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    await this.#persist();
    this.#publish();
  }

  async #updateRecord(record, patch) {
    Object.assign(record, patch);
    await this.#persist();
    this.#publish();
  }

  #persist() {
    if (!this.store) return Promise.resolve();
    const state = {
      settings: { ...this.settings },
      records: this.records.map(record => ({ ...record })),
      processedIds: [...this.processedIds],
    };
    const task = this.saveQueue.then(async () => {
      await this.store.save(state);
      this.storageReady = !this.storageFaulted;
    });
    this.saveQueue = task.catch(() => { this.storageReady = false; this.storageFaulted = true; });
    return task;
  }

  #publish() {
    this.emit('state', this.status());
  }
}
