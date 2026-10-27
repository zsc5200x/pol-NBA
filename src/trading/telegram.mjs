const MAX_RETRY_MS = 30000;

export function parseTelegramAllowlist(value) {
  if (value instanceof Set) return new Set([...value].map(normalizeId));
  if (Array.isArray(value)) return new Set(value.map(normalizeId));
  if (typeof value !== 'string' || !value.trim()) return new Set();
  return new Set(value.split(',').map(item => normalizeId(item.trim())));
}

function normalizeId(value) {
  const id = String(value);
  if (!/^-?\d+$/.test(id)) throw new TypeError('Telegram IDs must be decimal integers');
  return id;
}

function retryDelay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function responseCode(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'request_timeout';
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(error.code)) return error.code.toLowerCase();
  return 'network_error';
}

export class TelegramReceiver {
  constructor({
    token,
    allowedChatIds,
    allowedSenderIds = [],
    onSignal,
    fetchImpl = globalThis.fetch,
    apiBase = 'https://api.telegram.org',
    pollTimeoutSeconds = 25,
    retryMinMs = 1000,
    retryMaxMs = MAX_RETRY_MS,
    sleep = retryDelay,
  } = {}) {
    if (typeof token !== 'string' || !token.trim()) throw new TypeError('Telegram bot token is required');
    if (typeof onSignal !== 'function') throw new TypeError('Telegram signal handler is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
    this.token = token.trim();
    this.allowedChatIds = parseTelegramAllowlist(allowedChatIds);
    this.allowedSenderIds = parseTelegramAllowlist(allowedSenderIds);
    if (this.allowedChatIds.size === 0) throw new TypeError('At least one allowed Telegram chat ID is required');
    this.onSignal = onSignal;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.pollTimeoutSeconds = Math.max(0, Math.min(50, Math.floor(Number(pollTimeoutSeconds) || 0)));
    this.retryMinMs = Math.max(0, Number(retryMinMs) || 0);
    this.retryMaxMs = Math.max(this.retryMinMs, Number(retryMaxMs) || MAX_RETRY_MS);
    this.sleep = sleep;
    this.offset = undefined;
    this.running = false;
    this.loopPromise = null;
    this.controller = null;
    this.retryMs = this.retryMinMs;
    this.lastUpdateAt = null;
    this.lastPollAt = null;
    this.lastError = null;
    this.stopReason = null;
  }

  status() {
    return {
      configured: true,
      running: this.running,
      allowedChats: this.allowedChatIds.size,
      allowedSenders: this.allowedSenderIds.size,
      lastUpdateAt: this.lastUpdateAt,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      stopReason: this.stopReason,
    };
  }

  start() {
    if (this.running) return this.loopPromise;
    this.running = true;
    this.stopReason = null;
    this.controller = new AbortController();
    this.loopPromise = this.#poll(this.controller.signal);
    return this.loopPromise;
  }

  async stop() {
    this.running = false;
    this.controller?.abort();
    await this.loopPromise;
    this.controller = null;
    this.loopPromise = null;
  }

  async #poll(signal) {
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.#getUpdates(signal);
        this.retryMs = this.retryMinMs;
        this.lastError = null;
        const ordered = [...updates].sort((a, b) => Number(a?.update_id) - Number(b?.update_id));
        for (const update of ordered) {
          if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
            throw Object.assign(new Error('Invalid Telegram update'), { code: 'INVALID_UPDATE' });
          }
          const message = this.#message(update);
          if (message) await this.onSignal(message);
          this.offset = update.update_id + 1;
          this.lastUpdateAt = new Date().toISOString();
        }
        this.lastPollAt = new Date().toISOString();
      } catch (error) {
        if (!this.running || signal.aborted) break;
        const code = error.telegramCode ?? responseCode(error);
        this.lastError = code;
        if (code === 'poll_conflict' || code === 'unauthorized' || code === 'invalid_request') {
          this.stopReason = code;
          this.running = false;
          break;
        }
        const waitMs = Math.min(this.retryMaxMs, Math.max(this.retryMinMs, error.retryAfterMs ?? this.retryMs));
        this.retryMs = Math.min(this.retryMaxMs, Math.max(this.retryMinMs, this.retryMs * 2 || this.retryMinMs));
        await this.sleep(waitMs, signal);
      }
    }
  }

  async #getUpdates(signal) {
    const url = new URL(`${this.apiBase}/bot${this.token}/getUpdates`);
    url.searchParams.set('timeout', String(this.pollTimeoutSeconds));
    url.searchParams.set('allowed_updates', JSON.stringify(['message', 'channel_post']));
    if (this.offset !== undefined) url.searchParams.set('offset', String(this.offset));
    const timeout = AbortSignal.timeout((this.pollTimeoutSeconds + 10) * 1000);
    const response = await this.fetchImpl(url, { signal: AbortSignal.any([signal, timeout]) });
    let body;
    try { body = await response.json(); }
    catch { throw Object.assign(new Error('Invalid Telegram response'), { code: 'INVALID_RESPONSE' }); }

    if (response.status === 409 || body?.error_code === 409) {
      throw Object.assign(new Error('Telegram polling conflict'), { telegramCode: 'poll_conflict' });
    }
    if (response.status === 401 || body?.error_code === 401) {
      throw Object.assign(new Error('Telegram authentication failed'), { telegramCode: 'unauthorized' });
    }
    if (response.status === 400 || body?.error_code === 400) {
      throw Object.assign(new Error('Telegram request rejected'), { telegramCode: 'invalid_request' });
    }
    if (!response.ok || body?.ok !== true || !Array.isArray(body.result)) {
      const error = Object.assign(new Error('Telegram request failed'), { code: `HTTP_${response.status}` });
      const retryAfter = Number(body?.parameters?.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterMs = Math.min(this.retryMaxMs, retryAfter * 1000);
      throw error;
    }
    return body.result;
  }

  #message(update) {
    const isChannelPost = Boolean(update.channel_post);
    const message = update.channel_post ?? update.message;
    if (!message || !message.chat || message.message_id === undefined) return null;
    const chatId = String(message.chat.id ?? '');
    if (!this.allowedChatIds.has(chatId)) return null;

    const senderId = message.from?.id === undefined ? null : String(message.from.id);
    if (this.allowedSenderIds.size && !isChannelPost && (!senderId || !this.allowedSenderIds.has(senderId))) return null;

    const text = typeof message.text === 'string' ? message.text
      : typeof message.caption === 'string' ? message.caption : '';
    if (!text.trim()) return null;
    return {
      updateId: update.update_id,
      chatId,
      messageId: String(message.message_id),
      senderId,
      kind: isChannelPost ? 'channel_post' : 'message',
      text,
    };
  }
}
