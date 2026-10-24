import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ENV_PROXY_KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'];

function connectProxy(host, portValue) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9._:\[\]-]+$/.test(host)) return null;
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue ?? '') || !Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const proxy = `http://${authority}:${port}`;
  try {
    const url = new URL(proxy);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/') return null;
    return proxy;
  } catch { return null; }
}

export function parseMacSystemProxy(output) {
  if (typeof output !== 'string') return null;
  const fields = {};
  let depth = 0;
  for (const line of output.split(/\r?\n/)) {
    if (depth === 1) {
      const entry = line.match(/^\s*(HTTPSEnable|HTTPSProxy|HTTPSPort|HTTPEnable|HTTPProxy|HTTPPort)\s*:\s*(.*?)\s*$/);
      if (entry) fields[entry[1]] = entry[2];
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth < 0) return null;
  }
  if (depth !== 0) return null;
  // macOS HTTPSProxy is an HTTP CONNECT proxy, not a TLS proxy URL.
  for (const kind of ['HTTPS', 'HTTP']) {
    if (fields[`${kind}Enable`] !== '1') continue;
    const proxy = connectProxy(fields[`${kind}Proxy`], fields[`${kind}Port`]);
    if (proxy) return proxy;
  }
  return null;
}

async function readMacSystemProxy() {
  const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  return stdout;
}

export function createCrownProxyResolver({ env = process.env, platform = process.platform, readSystemProxy = readMacSystemProxy, now = Date.now, cacheMs = 30000 } = {}) {
  let cached = null;
  let expiresAt = 0;
  let pending = null;
  return async function resolveProxy() {
    for (const key of ENV_PROXY_KEYS) {
      const value = env[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if (platform !== 'darwin') return null;
    if (pending) return pending;
    if (now() < expiresAt) return cached;
    pending = (async () => {
      try { cached = parseMacSystemProxy(await readSystemProxy()); }
      catch { cached = null; }
      expiresAt = now() + Math.max(0, Number(cacheMs) || 0);
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}

const defaultResolver = createCrownProxyResolver();

export async function resolveCrownProxy() {
  return defaultResolver();
}
