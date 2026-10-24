import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrownClient } from '../src/crown/client.mjs';
import { loadSession, ENDPOINT } from '../src/crown/config.mjs';

const memberOrigin = 'https://m829.crw066.com';
const session = origin => ({
  member_origin: origin,
  member_protocol: { origin, ver: 'web-test', langx: 'zh-cn' },
  uid: 'synthetic-member',
  storage_state: { cookies: [
    { name: 'old', value: 'old-site-only', domain: 'm321.mos077.com', path: '/' },
    { name: 'new', value: 'new-site-only', domain: 'm829.crw066.com', path: '/' },
  ], origins: [] },
});

test('saved member origin routes today, early and detail requests with only its own cookies', async () => {
  const observed = [];
  const client = new CrownClient({ endpoint: ENDPOINT, requestGapMs: 1, timeoutMs: 1000 }, {
    sessionLoader: () => loadSession(null, { store: { load: async () => session(memberOrigin) } }),
    transport: (endpoint, options, callback) => {
      const request = new EventEmitter();
      request.end = body => queueMicrotask(() => {
        observed.push({ endpoint, options, params: new URLSearchParams(body) });
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        response.emit('data', Buffer.from('{"response":{}}'));
        response.emit('end');
        request.emit('close');
      });
      return request;
    },
  });
  for (const mode of ['today', 'early']) {
    await client.request(mode, { params: { filter: 'FU' } });
    await client.request(mode, { params: { filter: 'Main' } }, { gid: '10636894' });
  }
  assert.equal(observed.length, 4);
  for (const { endpoint, options, params } of observed) {
    assert.equal(endpoint, `${memberOrigin}/transform.php`);
    assert.equal(options.headers.Origin, memberOrigin);
    assert.equal(options.headers.Referer, `${memberOrigin}/`);
    assert.equal(options.headers.Cookie, 'new=new-site-only');
    assert.equal(params.get('uid'), 'synthetic-member');
    assert.equal(params.get('ver'), 'web-test');
    assert.equal(params.get('gtype'), 'bk');
  }
  assert.deepEqual(observed.map(r => [r.params.get('p'), r.params.get('showtype')]), [
    ['get_game_list', 'today'], ['get_game_more', 'today'],
    ['get_game_list', 'early'], ['get_game_more', 'early'],
  ]);
});

test('unknown and mismatched saved origins cannot supply collector credentials', async () => {
  for (const value of [session('https://unknown.example'), { ...session(memberOrigin), member_protocol: { origin: 'https://m321.mos077.com' } }]) {
    await assert.rejects(loadSession(null, { store: { load: async () => value } }), /SESSION_MISSING/);
  }
  const client = new CrownClient({ requestGapMs: 1 }, {
    sessionLoader: async () => ({ endpoint: 'https://unknown.example/transform.php' }),
    transport: () => assert.fail('unknown destination must never receive a request'),
  });
  await assert.rejects(client.request('today', { params: {} }), /INVALID_CONFIG/);
});

test('manual session files keep their captured endpoint and reject unknown destinations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pol-crown-endpoint-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.json');
  const manual = { params: { uid: 'synthetic', ver: 'test' }, cookie: 'fake=value' };
  await writeFile(path, JSON.stringify(manual), { mode: 0o600 });
  assert.equal((await loadSession(path)).endpoint, ENDPOINT);
  await writeFile(path, JSON.stringify({ ...manual, endpoint: `${memberOrigin}/transform.php` }));
  assert.equal((await loadSession(path)).endpoint, `${memberOrigin}/transform.php`);
  await writeFile(path, JSON.stringify({ ...manual, endpoint: 'https://unknown.example/transform.php' }));
  await assert.rejects(loadSession(path), /INVALID_CONFIG/);
});
