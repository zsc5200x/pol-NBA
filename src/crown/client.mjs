import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CORE, ENDPOINT, loadSession } from './config.mjs';
import { CrownError } from './parser.mjs';
import { isCrownEndpoint } from './endpoints.mjs';
import { resolveCrownProxy } from './network.mjs';

export class CrownClient {
  constructor(config, { sessionLoader = loadSession, transport = https.request } = {}) { this.config = config; this.sessionLoader = sessionLoader; this.transport = transport; this.lastRequest = 0; this.active = null; }
  cancel() { this.active?.destroy(new CrownError('STOPPED')); }
  async request(mode, profile, { gid, page, signal } = {}) {
    await delay(Math.max(0, this.config.requestGapMs - (Date.now() - this.lastRequest)), undefined, { signal });
    if (signal?.aborted) throw new CrownError('STOPPED');
    const session = await this.sessionLoader(this.config.sessionFile);
    const endpoint = session.endpoint ?? ENDPOINT;
    if (!isCrownEndpoint(endpoint)) throw new CrownError('INVALID_CONFIG');
    const origin = new URL(endpoint).origin;
    const params = { ...session.params, ...(profile.params ?? {}), ...(gid ? { p: 'get_game_more', gtype: 'bk', ltype: '3', lid: '100828', gid, showtype: mode, type: 'getMore', from: 'game_more', mode: 'NORMAL' } : CORE[mode]) };
    if (!['get_game_list', 'get_game_more'].includes(params.p) || (gid && !profile.params.filter)) throw new CrownError('READ_ONLY_ONLY');
    if (page !== undefined && profile.pagination?.requestField) params[profile.pagination.requestField] = String(page);
    if (this.config.timestamp?.reviewed && this.config.timestamp.field) params[this.config.timestamp.field] = String(this.config.timestamp.unit === 'seconds' ? Math.floor(Date.now() / 1000) : Date.now());
    const body = new URLSearchParams(params).toString();
    const proxy = await resolveCrownProxy();
    this.lastRequest = Date.now();
    return new Promise((resolve, reject) => {
      const request = this.transport(endpoint, { method: 'POST', signal, agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Content-Length': Buffer.byteLength(body), Cookie: session.cookie, Accept: '*/*', Origin: origin, Referer: `${origin}/`, 'User-Agent': 'Mozilla/5.0' } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) response.destroy(new CrownError('EMPTY_OR_OVERSIZE')); else chunks.push(chunk); });
        response.on('error', () => reject(new CrownError('NETWORK_ERROR')));
        response.on('end', () => {
          if ([401, 403].includes(response.statusCode)) { reject(new CrownError('ACCESS_OR_SESSION_DENIED')); return; }
          if (response.statusCode === 429 || response.statusCode >= 500) { reject(new CrownError(`HTTP_${response.statusCode === 429 ? '429' : '5XX'}`)); return; }
          if (response.statusCode !== 200) { reject(new CrownError('HTTP_ERROR')); return; }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });
      this.active = request;
      const timer = setTimeout(() => request.destroy(new CrownError('TIMEOUT')), this.config.timeoutMs);
      request.on('error', error => reject(error instanceof CrownError ? error : new CrownError(signal?.aborted ? 'STOPPED' : 'NETWORK_ERROR')));
      request.on('close', () => { clearTimeout(timer); if (this.active === request) this.active = null; });
      request.end(body);
    });
  }
}
