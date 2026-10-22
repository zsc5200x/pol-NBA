import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';

const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
export const MARKET_SOCKET = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export function requestJson(url, { method = 'GET', body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(url, {
      agent, method, headers: {
        'User-Agent': 'pol-nba-monitor/0.1 (read-only)', Accept: 'application/json',
        ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
      },
    }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 16 * 1024 * 1024) { response.destroy(new Error('Upstream response exceeds 16 MB')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${new URL(url).hostname}: HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error(`${new URL(url).hostname}: invalid JSON response`)); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error(`${new URL(url).hostname}: request timeout`)), timeout);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
    if (data !== undefined) request.write(data);
    request.end();
  });
}

export class Polymarket {
  async discover({ range, now = new Date() }) {
    const sports = await requestJson(`${GAMMA}/sports`);
    if (!Array.isArray(sports)) throw new Error('Gamma sports response is not an array');
    const nba = sports.find(s => String(s.sport).toLowerCase() === 'nba');
    if (!nba?.series) throw new Error('Gamma sports metadata did not provide the NBA series ID');
    const events = [];
    // Query a padded UTC window; selectEvents applies the exact calendar days in the selected timezone.
    const minimum = new Date(now.getTime() - (range === 'upcoming' ? 1 : 3) * 86400000).toISOString();
    const maximum = new Date(now.getTime() + 4 * 86400000).toISOString();
    let cursor;
    const seen = new Set();
    for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
      const params = new URLSearchParams({
        series_id: String(nba.series), closed: 'any', limit: '100',
        start_time_min: minimum, start_time_max: maximum,
      });
      params.append('version', 'v1');
      params.append('version', 'v2');
      if (cursor) params.set('after_cursor', cursor);
      const page = await requestJson(`${GAMMA}/events/keyset?${params}`);
      if (!Array.isArray(page.events)) throw new Error('Gamma events response has no events array');
      events.push(...page.events);
      if (!page.next_cursor) return events;
      if (seen.has(page.next_cursor)) throw new Error('Gamma returned a repeated pagination cursor');
      cursor = page.next_cursor;
      seen.add(cursor);
    }
    throw new Error('Gamma pagination limit reached; refusing to report a partial match list');
  }

  async books(tokenIds) {
    if (!tokenIds.length) return [];
    const books = await requestJson(`${CLOB}/books`, { method: 'POST', body: tokenIds.map(token_id => ({ token_id })) });
    if (!Array.isArray(books)) throw new Error('CLOB books response is not an array');
    return books;
  }

  socket() {
    return new WebSocket(MARKET_SOCKET, { agent, handshakeTimeout: 15000, maxPayload: 16 * 1024 * 1024 });
  }
}
