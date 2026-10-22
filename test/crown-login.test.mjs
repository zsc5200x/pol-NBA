import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMemberProtocol, CrownLoginService, CrownSessionStore } from '../src/crown/login.mjs';
import { ENDPOINT } from '../src/crown/config.mjs';

const origin = new URL(ENDPOINT).origin;
const xml = '<serverresponse><msg></msg><systemtime>2026-10-22 10:00:00</systemtime><systimestamp>1792648800</systimestamp></serverresponse>';

test('only a same-origin read-only member heartbeat supplies login protocol fields', () => {
  const request = `${ENDPOINT}?ver=web-2026`;
  assert.deepEqual(captureMemberProtocol(request, 'POST', 'p=mem_online&uid=opaque-user&ver=web-2026&langx=zh-cn'), {
    memberOrigin: origin, uid: 'opaque-user', ver: 'web-2026', langx: 'zh-cn',
  });
  assert.equal(captureMemberProtocol('https://other.example/transform.php', 'POST', 'p=mem_online&uid=x&ver=v1&langx=zh-cn'), null);
  assert.equal(captureMemberProtocol(request, 'POST', 'p=get_game_list&uid=x&ver=v1&langx=zh-cn'), null);
  assert.equal(captureMemberProtocol(request, 'GET', 'p=mem_online&uid=x&ver=v1&langx=zh-cn'), null);
});

test('standalone login verifies a session before encrypting it for this project', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pol-crown-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 0x4a);
  const store = new CrownSessionStore({ directory, keyProvider: async () => key });
  const pageHandlers = new Map();
  let pageUrl = '';
  const page = {
    on: (event, handler) => pageHandlers.set(event, handler),
    goto: async url => { pageUrl = url; },
    url: () => pageUrl,
    bringToFront: async () => {},
  };
  let connected = true;
  const context = {
    on: () => {},
    newPage: async () => page,
    pages: () => [page],
    storageState: async () => ({
      cookies: [
        { name: 'sid', value: 'private-cookie', domain: 'm321.mos077.com', path: '/transform.php', expires: -1, secure: true },
        { name: 'other', value: 'not-for-crown', domain: 'elsewhere.example', path: '/' },
      ],
      origins: [
        { origin, localStorage: [{ name: 'token', value: 'private-local-token' }] },
        { origin: 'https://elsewhere.example', localStorage: [{ name: 'token', value: 'exclude-me' }] },
      ],
    }),
    close: async () => {},
  };
  const browser = {
    isConnected: () => connected,
    on: () => {},
    newContext: async () => context,
    close: async () => { connected = false; },
  };
  let requestOptions;
  const service = new CrownLoginService({
    store,
    browserLauncher: async () => browser,
    fetcher: async (url, options) => {
      assert.equal(url, `${origin}/transform.php?ver=web-2026`);
      requestOptions = options;
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
    },
  });

  await service.start();
  pageHandlers.get('request')({
    url: () => `${ENDPOINT}?ver=web-2026`,
    method: () => 'POST',
    postData: () => 'p=mem_online&uid=private-uid&ver=web-2026&langx=zh-cn',
  });
  const ready = await service.status();
  assert.equal(ready.canVerify, true);
  assert.doesNotMatch(JSON.stringify(ready), /private-uid|private-cookie|private-local-token/);

  const saved = await service.verifyAndSave();
  assert.equal(saved.hasSession, true);
  assert.equal(saved.stage, 'saved');
  assert.match(requestOptions.body, /p=mem_online/);
  assert.equal(requestOptions.headers.Cookie, 'sid=private-cookie');
  assert.doesNotMatch(JSON.stringify(saved), /private-uid|private-cookie|private-local-token/);

  const session = await store.load();
  assert.equal(session.uid, 'private-uid');
  assert.equal(session.member_protocol.langx, 'zh-cn');
  assert.deepEqual(session.storage_state.origins.map(item => item.origin), [origin]);
  const encrypted = await readFile(join(directory, 'session.bin'));
  assert.doesNotMatch(encrypted.toString('utf8'), /private-uid|private-cookie|private-local-token/);
  await service.close();
});

test('session monitor opens one recovery window only after an explicit session rejection', async () => {
  const session = {
    member_origin: origin,
    member_protocol: { origin, ver: 'web-2026', langx: 'zh-cn' },
    member_ui_verified: true,
    uid: 'opaque-user',
    storage_state: { cookies: [], origins: [] },
  };
  const store = { load: async () => session, status: async () => ({ hasSession: true, lastSavedAt: null }) };
  const page = { handlers: new Map(), on(event, handler) { this.handlers.set(event, handler); }, goto: async url => { page.urlValue = url; }, url: () => page.urlValue, bringToFront: async () => {} };
  const context = { on() {}, newPage: async () => page, pages: () => [page], storageState: async () => session.storage_state, close: async () => {} };
  let launches = 0;
  let connected = true;
  const browser = { isConnected: () => connected, on() {}, newContext: async () => context, close: async () => { connected = false; } };
  let checks = 0;
  const service = new CrownLoginService({
    store,
    browserLauncher: async () => { launches++; return browser; },
    fetcher: async () => { checks++; return new Response(xml.replace('<msg></msg>', '<msg>expired</msg>'), { status: 200 }); },
  });
  const expired = await service.checkSavedSession();
  assert.equal(expired.sessionHealth, 'expired');
  assert.equal(expired.stage, 'recovering');
  assert.equal(expired.automaticRecovery, true);
  assert.equal(expired.browserOpen, true);
  assert.equal(launches, 1);

  await service.checkSavedSession();
  assert.equal(launches, 1, 'an expired saved session must not launch repeated browsers');
  assert.equal(checks, 1, 'the monitor pauses member checks while the recovery browser is open');
  await service.close();
});

test('concurrent manual and automatic login starts reuse one browser window', async () => {
  let releaseLoad;
  const store = {
    load: () => new Promise(resolve => { releaseLoad = () => resolve(null); }),
    status: async () => ({ hasSession: false, lastSavedAt: null }),
  };
  const page = { on() {}, goto: async () => {}, url: () => `${origin}/`, bringToFront: async () => {} };
  const context = { on() {}, newPage: async () => page, pages: () => [page], close: async () => {} };
  const browser = { isConnected: () => true, on() {}, newContext: async () => context, close: async () => {} };
  let launches = 0;
  const service = new CrownLoginService({ store, browserLauncher: async () => { launches++; return browser; } });

  const manualStart = service.start();
  const automaticRecovery = service.start({ autoRecovery: true });
  releaseLoad();
  await Promise.all([manualStart, automaticRecovery]);

  const status = await service.status();
  assert.equal(launches, 1);
  assert.equal(status.stage, 'recovering');
  assert.equal(status.automaticRecovery, true);
  await service.close();
});

test('session monitor preserves a saved session and does not open a login window on network failure', async () => {
  const session = {
    member_origin: origin,
    member_protocol: { origin, ver: 'web-2026', langx: 'zh-cn' },
    member_ui_verified: true,
    uid: 'opaque-user',
    storage_state: { cookies: [], origins: [] },
  };
  let launches = 0;
  const service = new CrownLoginService({
    store: { load: async () => session, status: async () => ({ hasSession: true, lastSavedAt: null }) },
    browserLauncher: async () => { launches++; throw new Error('should not open'); },
    fetcher: async () => { throw Object.assign(new TypeError('private proxy detail'), { code: 'ECONNRESET' }); },
  });
  const unavailable = await service.checkSavedSession();
  assert.equal(unavailable.sessionHealth, 'unavailable');
  assert.equal(unavailable.stage, 'unavailable');
  assert.equal(unavailable.hasSession, true);
  assert.equal(unavailable.browserOpen, false);
  assert.equal(unavailable.networkErrorCode, 'ECONNRESET');
  assert.doesNotMatch(JSON.stringify(unavailable), /private proxy detail/);
  assert.equal(launches, 0);
  await service.close();
});

test('session monitor does not treat malformed or unknown heartbeat XML as an expired session', async () => {
  const session = {
    member_origin: origin,
    member_protocol: { origin, ver: 'web-2026', langx: 'zh-cn' },
    member_ui_verified: true,
    uid: 'opaque-user',
    storage_state: { cookies: [], origins: [] },
  };
  const responses = [
    '<serverresponse><msg></msg></serverresponse>',
    xml.replace('<msg></msg>', '<msg>maintenance</msg>'),
  ];

  for (const body of responses) {
    let launches = 0;
    const service = new CrownLoginService({
      store: { load: async () => session, status: async () => ({ hasSession: true, lastSavedAt: null }) },
      browserLauncher: async () => { launches++; throw new Error('should not open'); },
      fetcher: async () => new Response(body, { status: 200 }),
    });
    const status = await service.checkSavedSession();
    assert.equal(status.sessionHealth, 'unavailable');
    assert.equal(status.stage, 'unavailable');
    assert.equal(status.hasSession, true);
    assert.equal(status.browserOpen, false);
    assert.equal(launches, 0);
    await service.close();
  }
});

test('session encryption detects tampering', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pol-crown-encrypted-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CrownSessionStore({ directory, keyProvider: async () => Buffer.alloc(32, 0x19) });
  const session = {
    member_origin: origin,
    member_protocol: { origin, ver: 'v1', langx: 'zh-cn' },
    member_ui_verified: true,
    uid: 'uid-private',
    storage_state: { cookies: [], origins: [] },
  };
  await store.save(session);
  const path = join(directory, 'session.bin');
  const bytes = await readFile(path);
  bytes[bytes.length - 1] ^= 1;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, bytes, { mode: 0o600 });
  await assert.rejects(store.load(), error => error.code === 'SESSION_DECRYPT');
});
