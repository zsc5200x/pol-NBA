import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Monitor } from '../src/monitor.mjs';
import { createApp } from '../server.mjs';

async function demoApp(t) {
  const monitor = new Monitor({ demo: true });
  const app = createApp({ monitor });
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
  assert.ok(state.events.length > 0);
  assert.ok(Object.keys(state.books).length > 0);
  assert.ok(Object.values(state.books).every(book => book.source === 'demo'));
  const health = await (await fetch(`${app.base}/api/health`)).json();
  assert.equal(health.server, 'ok');
  assert.equal(health.mode, 'demo');
  assert.equal(health.events, state.events.length);
  for (const [path, mime] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css']]) {
    const response = await fetch(`${app.base}${path}`);
    assert.equal(response.status, 200, `${path} should be available`);
    assert.ok(response.headers.get('content-type').startsWith(mime));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok((await response.text()).length > 20);
  }
  assert.equal((await fetch(`${app.base}/package.json`)).status, 404, 'source files must not be served');
  assert.equal((await fetch(`${app.base}/unknown`)).status, 404);
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
  app.monitor.setSettings({ range: 'past' });
  const updated = await nextState();
  assert.equal(updated.range, 'past');
  await reader.cancel();
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
