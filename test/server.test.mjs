import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { get as httpGet } from 'node:http';
import { Monitor } from '../src/monitor.mjs';
import { createApp } from '../server.mjs';

async function demoApp(t, options = {}) {
  const monitor = new Monitor({ demo: true });
  const app = createApp({ monitor, ...options });
  monitor.start();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    const closed = once(app.server, 'close');
    app.close();
    app.server.closeAllConnections();
    await closed;
  });
  return { ...app, base };
}

test('demo HTTP state is explicitly synthetic and serves health plus dashboard assets', async t => {
  const app = await demoApp(t);
  const stateResponse = await fetch(`${app.base}/api/state`);
  assert.equal(stateResponse.status, 200);
  assert.match(stateResponse.headers.get('content-type'), /application\/json/);
  assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
  const state = await stateResponse.json();
  assert.equal(state.mode, 'demo');
  assert.equal(state.crown.status, 'not_configured', 'the dashboard state keeps Crown collection separate from the Polymarket status');
  assert.ok(state.events.length > 0);
  assert.ok(Object.keys(state.books).length > 0);
  assert.ok(Object.values(state.books).every(book => book.source === 'demo'));
  const health = await (await fetch(`${app.base}/api/health`)).json();
  assert.equal(health.server, 'ok');
  assert.equal(health.mode, 'demo');
  assert.equal(health.events, state.events.length);
  for (const [path, mime] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/chinese.js', 'text/javascript'], ['/market-lines.js', 'text/javascript'], ['/price-history.js', 'text/javascript'], ['/hedge-calculator.js', 'text/javascript'], ['/hedge-panel.js', 'text/javascript'], ['/hedge.css', 'text/css'], ['/state-stream.js', 'text/javascript'], ['/crown-login.js', 'text/javascript'], ['/trading.js', 'text/javascript'], ['/trading.css', 'text/css'], ['/styles.css', 'text/css'], ['/logos/lal.svg', 'image/svg+xml']]) {
    const response = await fetch(`${app.base}${path}`);
    assert.equal(response.status, 200, `${path} should be available`);
    assert.ok(response.headers.get('content-type').startsWith(mime));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok((await response.text()).length > 20);
  }
  assert.equal((await fetch(`${app.base}/package.json`)).status, 404, 'source files must not be served');
  assert.equal((await fetch(`${app.base}/crown.js`)).status, 404, 'the removed comparison page script must not be served');
  const html = await (await fetch(app.base)).text();
  assert.doesNotMatch(html, /皇冠 · 跨平台盘口比较|8768\/me/);
  assert.match(html, /crown-login-dialog/);
  assert.equal((await fetch(`${app.base}/unknown`)).status, 404);
  assert.equal((await fetch(`${app.base}/logos/zzz.svg`)).status, 404);
  assert.equal((await fetch(`${app.base}/logos/NOTICE.md`)).status, 404);
  assert.equal((await fetch(`${app.base}/logos/%2e%2e/server.mjs`)).status, 404);
});

test('trading routes require strict local same-origin access and keep status outside market state', async t => {
  const actions = [];
  const state = {
    enabled: false,
    ready: true,
    settings: { stakeUsdc: 5, buySlippage: 0.02, takeProfitIncrement: 0.02 },
    credentials: { telegram: true, polymarket: true },
    receiver: { configured: true, running: true, lastPollAt: new Date().toISOString(), lastError: null, stopReason: null },
    records: [],
  };
  const trading = {
    async init() {},
    status: () => structuredClone(state),
    async configureSettings(value) { actions.push(['settings', value]); },
    async enable() { actions.push(['enable']); state.enabled = true; },
    async disable() { actions.push(['disable']); state.enabled = false; },
    async close() {},
  };
  const app = await demoApp(t, { trading });
  const statusResponse = await fetch(`${app.base}/api/trading/status`);
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await statusResponse.json()).credentials, { telegram: true, polymarket: true });

  const marketState = await (await fetch(`${app.base}/api/state`)).json();
  assert.equal(Object.hasOwn(marketState, 'trading'), false);
  assert.equal((await fetch(`${app.base}/api/trading/status`, { headers: { origin: 'https://untrusted.example' } })).status, 403);

  const post = (path, body, headers = {}) => fetch(`${app.base}${path}`, {
    method: 'POST',
    headers: { origin: app.base, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await post('/api/trading/settings', { stakeUsdc: 8, buySlippage: 0.02, takeProfitIncrement: 0.03 })).status, 200);
  assert.equal((await post('/api/trading/enable', {})).status, 200);
  assert.equal((await post('/api/trading/disable', {})).status, 200);
  assert.deepEqual(actions, [
    ['settings', { stakeUsdc: 8, buySlippage: 0.02, takeProfitIncrement: 0.03 }],
    ['enable'],
    ['disable'],
  ]);
  assert.equal((await post('/api/trading/enable', {}, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await fetch(`${app.base}/api/trading/enable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
});

test('price history validates filters and pagination and restricts reads to this local app', async t => {
  const calls = [];
  const priceHistory = {
    history: filters => { calls.push(filters); return { records: [], hasMore: false, nextBefore: null, recordingSince: null }; },
    close() {},
  };
  const app = await demoApp(t, { priceHistory });
  const query = new URLSearchParams({ eventId: 'game-1', marketId: 'line-95', type: 'spreads', source: 'crown', limit: '20', before: '123' });
  const response = await fetch(`${app.base}/api/price-history?${query}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, [{ eventId: 'game-1', marketId: 'line-95', type: 'spreads', source: 'crown', limit: 20, before: 123 }]);
  assert.deepEqual((await response.json()).records, []);
  for (const [key, value] of [['eventId', ''], ['marketId', ''], ['type', 'moneyline'], ['source', 'bad'], ['limit', ''], ['limit', '201'], ['limit', '1.5'], ['before', '0'], ['before', 'NaN']]) {
    const invalid = new URLSearchParams(query); invalid.set(key, value);
    assert.equal((await fetch(`${app.base}/api/price-history?${invalid}`)).status, 400, `${key}=${value}`);
  }
  assert.equal((await fetch(`${app.base}/api/price-history?${query}`, { headers: { origin: 'https://untrusted.example' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = httpGet(`${app.base}/api/price-history?${query}`, { headers: { host: 'untrusted.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal(calls.length, 1, 'rejected requests must not query history');
});

test('price history reports storage errors without exposing database details', async t => {
  const app = await demoApp(t, { priceHistory: { history() { throw new Error('private database path'); }, close() {} } });
  const response = await fetch(`${app.base}/api/price-history?eventId=game-1&marketId=market-1&type=totals`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: '暂时无法读取价格历史，请稍后重试。' });
});

test('SSE immediately sends an identifiable state snapshot and subsequent monitor updates', async t => {
  const app = await demoApp(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${app.base}/api/stream`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  async function nextState() {
    let buffer = '';
    while (!buffer.includes('\n\n')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      buffer += decoder.decode(value, { stream: true });
    }
    assert.match(buffer, /event: state\n/);
    const payload = buffer.split('\n').find(line => line.startsWith('data: ')).slice(6);
    return JSON.parse(payload);
  }
  const initial = await nextState();
  assert.equal(initial.mode, 'demo');
  assert.equal(initial.crown.status, 'not_configured');
  app.monitor.setSettings({ range: 'past' });
  const updated = await nextState();
  assert.equal(updated.range, 'past');
  await reader.cancel();
});

test('incremental SSE retains matching baselines across late connections, removed books and reconnects', { timeout: 10000 }, async t => {
  const app = await demoApp(t);
  app.monitor.stop();
  const openStream = async (query = '?delta=1') => {
    const abort = new AbortController();
    t.after(() => abort.abort());
    const response = await fetch(`${app.base}/api/stream${query}`, { signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
      close: () => reader.cancel(),
      async next() {
        while (true) {
          const end = buffer.indexOf('\n\n');
          if (end !== -1) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const event = block.match(/^event: (.+)/m)?.[1];
            if (event) return { event, data: JSON.parse(block.match(/^data: (.+)/m)[1]) };
          } else {
            const chunk = await reader.read();
            assert.equal(chunk.done, false, 'SSE connection should remain open');
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        }
      },
    };
  };
  const merge = (state, patch) => {
    const next = { ...state, ...patch.set, books: { ...state.books, ...patch.books } };
    for (const token of patch.removedBooks) delete next.books[token];
    return next;
  };
  const first = await openStream();
  const initial = await first.next();
  assert.equal(initial.event, 'state');
  let firstState = initial.data;
  const legacy = await openStream('');
  assert.equal((await legacy.next()).event, 'state');
  const state = app.monitor.snapshot();
  const [token, otherToken] = Object.keys(state.books);
  state.books[token].bids[0].price = 0.2222;
  state.books[token].verifiedAt = '2026-10-23T01:00:00.000Z';
  state.stream.lastMessageAt = '2026-10-23T01:00:00.000Z';
  app.monitor.emit('state', state);
  const changed = await first.next();
  assert.equal(changed.event, 'patch');
  assert.deepEqual(Object.keys(changed.data.books), [token]);
  assert.equal(changed.data.books[token].verifiedAt, state.books[token].verifiedAt);
  firstState = merge(firstState, changed.data);
  const legacyUpdate = await legacy.next();
  assert.equal(legacyUpdate.event, 'state');
  assert.deepEqual(firstState, legacyUpdate.data);

  // A second tab opens after an upstream mutation but before the next scheduled publish.
  state.books[otherToken].asks[0].price = 0.7777;
  const second = await openStream();
  const secondInitial = await second.next();
  assert.equal(secondInitial.event, 'state');
  firstState = merge(firstState, (await first.next()).data);
  assert.deepEqual(firstState, secondInitial.data);
  assert.deepEqual((await legacy.next()).data, secondInitial.data);

  delete state.books[token];
  state.range = 'past';
  app.crown.state.status = 'offline';
  app.crown.emit('state', app.crown.state);
  const removed = await first.next();
  assert.deepEqual(removed.data.removedBooks, [token]);
  assert.equal(removed.data.set.range, 'past');
  assert.equal(removed.data.set.crown.status, 'offline');
  firstState = merge(firstState, removed.data);
  const secondState = merge(secondInitial.data, (await second.next()).data);
  assert.deepEqual(firstState, secondState);
  assert.deepEqual((await legacy.next()).data, firstState);
  await first.close();
  const reconnected = await openStream();
  const baseline = await reconnected.next();
  assert.equal(baseline.event, 'state');
  assert.deepEqual(baseline.data, firstState);
  await Promise.all([second.close(), legacy.close(), reconnected.close()]);
});

test('settings accepts supported same-origin values and validates all input shapes', async t => {
  const app = await demoApp(t);
  const send = (body, headers = { 'content-type': 'application/json' }) => fetch(`${app.base}/api/settings`, { method: 'POST', headers, body });
  const accepted = await send(JSON.stringify({ range: 'both', timezone: 'America/New_York' }), { 'content-type': 'application/json', origin: app.base });
  assert.equal(accepted.status, 202);
  const state = await accepted.json();
  assert.equal(state.range, 'both');
  assert.equal(state.timezone, 'America/New_York');
  for (const body of [
    '{broken', 'null', '[]', '"past"',
    '{"range":"forever"}', '{"timezone":"Moon/Base"}', '{"unexpected":true}',
  ]) {
    assert.equal((await send(body)).status, 400, `${body} must be rejected`);
  }
  assert.equal((await send('{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(JSON.stringify({ range: 'past' }), { 'content-type': 'application/json', origin: 'https://untrusted.example' })).status, 403);
  assert.equal(app.monitor.snapshot().range, 'both', 'rejected writes do not change settings');
  assert.equal((await send(JSON.stringify({ range: 'x'.repeat(5000) }))).status, 413);
});

test('standalone Crown login routes are local-only and never link to HD', async t => {
  let calls = 0;
  let monitoringStarted = false;
  const service = {
    startMonitoring: () => { monitoringStarted = true; },
    status: async () => ({ stage: 'idle', message: '', browserOpen: false, canVerify: false, hasSession: false, lastSavedAt: null }),
    start: async () => { calls++; return { stage: 'waiting', message: '请在新窗口登录。', browserOpen: true, canVerify: false, hasSession: false, lastSavedAt: null }; },
    verifyAndSave: async () => ({ stage: 'saved', message: '会话已加密保存。', browserOpen: false, canVerify: true, hasSession: true, lastSavedAt: '2026-10-22T10:00:00.000Z' }),
    cancel: async () => ({ stage: 'idle', message: '', browserOpen: false, canVerify: false, hasSession: false, lastSavedAt: null }),
    clear: async () => ({ stage: 'idle', message: '', browserOpen: false, canVerify: false, hasSession: false, lastSavedAt: null }),
    close: async () => {},
  };
  const app = await demoApp(t, { crownLogin: service });
  assert.equal(monitoringStarted, true, 'the local heartbeat monitor starts with the HTTP server');

  const stateResponse = await fetch(`${app.base}/api/crown/login/status`, { headers: { origin: app.base } });
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), await service.status());
  const start = await fetch(`${app.base}/api/crown/login/start`, { method: 'POST', headers: { origin: app.base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).browserOpen, true);
  assert.equal(calls, 1);

  const denied = await fetch(`${app.base}/api/crown/login/start`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  const rebindingHost = new URL(app.base);
  const rebinding = await fetch(`${app.base}/api/crown/login/status`, { headers: { host: `attacker.example:${rebindingHost.port}`, origin: `http://attacker.example:${rebindingHost.port}` } });
  assert.equal(rebinding.status, 403, 'DNS-rebinding hostnames must not read local session status');
  const missingOrigin = await fetch(`${app.base}/api/crown/login/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(missingOrigin.status, 403, 'login writes require a same-origin browser request');
  assert.equal(calls, 1, 'rejected origins must not launch a browser');
});

test('verified login saves immediately wake the collector, without exposing login data', async t => {
  const service = Object.assign(new EventEmitter(), { startMonitoring() {}, close: async () => {} });
  const app = await demoApp(t, { crownLogin: service });
  let refreshes = 0;
  app.crown.refreshAfterLogin = () => { refreshes++; };
  service.emit('sessionSaved', { verifiedAt: '2026-10-23T06:00:00.000Z' });
  assert.equal(refreshes, 1);
});
