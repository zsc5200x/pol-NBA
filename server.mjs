import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { Monitor } from './src/monitor.mjs';
import { PriceHistory } from './src/price-history.mjs';
import { CrownMonitor } from './src/crown/monitor.mjs';
import { CrownLoginError, CrownLoginService } from './src/crown/login.mjs';
import { StateStream } from './src/state-stream.mjs';
import { TradingExecutor } from './src/trading/executor.mjs';
import { TradingStateStore } from './src/trading/store.mjs';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const DEFAULT_CROWN_CONFIG = resolve('.local/crown/live-config.json');
const FILES = new Map([['/', 'index.html'], ['/app.js', 'app.js'], ['/chinese.js', 'chinese.js'], ['/market-lines.js', 'market-lines.js'], ['/price-history.js', 'price-history.js'], ['/crown-login.js', 'crown-login.js'], ['/trading.js', 'trading.js'], ['/styles.css', 'styles.css'], ['/trading.css', 'trading.css']]);
for (const filename of ['hedge-calculator.js', 'hedge-panel.js', 'hedge.css', 'state-stream.js']) FILES.set(`/${filename}`, filename);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalSameOriginRead(request) {
  if (!isLoopback(request.socket.remoteAddress)) return false;
  const host = request.headers.host ?? '';
  let parsedHost;
  try { parsedHost = new URL(`http://${host}`); } catch { return false; }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedHost.hostname)) return false;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return !['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']);
}

function isLocalSameOriginWrite(request) {
  if (!isLocalSameOriginRead(request)) return false;
  return request.headers.origin === `http://${request.headers.host}`;
}

async function readEmptyJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new CrownLoginError('JSON_REQUIRED', '请求格式无效。', 415);
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new CrownLoginError('BODY_TOO_LARGE', '请求内容过大。', 413);
  }
  let value;
  try { value = JSON.parse(body || '{}'); } catch { throw new CrownLoginError('JSON_INVALID', '请求格式无效。', 400); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length) throw new CrownLoginError('JSON_INVALID', '请求格式无效。', 400);
  return value;
}

function crownConfigPath(monitor) {
  if (monitor.demo) return null;
  if (process.env.CROWN_CONFIG_PATH) return process.env.CROWN_CONFIG_PATH;
  return existsSync(DEFAULT_CROWN_CONFIG) ? DEFAULT_CROWN_CONFIG : null;
}

async function readTradingJson(request, allowedKeys) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('请求格式无效。'), { statusCode: 415 });
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw Object.assign(new Error('请求内容过大。'), { statusCode: 413 });
  }
  let value;
  try { value = JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('请求格式无效。'), { statusCode: 400 }); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw Object.assign(new Error('交易配置无效。'), { statusCode: 400 });
  }
  return value;
}

export function createApp({ monitor = new Monitor(), crown = new CrownMonitor({ configPath: crownConfigPath(monitor) }), crownLogin = new CrownLoginService(), priceHistory = new PriceHistory({ monitor, crown, filename: monitor.demo ? ':memory:' : process.env.PRICE_HISTORY_DB_PATH ?? resolve('.local/price-history.sqlite') }), trading = new TradingExecutor({ monitor, store: new TradingStateStore(), env: process.env }) } = {}) {
  const stream = new StateStream();
  const tradingReady = Promise.resolve().then(() => trading.init?.());
  void tradingReady.catch(() => {});
  const snapshot = () => {
    const marketState = monitor.snapshot();
    return { ...marketState, crown: crown.snapshot(marketState) };
  };
  const broadcast = () => { if (stream.clients.size) stream.publish(snapshot()); };
  monitor.on('state', broadcast);
  crown.on?.('state', broadcast);
  const onSessionSaved = () => { void crown.refreshAfterLogin?.(); };
  crownLogin.on?.('sessionSaved', onSessionSaved);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const json = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(payload)); };
    if (request.method === 'GET' && url.pathname === '/api/trading/status') {
      if (!isLocalSameOriginRead(request)) { json(403, { error: '自动交易仅允许本机同源访问' }); return; }
      try { await tradingReady; json(200, trading.status()); }
      catch { json(503, { error: '无法读取自动交易状态。' }); }
      return;
    }
    const tradingActions = new Map([
      ['/api/trading/settings', { keys: ['stakeUsdc', 'buySlippage', 'takeProfitIncrement'], run: value => trading.configureSettings(value), success: 200 }],
      ['/api/trading/enable', { keys: [], run: () => trading.enable(), success: 200 }],
      ['/api/trading/disable', { keys: [], run: () => trading.disable(), success: 200 }],
    ]);
    const tradingAction = tradingActions.get(url.pathname);
    if (request.method === 'POST' && tradingAction) {
      if (!isLocalSameOriginWrite(request)) { json(403, { error: '自动交易操作仅允许本机同源访问' }); return; }
      try {
        await tradingReady;
        const body = await readTradingJson(request, tradingAction.keys);
        await tradingAction.run(body);
        json(tradingAction.success, trading.status());
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 400;
        const message = typeof error?.publicMessage === 'string' ? error.publicMessage : error?.statusCode ? error.message : '自动交易操作未完成。';
        json(statusCode, { error: message });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/crown/login/status') {
      if (!isLocalSameOriginRead(request)) { json(403, { error: '皇冠登录仅允许本机同源访问' }); return; }
      try { json(200, await crownLogin.status()); }
      catch { json(500, { error: '无法读取本机皇冠登录状态。' }); }
      return;
    }
    const loginActions = new Map([
      ['/api/crown/login/start', () => crownLogin.start()],
      ['/api/crown/login/verify', () => crownLogin.verifyAndSave()],
      ['/api/crown/login/cancel', () => crownLogin.cancel()],
      ['/api/crown/login/clear', () => crownLogin.clear()],
    ]);
    if (request.method === 'POST' && loginActions.has(url.pathname)) {
      if (!isLocalSameOriginWrite(request)) { json(403, { error: '皇冠登录操作仅允许本机同源访问' }); return; }
      try {
        await readEmptyJson(request);
        json(200, await loginActions.get(url.pathname)());
      } catch (error) {
        const statusCode = error instanceof CrownLoginError ? error.statusCode : 500;
        const message = error instanceof CrownLoginError ? error.message : '皇冠登录操作未完成。';
        json(statusCode, { error: message });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/crown/captures') { json(200, await crown.captures()); return; }
    if (request.method === 'GET' && url.pathname === '/api/crown') {
      const type = url.searchParams.get('type'); const source = url.searchParams.get('source');
      if ((type && !['moneyline','spreads','totals'].includes(type)) || (source && !['today','early'].includes(source))) { json(400, { error: '筛选条件无效' }); return; }
      json(200, crown.snapshot(monitor.snapshot(), { type, source, matchId: url.searchParams.get('matchId') })); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/crown/history') {
      const id = url.searchParams.get('matchId');
      if (!id || id.length > 100) { json(400, { error: '需要比赛标识' }); return; }
      json(200, { matchId: id, history: crown.store.history(id) }); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/price-history') {
      if (!isLocalSameOriginRead(request)) { json(403, { error: '价格历史仅允许本机同源访问' }); return; }
      const eventId = url.searchParams.get('eventId');
      const marketId = url.searchParams.get('marketId');
      const type = url.searchParams.get('type');
      const source = url.searchParams.get('source');
      const limitText = url.searchParams.get('limit');
      const beforeText = url.searchParams.get('before');
      const limit = limitText === null ? 50 : Number(limitText);
      const before = beforeText === null ? undefined : Number(beforeText);
      if (!eventId || eventId.length > 150 || !marketId || marketId.length > 150 || !['spreads', 'totals'].includes(type)
        || (source !== null && !['pol', 'crown'].includes(source))
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
        || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) {
        json(400, { error: '请选择让分或大小分盘口，历史查询参数无效。' }); return;
      }
      try { json(200, priceHistory.history({ eventId, marketId, type, source: source ?? undefined, limit, before })); }
      catch { json(503, { error: '暂时无法读取价格历史，请稍后重试。' }); }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/state') { json(200, snapshot()); return; }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      const state = monitor.snapshot();
      json(200, { server: 'ok', mode: state.mode, upstream: state.status, events: state.events.length, books: Object.keys(state.books).length, crown: crown.state.status });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      stream.add(response, snapshot(), { delta: url.searchParams.get('delta') === '1' });
      request.on('close', () => stream.remove(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/settings') {
      // Settings only affect the local monitor. Reject cross-origin browser writes.
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) { json(403, { error: 'Origin not allowed' }); return; }
      if (!request.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'Expected application/json' }); return; }
      let body = '';
      try {
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 4096) { json(413, { error: 'Request too large' }); return; }
        }
        const settings = JSON.parse(body);
        if (!settings || Array.isArray(settings) || typeof settings !== 'object' || Object.keys(settings).some(k => !['range', 'timezone'].includes(k))) throw new Error('Invalid settings');
        monitor.setSettings(settings);
        json(202, monitor.snapshot());
      } catch (error) { json(400, { error: error.message }); }
      return;
    }
    if (request.method === 'GET' && (FILES.has(url.pathname) || /^\/logos\/[a-z]{3}\.svg$/.test(url.pathname))) {
      const filename = FILES.get(url.pathname) ?? url.pathname.slice(1);
      try {
        const data = await readFile(resolve(PUBLIC, filename));
        response.writeHead(200, { 'Content-Type': MIME[extname(filename)], 'Cache-Control': 'no-cache' });
        response.end(data);
      } catch { json(404, { error: 'File not found' }); }
      return;
    }
    json(404, { error: 'Not found' });
  });
  const heartbeat = setInterval(() => stream.heartbeat(), 15000);
  heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); monitor.off('state', broadcast); crown.off?.('state', broadcast); crownLogin.off?.('sessionSaved', onSessionSaved); priceHistory.close(); });
  server.on('listening', () => { crown.start(); void crownLogin.startMonitoring?.(); void tradingReady.then(() => trading.startReceiver?.()).catch(() => {}); });
  return {
    server, monitor, crown, crownLogin, priceHistory, trading,
    close: async () => {
      monitor.stop();
      stream.close();
      await Promise.all([trading.close?.(), crown.stop(), crownLogin.close()]);
      if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const app = createApp({ monitor: new Monitor({ demo: process.argv.includes('--demo') }) });
  app.server.listen(port, host, () => {
    console.log(`NBA monitor listening on ${host}:${port} (${app.monitor.demo ? 'DEMO — synthetic data' : 'LIVE — read-only public market data'})`);
    app.monitor.start();
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close());
  app.server.on('error', error => { console.error(error.message); app.monitor.stop(); process.exitCode = 1; });
}
