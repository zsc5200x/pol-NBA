import { EventEmitter } from 'node:events';
import { RANGES, TIMEZONES, normalizeBook, selectEvents, updateLevel } from './domain.mjs';
import { Polymarket } from './upstream.mjs';

const iso = () => new Date().toISOString();

export class Monitor extends EventEmitter {
  constructor({ demo = false, upstream = new Polymarket(), range = 'upcoming', timezone = 'Asia/Shanghai' } = {}) {
    super();
    this.demo = demo;
    this.upstream = upstream;
    this.state = {
      mode: demo ? 'demo' : 'live', status: 'connecting', updatedAt: null, verifiedAt: null,
      eventsUpdatedAt: null, error: null, refreshSeconds: 3, timezone, range,
      events: [], books: {}, stream: { connected: false, lastMessageAt: null, bookMessages: 0, priceChanges: 0 },
    };
    this.tokens = [];
    this.generation = 0;
    this.stopped = true;
    this.reconnectDelay = 1000;
    this.discoveryError = null;
    this.bookError = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.demo) {
      this.makeDemo();
      this.demoTimer = setInterval(() => this.makeDemoBooks(), 3000);
      this.eventTimer = setInterval(() => this.makeDemo(), 60000);
    } else {
      void this.refreshEvents();
      this.eventTimer = setInterval(() => void this.refreshEvents(), 60000);
      this.bookTimer = setInterval(() => {
        if (!this.state.stream.connected || Date.now() - (this.lastResync ?? 0) > 15000) void this.refreshBooks();
        this.publish();
      }, 3000);
    }
  }

  stop() {
    this.stopped = true;
    this.generation++;
    for (const timer of [this.eventTimer, this.bookTimer, this.demoTimer, this.broadcastTimer]) clearInterval(timer);
    this.disconnect();
  }

  setSettings({ range, timezone }) {
    if ((range !== undefined && !RANGES.has(range)) || (timezone !== undefined && !TIMEZONES.has(timezone))) {
      throw new Error('Unsupported date range or timezone');
    }
    if ((range ?? this.state.range) === this.state.range && (timezone ?? this.state.timezone) === this.state.timezone) return;
    this.generation++;
    Object.assign(this.state, {
      range: range ?? this.state.range, timezone: timezone ?? this.state.timezone,
      events: [], books: {}, eventsUpdatedAt: null, updatedAt: null, verifiedAt: null, error: null, status: 'connecting',
    });
    this.tokens = [];
    this.discoveryError = this.bookError = null;
    this.disconnect();
    if (this.demo) this.makeDemo();
    else void this.refreshEvents();
    this.publish();
  }

  snapshot() {
    return this.state;
  }

  publish() {
    if (this.stopped) return;
    if (!this.demo) {
      const fresh = this.tokens.filter(id => this.state.books[id] && !this.state.books[id].error &&
        Date.now() - Date.parse(this.state.books[id].verifiedAt ?? this.state.books[id].updatedAt) < 30000).length;
      this.state.status = !this.state.eventsUpdatedAt ? (this.discoveryError ? 'offline' : 'connecting')
        : this.discoveryError || this.bookError || fresh < this.tokens.length ? (fresh ? 'degraded' : this.tokens.length ? 'offline' : 'degraded')
          : 'live';
      this.state.error = [this.discoveryError, this.bookError].filter(Boolean).join(' · ') || null;
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      if (!this.stopped) this.emit('state', this.state);
    }, 250);
  }

  async refreshEvents() {
    if (this.stopped || this.demo) return;
    if (this.discoveryPending) return this.discoveryPending;
    const generation = this.generation;
    this.discoveryPending = (async () => {
      try {
        const raw = await this.upstream.discover({ range: this.state.range });
        if (this.stopped || generation !== this.generation) return;
        this.state.events = selectEvents(raw, this.state);
        this.state.eventsUpdatedAt = iso();
        this.discoveryError = null;
        const tokens = [...new Set(this.state.events.flatMap(e => e.markets.filter(m => !m.closed)
          .flatMap(m => m.outcomes.map(o => o.tokenId))))].sort();
        if (tokens.join(',') !== this.tokens.join(',')) {
          this.tokens = tokens;
          this.state.books = Object.fromEntries(tokens.filter(t => this.state.books[t]).map(t => [t, this.state.books[t]]));
          this.disconnect();
          this.connect();
        } else if (!this.ws && tokens.length) this.connect();
        await this.refreshBooks();
      } catch (error) {
        if (generation === this.generation && !this.stopped) this.discoveryError = `比赛列表获取失败：${error.message}`;
      } finally {
        this.discoveryPending = null;
        this.publish();
        if (generation !== this.generation && !this.stopped) void this.refreshEvents();
      }
    })();
    return this.discoveryPending;
  }

  async refreshBooks() {
    if (this.stopped || this.demo || !this.tokens.length || this.booksPending) return;
    this.booksPending = true;
    const generation = this.generation;
    const ids = [...this.tokens];
    const failures = [];
    const pending = [];
    for (let i = 0; i < ids.length; i += 50) pending.push(ids.slice(i, i + 50));
    const worker = async () => {
      while (pending.length && !this.stopped && generation === this.generation) {
        const batch = pending.shift();
        const started = Date.now();
        try {
          const raw = await this.upstream.books(batch);
          if (this.stopped || generation !== this.generation) return;
          const returned = new Set();
          for (const item of raw) {
            const book = normalizeBook(item);
            if (!batch.includes(book.tokenId)) continue;
            returned.add(book.tokenId);
            const old = this.state.books[book.tokenId];
            if (old && !old.error && (book.timestamp && old.timestamp > book.timestamp || !book.timestamp && Date.parse(old.updatedAt) > started)) continue;
            this.state.books[book.tokenId] = book;
          }
          for (const token of batch) {
            if (!returned.has(token)) {
              this.markBookError(token, '该标的未返回订单簿（可能已关闭）');
              failures.push('部分标的未返回订单簿');
            }
          }
        } catch (error) {
          if (generation !== this.generation || this.stopped) return;
          failures.push(error.message);
          for (const id of batch) this.markBookError(id, error.message);
        }
      }
    };
    try { await Promise.all([worker(), worker()]); }
    finally {
      this.booksPending = false;
      if (generation === this.generation && !this.stopped) {
        this.lastResync = Date.now();
        this.bookError = failures.length ? `订单簿获取失败：${[...new Set(failures)].join('; ')}` : null;
        if (!failures.length) this.state.verifiedAt = this.state.updatedAt = iso();
        this.publish();
      }
    }
  }

  markBookError(tokenId, error) {
    const book = this.state.books[tokenId] ?? { tokenId, bids: [], asks: [], updatedAt: null, source: 'live', timestamp: 0 };
    book.error = error;
    this.state.books[tokenId] = book;
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    if (this.ws) {
      for (const id of this.tokens) if (this.state.books[id]) this.markBookError(id, '订阅重建中，等待完整快照校准');
      const socket = this.ws;
      this.ws = null;
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.terminate();
    }
    this.state.stream.connected = false;
  }

  connect() {
    if (this.stopped || this.demo || !this.tokens.length || this.ws) return;
    let socket;
    try { socket = this.upstream.socket(); }
    catch { this.scheduleReconnect(); return; }
    this.ws = socket;
    let lastPong = Date.now();
    socket.on('open', () => {
      if (this.ws !== socket) return;
      this.state.stream.connected = true;
      this.reconnectDelay = 1000;
      socket.send(JSON.stringify({ assets_ids: this.tokens, type: 'market', custom_feature_enabled: false }));
      this.heartbeatTimer = setInterval(() => {
        if (Date.now() - lastPong > 30000) { socket.terminate(); return; }
        if (socket.readyState === 1) socket.send('PING');
      }, 10000);
      this.publish();
    });
    socket.on('message', data => {
      if (this.ws !== socket || this.stopped) return;
      const text = data.toString();
      if (text === 'PONG') {
        lastPong = Date.now();
        this.verifyStream();
        return;
      }
      let messages;
      try { const parsed = JSON.parse(text); messages = Array.isArray(parsed) ? parsed : [parsed]; }
      catch { return; }
      for (const message of messages) this.applyMessage(message);
    });
    socket.on('error', () => { /* close schedules retry; REST remains available */ });
    socket.on('close', () => {
      if (this.ws !== socket) return;
      this.ws = null;
      clearInterval(this.heartbeatTimer);
      this.state.stream.connected = false;
      // Preserve the visible book but mark it invalid until a fresh full snapshot arrives.
      for (const id of this.tokens) this.markBookError(id, '连接已中断，等待完整快照校准');
      void this.refreshBooks();
      this.scheduleReconnect();
      this.publish();
    });
  }

  scheduleReconnect() {
    if (this.stopped || !this.tokens.length) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  verifyStream() {
    if (!this.state.stream.connected) return;
    const now = iso();
    for (const book of Object.values(this.state.books)) {
      if (book.updatedAt && !book.error) book.verifiedAt = now;
    }
    this.state.verifiedAt = now;
    this.publish();
  }

  applyMessage(message) {
    if (!message || typeof message !== 'object') return;
    let changed = false;
    if (message.event_type === 'book' && this.tokens.includes(String(message.asset_id))) {
      const book = normalizeBook(message);
      const old = this.state.books[book.tokenId];
      if (!old || old.error || !book.timestamp || book.timestamp >= old.timestamp) {
        this.state.books[book.tokenId] = book;
        changed = true;
      }
    } else if (message.event_type === 'price_change') {
      for (const change of message.price_changes ?? []) {
        const book = this.state.books[String(change.asset_id)];
        // Never construct a partial book from deltas; wait for a complete snapshot.
        if (!book || book.error || !book.updatedAt || (Number(message.timestamp) || 0) < book.timestamp) continue;
        if (updateLevel(book, change)) {
          book.timestamp = Number(message.timestamp) || book.timestamp;
          changed = true;
        }
      }
    }
    if (changed) {
      this.state.verifiedAt = this.state.updatedAt = iso();
      this.state.stream.lastMessageAt = this.state.updatedAt;
      if (message.event_type === 'book') this.state.stream.bookMessages++;
      else this.state.stream.priceChanges++;
      this.publish();
    }
  }

  makeDemo() {
    const now = new Date();
    const pairs = [['湖人', '勇士'], ['凯尔特人', '尼克斯'], ['掘金', '雷霆']];
    const raw = pairs.map(([a, b], i) => {
      const offset = this.state.range === 'past' ? -i : i;
      const start = new Date(now.getTime() + offset * 86400000);
      return {
        id: `demo-event-${i}`, title: `${a} vs. ${b}（演示）`, slug: '', startTime: start.toISOString(),
        markets: [
          ['moneyline', `${a} vs. ${b} · 胜负`, [a, b]],
          ['spreads', `${a} -3.5 · 让分`, [`${a} -3.5`, `${b} +3.5`]],
          ['totals', '总分 225.5 · 大小分', ['大于 225.5', '小于 225.5']],
        ].map(([sportsMarketType, question, outcomes], j) => ({
          id: `demo-market-${i}-${j}`, question, sportsMarketType, outcomes,
          clobTokenIds: outcomes.map((_, k) => `demo-token-${i}-${j}-${k}`), outcomePrices: ['0.54', '0.46'],
        })),
      };
    });
    this.state.events = selectEvents(raw, { ...this.state, now });
    this.state.eventsUpdatedAt = iso();
    this.state.books = {};
    this.makeDemoBooks();
  }

  makeDemoBooks() {
    this.state.events.forEach((event, i) => event.markets.forEach((market, j) => market.outcomes.forEach((outcome, k) => {
      const drift = Math.sin(Date.now() / 30000 + i + j) * 0.015;
      const midpoint = k ? 0.46 - drift : 0.54 + drift;
      const levels = sign => Array.from({ length: 14 }, (_, n) => ({
        price: Math.round((midpoint + sign * (0.01 + n * 0.01)) * 100) / 100,
        size: Math.round(120 + (Math.sin(i + j + k + n) + 1) * 950 + n * 80),
      }));
      this.state.books[outcome.tokenId] = {
        tokenId: outcome.tokenId, bids: levels(-1), asks: levels(1), updatedAt: iso(), verifiedAt: iso(), source: 'demo', error: null,
      };
    })));
    this.state.verifiedAt = this.state.updatedAt = iso();
    this.state.status = 'live';
    this.state.error = null;
    this.publish();
  }
}
