import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import https from 'node:https';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ENDPOINT } from './config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../.local/crown');
const TARGET = new URL(ENDPOINT);
const ORIGIN = TARGET.origin;
const COOKIE_PATH = TARGET.pathname;
const MAX_XML_BYTES = 1024 * 1024;
const MAGIC = Buffer.from('PNC1');
const KEYCHAIN_SERVICE = 'pol-nba-crown-session';
const SESSION_REJECTION_MESSAGES = new Set(['expired', 'session expired', 'session_expired', 'session_rejected', 'invalid session', 'invalid_session']);
const NETWORK_ERROR_CODES = new Set(['ABORT_ERR', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function safeNetworkErrorCode(error) {
  for (const code of [error?.code, error?.cause?.code]) {
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return code;
  }
  return 'OTHER';
}

export class CrownLoginError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'CrownLoginError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validProtocolValue(value, pattern, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && pattern.test(value);
}

export function captureMemberProtocol(requestUrl, method, postData) {
  let url;
  try { url = new URL(requestUrl); } catch { return null; }
  if (method !== 'POST' || url.origin !== ORIGIN || url.pathname !== COOKIE_PATH || typeof postData !== 'string') return null;

  let fields;
  try { fields = new URLSearchParams(postData); } catch { return null; }
  if (fields.get('p') !== 'mem_online') return null;
  const oneValue = values => {
    const unique = [...new Set(values.filter(value => typeof value === 'string' && value !== ''))];
    return unique.length === 1 ? unique[0] : null;
  };
  const uid = oneValue([...fields.getAll('uid'), ...fields.getAll('UID')]);
  const ver = oneValue([...fields.getAll('ver'), ...url.searchParams.getAll('ver')]);
  const langx = oneValue([...fields.getAll('langx'), ...url.searchParams.getAll('langx')]);
  if (!validProtocolValue(uid, /^[^\r\n\x00]+$/, 2048)
      || !validProtocolValue(ver, /^[A-Za-z0-9._-]+$/, 96)
      || !validProtocolValue(langx, /^[A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/, 16)) return null;
  return { memberOrigin: url.origin, uid, ver, langx };
}

function cookieDomainMatches(domainValue, hostname) {
  const domain = String(domainValue ?? '').toLowerCase();
  const host = hostname.toLowerCase();
  const normalized = domain.startsWith('.') ? domain.slice(1) : domain;
  return host === normalized || host.endsWith(`.${normalized}`);
}

function cookiePathMatches(requestPath, cookiePath) {
  const path = typeof cookiePath === 'string' && cookiePath.startsWith('/') ? cookiePath : '/';
  return requestPath === path || (requestPath.startsWith(path) && (path.endsWith('/') || requestPath[path.length] === '/'));
}

export function sessionCookieHeader(storageState, origin = ORIGIN, now = Date.now()) {
  const host = new URL(origin).hostname;
  const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];
  return cookies.filter(cookie => {
    if (!cookie || typeof cookie.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)) return false;
    if (typeof cookie.value !== 'string' || /[\r\n;]/.test(cookie.value)) return false;
    if (!cookieDomainMatches(cookie.domain, host) || !cookiePathMatches(COOKIE_PATH, cookie.path)) return false;
    return !(typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires * 1000 <= now);
  }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function filterStorageState(state, origin = ORIGIN) {
  const host = new URL(origin).hostname;
  const cookies = Array.isArray(state?.cookies) ? state.cookies.filter(cookie => {
    if (!cookieDomainMatches(cookie?.domain, host) || !cookiePathMatches(COOKIE_PATH, cookie.path)) return false;
    if (typeof cookie.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)) return false;
    return typeof cookie.value === 'string' && cookie.value.length <= 8192 && !/[\r\n;]/.test(cookie.value);
  }) : [];
  const origins = Array.isArray(state?.origins) ? state.origins.filter(item => item?.origin === origin).map(item => ({
    origin,
    localStorage: Array.isArray(item.localStorage) ? item.localStorage.filter(entry =>
      typeof entry?.name === 'string' && entry.name.length <= 512 && typeof entry.value === 'string' && entry.value.length <= 8192,
    ).slice(0, 100) : [],
  })) : [];
  return { cookies, origins };
}

function safeSession(session) {
  if (!session || session.member_origin !== ORIGIN || session.member_protocol?.origin !== ORIGIN
      || !validProtocolValue(session.uid, /^[^\r\n\x00]+$/, 2048)
      || !validProtocolValue(session.member_protocol?.ver, /^[A-Za-z0-9._-]+$/, 96)
      || !validProtocolValue(session.member_protocol?.langx, /^[A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/, 16)
      || !session.storage_state || !Array.isArray(session.storage_state.cookies)) {
    throw new CrownLoginError('SESSION_INVALID', '会话信息不完整，请重新登录并验证。');
  }
  return session;
}

async function readLimited(response, maxBytes = MAX_XML_BYTES) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new CrownLoginError('VERIFY_RESPONSE_INVALID', '皇冠在线验证返回内容过大。', 502);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function requestCrown(url, options) {
  const target = new URL(url);
  if (target.origin !== ORIGIN || target.pathname !== COOKIE_PATH) throw new CrownLoginError('VERIFY_HTTP', '皇冠在线验证请求目标无效。', 502);
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
    }, response => resolve({ status: response.statusCode, url: target.toString(), body: response }));
    request.on('error', reject);
    request.end(options.body);
  });
}

export async function verifyCrownSession(sessionInput, fetcher = requestCrown) {
  const session = safeSession(sessionInput);
  const cookie = sessionCookieHeader(session.storage_state, session.member_origin);
  const fields = new URLSearchParams({
    p: 'mem_online',
    uid: session.uid,
    ver: session.member_protocol.ver,
    langx: session.member_protocol.langx,
  });
  let response;
  try {
    response = await fetcher(`${ORIGIN}/transform.php?ver=${encodeURIComponent(session.member_protocol.ver)}`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'text/xml,application/xml',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
        'User-Agent': 'Mozilla/5.0',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: fields.toString(),
    });
  } catch (cause) {
    const error = new CrownLoginError('VERIFY_NETWORK', '皇冠在线验证连接失败，请检查网络后重试。', 502);
    error.networkErrorCode = safeNetworkErrorCode(cause);
    throw error;
  }
  if (response.status === 401 || response.status === 440) throw new CrownLoginError('SESSION_REJECTED', '皇冠拒绝了当前会话，请重新登录。', 401);
  if (response.status !== 200 || new URL(response.url || `${ORIGIN}/`).origin !== ORIGIN) {
    throw new CrownLoginError('VERIFY_HTTP', '皇冠在线验证没有成功，请重新登录后再试。', 502);
  }
  const bytes = await readLimited(response);
  const xml = bytes.toString('utf8');
  if (bytes.length === 0 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new CrownLoginError('VERIFY_RESPONSE_INVALID', '皇冠在线验证返回格式无法确认。', 502);
  }
  let parsed;
  try { parsed = new XMLParser({ ignoreAttributes: true, processEntities: false, parseTagValue: false, trimValues: true }).parse(xml); }
  catch { throw new CrownLoginError('VERIFY_RESPONSE_INVALID', '皇冠在线验证返回格式无法确认。', 502); }
  const record = parsed?.serverresponse;
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.msg !== 'string') {
    throw new CrownLoginError('VERIFY_RESPONSE_INVALID', '皇冠在线验证返回格式无法确认。', 502);
  }
  const message = record.msg.trim().toLowerCase();
  if (SESSION_REJECTION_MESSAGES.has(message)) throw new CrownLoginError('SESSION_REJECTED', '皇冠拒绝了当前会话，请重新登录。', 401);
  if (message !== ''
      || typeof record.systemtime !== 'string'
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(record.systemtime)
      || typeof record.systimestamp !== 'string'
      || !/^\d{9,12}$/.test(record.systimestamp)
      || !Number.isFinite(Date.parse(`${record.systemtime.replace(' ', 'T')}Z`))) {
    throw new CrownLoginError('VERIFY_RESPONSE_INVALID', '皇冠在线验证返回格式无法确认。', 502);
  }
  return { verifiedAt: new Date().toISOString() };
}

export class CrownSessionStore {
  constructor({ directory = ROOT, keyProvider } = {}) {
    this.directory = resolve(directory);
    this.sessionPath = join(this.directory, 'session.bin');
    this.keyProvider = keyProvider;
  }

  async #key(create) {
    if (this.keyProvider) return this.keyProvider(create);
    if (process.platform === 'darwin') {
      let keytar;
      try {
        const module = await import('keytar');
        keytar = module.default ?? module;
      } catch {
        throw new CrownLoginError('KEYCHAIN_UNAVAILABLE', '无法访问 macOS 钥匙串，请检查本机依赖。', 500);
      }
      const account = this.directory;
      let value = await keytar.getPassword(KEYCHAIN_SERVICE, account);
      if (!value && create) {
        value = randomBytes(32).toString('base64');
        await keytar.setPassword(KEYCHAIN_SERVICE, account, value);
      }
      return value ? Buffer.from(value, 'base64') : null;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const keyPath = join(this.directory, 'session.key');
    try {
      const info = await stat(keyPath);
      if ((info.mode & 0o077) !== 0) throw new CrownLoginError('KEY_PERMISSIONS', '本机会话密钥权限过宽，已停止读取。', 500);
      const key = await readFile(keyPath);
      if (key.length !== 32) throw new CrownLoginError('KEY_INVALID', '本机会话密钥无效，请检查本机数据目录。', 500);
      return key;
    } catch (error) {
      if (error instanceof CrownLoginError || error.code !== 'ENOENT') throw error;
    }
    if (!create) return null;
    const key = randomBytes(32);
    const handle = await open(keyPath, 'wx', 0o600).catch(error => error.code === 'EEXIST' ? null : Promise.reject(error));
    if (!handle) return this.#key(false);
    try { await handle.writeFile(key); } finally { await handle.close(); }
    return key;
  }

  async status() {
    try {
      const info = await stat(this.sessionPath);
      return { hasSession: info.isFile(), lastSavedAt: info.mtime.toISOString() };
    } catch { return { hasSession: false, lastSavedAt: null }; }
  }

  async load() {
    let bytes;
    try { bytes = await readFile(this.sessionPath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new CrownLoginError('SESSION_READ', '无法读取本机会话，请重新登录。', 500); }
    const key = await this.#key(false);
    if (!key || key.length !== 32 || bytes.length < MAGIC.length + 12 + 16 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new CrownLoginError('SESSION_DECRYPT', '本机会话无法解密，请重新登录。', 500);
    }
    try {
      const iv = bytes.subarray(MAGIC.length, MAGIC.length + 12);
      const tag = bytes.subarray(MAGIC.length + 12, MAGIC.length + 28);
      const content = bytes.subarray(MAGIC.length + 28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8');
      return safeSession(JSON.parse(plain));
    } catch (error) {
      if (error instanceof CrownLoginError) throw error;
      throw new CrownLoginError('SESSION_DECRYPT', '本机会话无法解密，请重新登录。', 500);
    }
  }

  async save(sessionInput) {
    const session = safeSession(sessionInput);
    const key = await this.#key(true);
    if (!key || key.length !== 32) throw new CrownLoginError('KEY_INVALID', '无法创建本机加密密钥。', 500);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plain = Buffer.from(JSON.stringify(session));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const bytes = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.sessionPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, this.sessionPath);
    } catch {
      await rm(temporaryPath, { force: true });
      throw new CrownLoginError('SESSION_WRITE', '无法安全保存皇冠会话，请检查本地磁盘权限。', 500);
    }
  }

  async clear() {
    await rm(this.sessionPath, { force: true });
  }
}

function executablePath() {
  const candidates = [
    process.env.CROWN_BROWSER_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

async function defaultBrowserLauncher() {
  const binary = executablePath();
  if (!binary) throw new CrownLoginError('BROWSER_MISSING', '找不到 Chrome；请安装 Chrome 或设置 CROWN_BROWSER_PATH。', 503);
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    executablePath: binary,
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check'],
    timeout: 30000,
  });
}

export class CrownLoginService {
  constructor({ store = new CrownSessionStore(), browserLauncher = defaultBrowserLauncher, fetcher = requestCrown, heartbeatIntervalMs = 60000 } = {}) {
    this.store = store;
    this.browserLauncher = browserLauncher;
    this.fetcher = fetcher;
    this.heartbeatIntervalMs = Math.max(10000, Number(heartbeatIntervalMs) || 60000);
    this.browser = null;
    this.context = null;
    this.page = null;
    this.candidate = null;
    this.stage = 'idle';
    this.message = '';
    this.closing = false;
    this.sessionHealth = 'unknown';
    this.lastCheckedAt = null;
    this.networkErrorCode = null;
    this.automaticRecoveryAttempted = false;
    this.monitoring = false;
    this.heartbeatTimer = null;
    this.heartbeatPending = null;
    this.startPending = null;
  }

  async status() {
    const saved = await this.store.status();
    const browserOpen = Boolean(this.browser?.isConnected?.() && this.context);
    return {
      stage: this.stage,
      message: this.message,
      browserOpen,
      canVerify: Boolean(browserOpen && this.candidate) || (!browserOpen && saved.hasSession),
      hasSession: saved.hasSession,
      lastSavedAt: saved.lastSavedAt,
      sessionHealth: this.sessionHealth,
      lastCheckedAt: this.lastCheckedAt,
      networkErrorCode: this.networkErrorCode,
      automaticRecovery: this.stage === 'recovering' || (browserOpen && this.automaticRecoveryAttempted),
    };
  }

  startMonitoring() {
    if (this.monitoring) return;
    this.monitoring = true;
    void this.#runHeartbeat();
  }

  async #runHeartbeat() {
    if (!this.monitoring) return;
    try { await this.checkSavedSession(); } catch { /* Status carries a sanitized failure. */ }
    if (!this.monitoring) return;
    this.heartbeatTimer = setTimeout(() => void this.#runHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  async checkSavedSession() {
    if (this.heartbeatPending) return this.heartbeatPending;
    if ((this.browser?.isConnected?.() && this.context) || ['opening', 'verifying'].includes(this.stage)) return this.status();
    this.heartbeatPending = (async () => {
      let session;
      try { session = await this.store.load(); }
      catch {
        this.sessionHealth = 'unavailable';
        this.lastCheckedAt = new Date().toISOString();
        this.stage = 'unavailable';
        this.message = '无法读取本机会话，尚未发起在线检查。';
        return this.status();
      }
      if (!session) {
        this.sessionHealth = 'unknown';
        return this.status();
      }
      try {
        const verified = await verifyCrownSession(session, this.fetcher);
        this.sessionHealth = 'valid';
        this.networkErrorCode = null;
        this.lastCheckedAt = verified.verifiedAt;
        this.automaticRecoveryAttempted = false;
        if (['idle', 'expired', 'unavailable', 'error'].includes(this.stage)) {
          this.stage = 'saved';
          this.message = '皇冠在线校验通过，本机会话有效。';
        }
      } catch (error) {
        this.lastCheckedAt = new Date().toISOString();
        if (error?.code === 'SESSION_REJECTED') {
          this.sessionHealth = 'expired';
          this.networkErrorCode = null;
          this.stage = 'expired';
          this.message = '皇冠已确认本机会话失效，正在打开登录恢复窗口。';
          await this.#beginAutomaticRecovery();
        } else {
          this.sessionHealth = 'unavailable';
          this.networkErrorCode = error?.networkErrorCode ?? null;
          this.stage = 'unavailable';
          this.message = '皇冠在线检查暂时失败；已保留会话，网络恢复后会重试。';
        }
      }
      return this.status();
    })().finally(() => { this.heartbeatPending = null; });
    return this.heartbeatPending;
  }

  async #beginAutomaticRecovery() {
    if (this.automaticRecoveryAttempted) return;
    this.automaticRecoveryAttempted = true;
    try { await this.start({ autoRecovery: true }); }
    catch {
      this.sessionHealth = 'expired';
      this.stage = 'expired';
      this.message = '皇冠会话已失效，但登录窗口无法自动打开。请点击“打开皇冠登录窗口”重新登录。';
    }
  }

  #trackPage(page) {
    page.on('request', request => {
      const candidate = captureMemberProtocol(request.url(), request.method(), request.postData());
      if (candidate) {
        this.candidate = candidate;
        this.stage = 'ready';
        this.message = this.automaticRecoveryAttempted
          ? '恢复窗口已捕获会员校验请求。请在皇冠页面完成登录后验证并保存。'
          : '已捕获皇冠会员在线校验请求，可以验证并保存。';
      }
    });
    page.on('close', () => {
      if (this.page === page) this.page = null;
      if (!this.closing && !this.page) {
        this.stage = this.candidate ? 'ready' : 'window_closed';
        this.message = this.candidate ? '登录窗口已关闭，可以验证并保存。' : '登录窗口已关闭，尚未捕获在线校验请求。';
      }
    });
    this.page = page;
  }

  async start({ autoRecovery = false } = {}) {
    if (autoRecovery) this.automaticRecoveryAttempted = true;
    if (this.startPending) {
      await this.startPending;
      if (autoRecovery && this.browser?.isConnected?.() && this.context) {
        this.stage = 'recovering';
        this.message = '恢复登录窗口已打开。请在皇冠页面完成登录，再回来验证并保存会话。';
      }
      return this.status();
    }
    const pending = this.#openLoginWindow({ autoRecovery });
    this.startPending = pending;
    try { return await pending; }
    finally { if (this.startPending === pending) this.startPending = null; }
  }

  async #openLoginWindow({ autoRecovery = false } = {}) {
    if (this.sessionHealth === 'expired') autoRecovery = true;
    if (this.browser?.isConnected?.() && this.context) {
      await this.page?.bringToFront().catch(() => {});
      return this.status();
    }
    if (autoRecovery) this.automaticRecoveryAttempted = true;
    this.stage = 'opening';
    this.message = autoRecovery ? '正在打开皇冠登录恢复窗口。' : '正在打开独立皇冠登录窗口。';
    try {
      const saved = await this.store.load();
      if (saved && !autoRecovery) this.candidate = {
        memberOrigin: saved.member_origin,
        uid: saved.uid,
        ver: saved.member_protocol.ver,
        langx: saved.member_protocol.langx,
      };
      else this.candidate = null;
      this.browser = await this.browserLauncher();
      this.browser.on('disconnected', () => {
        if (!this.closing) {
          this.context = null;
          this.page = null;
          this.stage = this.candidate ? 'ready' : 'window_closed';
        }
      });
      this.context = await this.browser.newContext({ ...(saved?.storage_state ? { storageState: saved.storage_state } : {}), acceptDownloads: false });
      this.context.on('page', page => this.#trackPage(page));
      const page = await this.context.newPage();
      if (this.page !== page) this.#trackPage(page);
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      this.stage = autoRecovery ? 'recovering' : this.candidate ? 'ready' : 'waiting';
      this.message = autoRecovery
        ? '恢复登录窗口已打开。请在皇冠页面完成登录，再回来验证并保存会话。'
        : this.candidate ? '已载入本机会话，请验证当前登录状态。' : '请在新开的 Chrome 窗口中登录皇冠。';
      return this.status();
    } catch (error) {
      await this.#closeBrowser();
      this.stage = 'error';
      this.message = error instanceof CrownLoginError ? error.message : '皇冠登录窗口无法打开，请检查 Chrome 和网络。';
      throw error instanceof CrownLoginError ? error : new CrownLoginError('BROWSER_START', this.message, 503);
    }
  }

  async verifyAndSave() {
    if (!this.context || !this.browser?.isConnected?.()) return this.verifySaved();
    if (!this.candidate) {
      this.stage = 'error';
      this.message = '请先在登录窗口完成登录，并等待皇冠会员页面发起在线校验。';
      throw new CrownLoginError('MEMBER_CHECK_NOT_SEEN', this.message, 409);
    }
    const targetPage = this.context.pages().some(page => {
      try { return new URL(page.url()).origin === this.candidate.memberOrigin; } catch { return false; }
    });
    if (!targetPage) throw new CrownLoginError('MEMBER_PAGE_NOT_OPEN', '请保持皇冠会员页面打开后再验证。', 409);
    this.stage = 'verifying';
    this.message = '正在向皇冠发送只读在线验证。';
    try {
      const browserState = await this.context.storageState();
      const session = safeSession({
        member_origin: this.candidate.memberOrigin,
        member_protocol: { origin: this.candidate.memberOrigin, ver: this.candidate.ver, langx: this.candidate.langx },
        member_ui_verified: false,
        uid: this.candidate.uid,
        storage_state: filterStorageState(browserState, this.candidate.memberOrigin),
        saved_at: null,
      });
      const verified = await verifyCrownSession(session, this.fetcher);
      session.member_ui_verified = true;
      session.verified_at = verified.verifiedAt;
      await this.store.save(session);
      this.sessionHealth = 'valid';
      this.networkErrorCode = null;
      this.lastCheckedAt = verified.verifiedAt;
      this.automaticRecoveryAttempted = false;
      this.stage = 'saved';
      this.message = '皇冠在线验证通过，会话已加密保存在本机。';
      await this.#closeBrowser();
      return this.status();
    } catch (error) {
      this.sessionHealth = error?.code === 'SESSION_REJECTED' ? 'expired' : ['VERIFY_NETWORK', 'VERIFY_HTTP'].includes(error?.code) ? 'unavailable' : 'unknown';
      this.networkErrorCode = error?.networkErrorCode ?? null;
      this.lastCheckedAt = new Date().toISOString();
      this.stage = this.automaticRecoveryAttempted && this.browser?.isConnected?.() ? 'recovering' : error?.code === 'SESSION_REJECTED' ? 'expired' : 'error';
      this.message = this.stage === 'recovering'
        ? error?.code === 'SESSION_REJECTED'
          ? '皇冠尚未确认登录。请在恢复窗口完成登录，再点击验证并保存会话。'
          : '皇冠在线检查暂时失败；已保留会话，网络恢复后可以重试。'
        : error instanceof CrownLoginError ? error.message : '会话验证或保存失败，请检查本机钥匙串和网络。';
      throw error instanceof CrownLoginError ? error : new CrownLoginError('SESSION_SAVE', this.message, 500);
    }
  }

  async verifySaved() {
    const session = await this.store.load();
    if (!session) throw new CrownLoginError('SESSION_MISSING', '本机没有已保存的皇冠会话。', 409);
    this.stage = 'verifying';
    this.message = '正在检查已保存的皇冠会话。';
    try {
      const verified = await verifyCrownSession(session, this.fetcher);
      session.member_ui_verified = true;
      session.verified_at = verified.verifiedAt;
      await this.store.save(session);
      this.sessionHealth = 'valid';
      this.networkErrorCode = null;
      this.lastCheckedAt = verified.verifiedAt;
      this.automaticRecoveryAttempted = false;
      this.stage = 'saved';
      this.message = '皇冠在线验证通过，会话已加密保存在本机。';
      return this.status();
    } catch (error) {
      this.sessionHealth = error?.code === 'SESSION_REJECTED' ? 'expired' : ['VERIFY_NETWORK', 'VERIFY_HTTP'].includes(error?.code) ? 'unavailable' : 'unknown';
      this.networkErrorCode = error?.networkErrorCode ?? null;
      this.lastCheckedAt = new Date().toISOString();
      if (error?.code === 'SESSION_REJECTED') {
        this.stage = 'expired';
        this.message = '皇冠确认本机会话失效。';
        await this.#beginAutomaticRecovery();
        return this.status();
      }
      this.stage = 'error';
      this.message = error instanceof CrownLoginError ? error.message : '会话验证或保存失败，请检查本机钥匙串和网络。';
      throw error instanceof CrownLoginError ? error : new CrownLoginError('SESSION_SAVE', this.message, 500);
    }
  }

  async cancel() {
    await this.#closeBrowser();
    this.candidate = null;
    this.stage = 'idle';
    this.message = '登录窗口已关闭。';
    return this.status();
  }

  async clear() {
    await this.#closeBrowser();
    this.candidate = null;
    await this.store.clear();
    this.sessionHealth = 'unknown';
    this.lastCheckedAt = null;
    this.automaticRecoveryAttempted = false;
    this.stage = 'idle';
    this.message = '已删除本机保存的皇冠会话。';
    return this.status();
  }

  async #closeBrowser() {
    this.closing = true;
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    try { await browser?.close(); } catch { /* Browser may already have been closed. */ }
    this.closing = false;
  }

  async close() {
    this.monitoring = false;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.heartbeatPending) await this.heartbeatPending.catch(() => {});
    await this.#closeBrowser();
  }
}
