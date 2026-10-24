import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMemberProtocol, CrownLoginService, CrownSessionStore, verifyCrownSession } from '../src/crown/login.mjs';
import { ENDPOINT } from '../src/crown/config.mjs';
import { CROWN_ORIGINS, LOGIN_ORIGIN, crownEndpointForOrigin } from '../src/crown/endpoints.mjs';

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
  pageUrl = `${origin}/`;
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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function loginFixture(t, options = {}) {
  let saved = options.saved ?? null;
  const saves = [];
  const launches = [];
  const events = [];
  const store = {
    load: async () => saved,
    status: async () => ({ hasSession: Boolean(saved), lastSavedAt: null }),
    save: async (session, { isCurrent } = {}) => {
      if (isCurrent && !isCurrent()) return false;
      saves.push(session); saved = session; return true;
    },
    clear: async () => { saved = null; },
  };
  const browserLauncher = async () => {
    const pageHandlers = new Map();
    let closed = false;
    const page = {
      on: (event, handler) => pageHandlers.set(event, handler),
      goto: async url => { page.currentUrl = url; },
      url: () => page.currentUrl,
      isClosed: () => closed,
      bringToFront: async () => {},
      currentUrl: `${origin}/`,
      close() { closed = true; pageHandlers.get('close')?.(); },
      request(uid = 'synthetic-user', requestOrigin = new URL(page.currentUrl).origin) {
        pageHandlers.get('request')?.({ url: () => `${requestOrigin}/transform.php`, method: () => 'POST', postData: () => `p=mem_online&uid=${uid}&ver=web-2026&langx=zh-cn` });
      },
    };
    const context = {
      on() {}, newPage: async () => page, pages: () => closed ? [] : [page],
      storageState: async () => ({ cookies: [], origins: [] }),
    };
    let connected = true;
    let disconnect;
    const browser = {
      on: (event, handler) => { if (event === 'disconnected') disconnect = handler; },
      newContext: async () => context, isConnected: () => connected,
      close: async () => { connected = false; closed = true; disconnect?.(); },
    };
    launches.push({ page, context, browser });
    return browser;
  };
  const service = new CrownLoginService({ store, browserLauncher, autoVerifyDelayMs: 10, ...options });
  service.on('sessionSaved', event => events.push(event));
  t.after(() => service.close());
  return { service, store, saves, launches, events };
}

const syntheticSession = () => ({
  member_origin: origin, member_protocol: { origin, ver: 'web-2026', langx: 'zh-cn' },
  member_ui_verified: true, uid: 'synthetic-saved-user', storage_state: { cookies: [], origins: [] },
});

async function waitFor(t, condition) {
  for (let index = 0; index < 100; index++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out: ${t.name}`);
}

test('doubleLogin heartbeat is an explicit session rejection and opens recovery', async t => {
  const f = loginFixture(t, { saved: syntheticSession(), fetcher: async () => new Response('<serverresponse><code>error</code><msg>doubleLogin</msg></serverresponse>') });
  const state = await f.service.checkSavedSession();
  assert.equal(state.sessionHealth, 'expired');
  assert.equal(state.stage, 'recovering');
  assert.equal(state.browserOpen, true);
  assert.equal(f.launches.length, 1);
  assert.equal(f.saves.length, 0);
});

test('a real member request automatically verifies, saves and emits only safe metadata', async t => {
  let checks = 0;
  const f = loginFixture(t, { fetcher: async () => { checks++; return new Response(xml); } });
  await f.service.start();
  const { page } = f.launches[0];
  page.request(); page.request(); page.request();
  await waitFor(t, () => f.events.length === 1);
  const state = await f.service.status();
  assert.equal(checks, 1);
  assert.equal(f.saves.length, 1);
  assert.equal(state.sessionHealth, 'valid');
  assert.equal(state.stage, 'saved');
  assert.equal(state.browserOpen, false);
  assert.deepEqual(Object.keys(f.events[0]), ['verifiedAt']);
  assert.ok(Number.isFinite(Date.parse(f.events[0].verifiedAt)));
  assert.doesNotMatch(JSON.stringify(f.events), /synthetic-user|uid|cookie/);
});

test('manual verification shares an in-flight automatic verification without resetting its status', async t => {
  const response = deferred();
  let checks = 0;
  const f = loginFixture(t, { fetcher: async () => { checks++; return response.promise; } });
  await f.service.start();
  const { page } = f.launches[0];
  page.request();
  await waitFor(t, () => checks === 1);
  const manual = f.service.verifyAndSave();
  page.request();
  assert.equal((await f.service.status()).stage, 'verifying');
  response.resolve(new Response(xml));
  await manual;
  assert.equal(checks, 1);
  assert.equal(f.saves.length, 1);
  assert.equal(f.events.length, 1);
});

test('automatic verification retries are bounded for repeated requests from the same failed candidate', async t => {
  let checks = 0;
  const f = loginFixture(t, { fetcher: async () => { checks++; return new Response('<serverresponse><msg>maintenance</msg></serverresponse>'); } });
  await f.service.start();
  const { page } = f.launches[0];
  page.request();
  await waitFor(t, () => f.service.stage === 'error');
  for (let index = 0; index < 20; index++) page.request();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(checks, 1);
  assert.equal(f.saves.length, 0);
  page.request('synthetic-new-user');
  await waitFor(t, () => checks === 2);
});

test('cancelling a pending verification prevents a late response from saving or reopening the login', async t => {
  const response = deferred();
  let checks = 0;
  const f = loginFixture(t, { fetcher: async () => { checks++; return response.promise; } });
  await f.service.start();
  f.launches[0].page.request();
  const verification = f.service.verifyAndSave();
  await waitFor(t, () => checks === 1);
  await f.service.cancel();
  response.resolve(new Response(xml));
  await verification;
  const state = await f.service.status();
  assert.equal(state.stage, 'idle');
  assert.equal(state.browserOpen, false);
  assert.equal(state.hasSession, false);
  assert.equal(f.saves.length, 0);
  assert.equal(f.events.length, 0);
});

test('a new login candidate supersedes a pending verification and is saved on the next automatic attempt', async t => {
  const response = deferred();
  let checks = 0;
  const f = loginFixture(t, { fetcher: async () => { checks++; return checks === 1 ? response.promise : new Response(xml); } });
  await f.service.start();
  const { page } = f.launches[0];
  page.request('synthetic-first-user');
  const first = f.service.verifyAndSave();
  await waitFor(t, () => checks === 1);
  page.request('synthetic-new-user');
  response.resolve(new Response(xml));
  await first;
  assert.equal(f.saves.length, 0, 'the old response cannot commit or close the new candidate window');
  await waitFor(t, () => f.events.length === 1);
  assert.equal(checks, 2);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].uid, 'synthetic-new-user');
});

test('a delayed saved-session heartbeat cannot overwrite a newer login candidate', async t => {
  const response = deferred();
  let checks = 0;
  const f = loginFixture(t, { saved: syntheticSession(), autoVerifyDelayMs: 1000, fetcher: async () => { checks++; return response.promise; } });
  const heartbeat = f.service.checkSavedSession();
  await waitFor(t, () => checks === 1);
  await f.service.start();
  f.launches[0].page.request('synthetic-new-user');
  response.resolve(new Response('<serverresponse><code>error</code><msg>doubleLogin</msg></serverresponse>'));
  await heartbeat;
  const state = await f.service.status();
  assert.equal(state.stage, 'ready');
  assert.equal(state.automaticRecovery, false);
  assert.equal(state.sessionHealth, 'unknown');
  assert.equal(f.launches.length, 1);
});

test('an empty or blank browser no longer blocks heartbeat and start replaces only that owned window', async t => {
  let checks = 0;
  const f = loginFixture(t, { saved: syntheticSession(), fetcher: async () => { checks++; return new Response(xml); } });
  await f.service.start();
  f.launches[0].page.close();
  assert.equal((await f.service.status()).browserOpen, false);
  await f.service.checkSavedSession();
  assert.equal(checks, 1);
  assert.equal((await f.service.status()).sessionHealth, 'valid');
  await f.service.start();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[0].browser.isConnected(), false);
  f.launches[1].page.currentUrl = 'about:blank';
  assert.equal((await f.service.status()).browserOpen, false);
  await f.service.start();
  assert.equal(f.launches.length, 3);
  assert.equal(f.launches[1].browser.isConnected(), false);
  assert.equal((await f.service.status()).browserOpen, true);
});

test('an obsolete encrypted save is discarded after asynchronous key retrieval', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pol-crown-save-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = deferred();
  const store = new CrownSessionStore({ directory, keyProvider: () => key.promise });
  let current = true;
  const pending = store.save(syntheticSession(), { isCurrent: () => current });
  current = false;
  key.resolve(Buffer.alloc(32, 0x4a));
  assert.equal(await pending, false);
  assert.equal((await store.status()).hasSession, false);
});

test('cancel or clear during orphan-window cleanup prevents the pending start from opening a new window', async t => {
  for (const action of ['cancel', 'clear']) {
    await t.test(action, async t => {
      const f = loginFixture(t);
      await f.service.start();
      const { page, browser } = f.launches[0];
      page.currentUrl = 'about:blank';
      const closeStarted = deferred();
      const finishClose = deferred();
      const originalClose = browser.close;
      browser.close = async () => {
        closeStarted.resolve();
        await finishClose.promise;
        await originalClose();
      };
      const reopening = f.service.start();
      await closeStarted.promise;
      await f.service[action]();
      finishClose.resolve();
      await reopening;
      const state = await f.service.status();
      assert.equal(f.launches.length, 1, 'the cancelled opening must not create another owned browser');
      assert.equal(state.browserOpen, false);
      assert.equal(state.stage, 'idle');
    });
  }
});

test('confirmed member origins are accepted while lookalikes and URL credentials are rejected', () => {
  const body = 'p=mem_online&uid=synthetic-user&ver=web-2026&langx=zh-cn';
  for (const memberOrigin of CROWN_ORIGINS) {
    assert.equal(captureMemberProtocol(crownEndpointForOrigin(memberOrigin), 'POST', body)?.memberOrigin, memberOrigin);
  }
  for (const endpoint of [
    'https://m829.crw066.com.evil.example/transform.php', 'http://m829.crw066.com/transform.php',
    'https://m829.crw066.com:8443/transform.php', 'https://other.example/transform.php',
    'https://synthetic-user:synthetic-secret@m829.crw066.com/transform.php',
  ]) assert.equal(captureMemberProtocol(endpoint, 'POST', body), null);
});

test('a redirect to either approved member origin saves and verifies only that origins credentials', async t => {
  for (const memberOrigin of CROWN_ORIGINS) {
    await t.test(memberOrigin, async t => {
      let checks = 0;
      const f = loginFixture(t, { fetcher: async (url, options) => {
        checks++;
        assert.equal(url, `${memberOrigin}/transform.php?ver=web-2026`);
        assert.equal(options.headers.Origin, memberOrigin);
        assert.equal(options.headers.Referer, `${memberOrigin}/`);
        assert.equal(options.headers.Cookie, 'sid=synthetic-current-cookie');
        assert.equal(new URLSearchParams(options.body).get('uid'), 'synthetic-current-user');
        return new Response(xml);
      } });
      await f.service.start();
      const { page, context } = f.launches[0];
      assert.equal(page.currentUrl, `${LOGIN_ORIGIN}/`, 'login starts directly at the confirmed current entry');
      const otherOrigin = CROWN_ORIGINS.find(value => value !== memberOrigin);
      context.storageState = async () => ({
        cookies: [
          { name: 'sid', value: 'synthetic-current-cookie', domain: new URL(memberOrigin).hostname, path: '/', expires: -1 },
          { name: 'sid', value: 'synthetic-other-cookie', domain: new URL(otherOrigin).hostname, path: '/', expires: -1 },
        ],
        origins: [
          { origin: memberOrigin, localStorage: [{ name: 'synthetic', value: 'current' }] },
          { origin: otherOrigin, localStorage: [{ name: 'synthetic', value: 'other' }] },
        ],
      });
      page.currentUrl = `${memberOrigin}/member`;
      page.request('synthetic-current-user');
      assert.equal((await f.service.status()).memberOrigin, memberOrigin);
      await waitFor(t, () => f.events.length === 1);
      assert.equal(f.saves[0].member_origin, memberOrigin);
      assert.equal(f.saves[0].member_protocol.origin, memberOrigin);
      assert.deepEqual(f.saves[0].storage_state.cookies.map(cookie => cookie.value), ['synthetic-current-cookie']);
      assert.deepEqual(f.saves[0].storage_state.origins.map(entry => entry.origin), [memberOrigin]);
      const restarted = new CrownLoginService({ store: f.store, fetcher: f.service.fetcher });
      t.after(() => restarted.close());
      assert.equal((await restarted.checkSavedSession()).sessionHealth, 'valid');
      assert.equal(checks, 2, 'a restarted service verifies the stored member origin, not the login entry origin');
    });
  }
});

test('an unknown live domain is preserved and cannot capture, verify, or trigger recovery of a saved session', async t => {
  let checks = 0;
  const f = loginFixture(t, { saved: syntheticSession(), fetcher: async () => { checks++; return new Response(xml); } });
  await f.service.start();
  const { page, browser } = f.launches[0];
  page.currentUrl = 'https://unsupported.example/member?uid=do-not-show';
  page.request('synthetic-unknown-user');
  page.request('synthetic-cross-origin-user', LOGIN_ORIGIN);
  const state = await f.service.status();
  assert.equal(state.browserOpen, true);
  assert.equal(state.canVerify, false);
  assert.equal(state.stage, 'unsupported_origin');
  assert.equal(state.unsupportedOrigin, 'https://unsupported.example');
  assert.match(state.message, /域名尚未支持/);
  assert.doesNotMatch(JSON.stringify(state), /do-not-show|synthetic-cross-origin-user/);
  await f.service.start();
  await f.service.checkSavedSession();
  await assert.rejects(f.service.verifyAndSave(), error => error.code === 'MEMBER_ORIGIN_UNSUPPORTED');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(checks, 0);
  assert.equal(f.launches.length, 1);
  assert.equal(browser.isConnected(), true);
  assert.equal(f.saves.length, 0);
});

test('a candidate from one approved origin cannot be reused after navigation to another origin', async t => {
  let checks = 0;
  const f = loginFixture(t, { autoVerifyDelayMs: 1000, fetcher: async () => { checks++; return new Response(xml); } });
  await f.service.start();
  const { page } = f.launches[0];
  page.currentUrl = `${CROWN_ORIGINS[0]}/member`;
  page.request('synthetic-first-user');
  page.currentUrl = `${CROWN_ORIGINS[1]}/member`;
  page.request('synthetic-cross-origin-user', CROWN_ORIGINS[0]);
  assert.equal((await f.service.status()).canVerify, false);
  await assert.rejects(f.service.verifyAndSave(), error => error.code === 'MEMBER_CHECK_NOT_SEEN');
  assert.equal(checks, 0);
  page.request('synthetic-new-user');
  await f.service.verifyAndSave();
  assert.equal(f.saves[0].member_origin, CROWN_ORIGINS[1]);
  assert.equal(f.saves[0].uid, 'synthetic-new-user');
});

test('verification rejects mismatched session origins and cross-origin responses even between approved sites', async () => {
  const original = CROWN_ORIGINS[0];
  const other = CROWN_ORIGINS[1];
  const session = syntheticSession();
  session.member_origin = original;
  session.member_protocol.origin = other;
  let checks = 0;
  await assert.rejects(verifyCrownSession(session, async () => { checks++; return new Response(xml); }), error => error.code === 'SESSION_INVALID');
  assert.equal(checks, 0);
  session.member_protocol.origin = original;
  await assert.rejects(verifyCrownSession(session, async () => ({ status: 200, url: `${other}/transform.php`, body: null })), error => error.code === 'VERIFY_HTTP');
});

test('encrypted sessions from both approved origins can be loaded and verified after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pol-crown-origin-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyProvider = async () => Buffer.alloc(32, 0x4a);
  for (const memberOrigin of CROWN_ORIGINS) {
    const session = syntheticSession();
    session.member_origin = memberOrigin;
    session.member_protocol.origin = memberOrigin;
    await new CrownSessionStore({ directory, keyProvider }).save(session);
    const restarted = new CrownLoginService({
      store: new CrownSessionStore({ directory, keyProvider }),
      fetcher: async url => {
        assert.equal(new URL(url).origin, memberOrigin);
        return new Response(xml);
      },
    });
    assert.equal((await restarted.checkSavedSession()).sessionHealth, 'valid');
    await restarted.close();
  }
});
