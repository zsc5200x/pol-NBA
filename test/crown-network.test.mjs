import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrownProxyResolver, parseMacSystemProxy } from '../src/crown/network.mjs';

const settings = fields => `<dictionary> {\n${Object.entries(fields).map(([key, value]) => `  ${key} : ${value}`).join('\n')}\n}`;
const enabled = () => settings({ HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: 1082 });
const disabled = () => settings({ HTTPSEnable: 0, HTTPSProxy: '127.0.0.1', HTTPSPort: 1082, HTTPEnable: 0 });

test('macOS enabled HTTPS proxy is an HTTP CONNECT URL and takes priority over HTTP settings', () => {
  assert.equal(parseMacSystemProxy(enabled()), 'http://127.0.0.1:1082');
  assert.equal(parseMacSystemProxy(settings({
    HTTPSEnable: 1, HTTPSProxy: 'secure-proxy.example', HTTPSPort: 8443,
    HTTPEnable: 1, HTTPProxy: 'plain-proxy.example', HTTPPort: 8080,
  })), 'http://secure-proxy.example:8443');
  assert.equal(parseMacSystemProxy(settings({ HTTPSEnable: 0, HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: 8080 })), 'http://127.0.0.1:8080');
  assert.equal(parseMacSystemProxy(settings({ HTTPSEnable: 1, HTTPSProxy: '::1', HTTPSPort: 1082 })), 'http://[::1]:1082');
});

test('disabled, malformed, scoped-only, PAC and SOCKS proxies do not fabricate an HTTP proxy', () => {
  assert.equal(parseMacSystemProxy(disabled()), null);
  assert.equal(parseMacSystemProxy(settings({ HTTPSProxy: '127.0.0.1', HTTPSPort: 1082 })), null);
  assert.equal(parseMacSystemProxy(settings({ ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'https://example.invalid/proxy.pac', SOCKSEnable: 1, SOCKSProxy: '127.0.0.1', SOCKSPort: 1080 })), null);
  assert.equal(parseMacSystemProxy('<dictionary> {\n  __SCOPED__ : <dictionary> {\n    en0 : <dictionary> {\n      HTTPSEnable : 1\n      HTTPSProxy : 127.0.0.1\n      HTTPSPort : 1082\n    }\n  }\n}'), null);
  assert.equal(parseMacSystemProxy(enabled().slice(0, -1)), null);
  assert.equal(parseMacSystemProxy(null), null);
  for (const port of ['0', '-1', '65536', '1.5', '1082junk']) {
    assert.equal(parseMacSystemProxy(settings({ HTTPSEnable: 1, HTTPSProxy: '127.0.0.1', HTTPSPort: port })), null);
  }
  for (const host of ['user:password@proxy.example', 'https://proxy.example', 'proxy.example/path', 'proxy.example?secret', 'bad host']) {
    assert.equal(parseMacSystemProxy(settings({ HTTPSEnable: 1, HTTPSProxy: host, HTTPSPort: 1082 })), null);
  }
});

test('explicit environment proxies retain existing priority and bypass system inspection', async () => {
  const env = { https_proxy: 'http://first.example:1', HTTPS_PROXY: 'http://second.example:2', http_proxy: 'http://third.example:3', HTTP_PROXY: 'http://fourth.example:4' };
  let reads = 0;
  const resolve = createCrownProxyResolver({ env, platform: 'darwin', readSystemProxy: async () => { reads++; return enabled(); } });
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) {
    assert.equal(await resolve(), env[key]);
    delete env[key];
  }
  assert.equal(reads, 0);
  assert.equal(await resolve(), 'http://127.0.0.1:1082');
  assert.equal(reads, 1);
});

test('other platforms do not execute macOS commands but still honor explicit proxies', async () => {
  const env = {};
  let reads = 0;
  const resolve = createCrownProxyResolver({ env, platform: 'linux', readSystemProxy: async () => { reads++; return enabled(); } });
  assert.equal(await resolve(), null);
  env.HTTPS_PROXY = 'http://proxy.example:8080';
  assert.equal(await resolve(), env.HTTPS_PROXY);
  assert.equal(reads, 0);
});

test('system proxy reads are shared and cached for 30 seconds, including later disabled settings', async () => {
  let now = 100;
  let reads = 0;
  let release;
  const resolve = createCrownProxyResolver({ env: {}, platform: 'darwin', now: () => now,
    readSystemProxy: async () => {
      reads++;
      if (reads === 1) return new Promise(done => { release = done; });
      return disabled();
    },
  });
  const first = resolve();
  const concurrent = resolve();
  assert.equal(reads, 1);
  release(enabled());
  assert.deepEqual(await Promise.all([first, concurrent]), ['http://127.0.0.1:1082', 'http://127.0.0.1:1082']);
  now = 30099;
  assert.equal(await resolve(), 'http://127.0.0.1:1082');
  assert.equal(reads, 1);
  now = 30100;
  assert.equal(await resolve(), null);
  assert.equal(reads, 2);
  now = 30200;
  assert.equal(await resolve(), null);
  assert.equal(reads, 2, 'a disabled result is cached too');
});

test('command failures safely return direct mode, expire, and recover without caching the failure forever', async () => {
  let now = 0;
  let reads = 0;
  const resolve = createCrownProxyResolver({ env: {}, platform: 'darwin', now: () => now,
    readSystemProxy: async () => {
      reads++;
      if (reads === 1) throw Object.assign(new Error('synthetic scutil timeout'), { code: 'ETIMEDOUT' });
      return enabled();
    },
  });
  assert.equal(await resolve(), null);
  assert.equal(await resolve(), null);
  assert.equal(reads, 1);
  now = 30000;
  assert.equal(await resolve(), 'http://127.0.0.1:1082');
  assert.equal(reads, 2);
});

test('environment changes take effect immediately over cached system settings', async () => {
  const env = {};
  let reads = 0;
  const resolve = createCrownProxyResolver({ env, platform: 'darwin', readSystemProxy: async () => { reads++; return enabled(); } });
  assert.equal(await resolve(), 'http://127.0.0.1:1082');
  env.HTTPS_PROXY = 'http://explicit.example:8080';
  assert.equal(await resolve(), env.HTTPS_PROXY);
  delete env.HTTPS_PROXY;
  assert.equal(await resolve(), 'http://127.0.0.1:1082');
  assert.equal(reads, 1);
});
