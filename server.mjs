import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { Monitor } from './src/monitor.mjs';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const FILES = new Map([['/', 'index.html'], ['/app.js', 'app.js'], ['/chinese.js', 'chinese.js'], ['/styles.css', 'styles.css']]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp({ monitor = new Monitor() } = {}) {
  const clients = new Set();
  const send = (response, state) => {
    if (response.writableLength > 2 * 1024 * 1024) { response.destroy(); return; }
    response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  };
  const broadcast = state => { for (const response of clients) send(response, state); };
  monitor.on('state', broadcast);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const json = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(payload)); };
    if (request.method === 'GET' && url.pathname === '/api/state') { json(200, monitor.snapshot()); return; }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      const state = monitor.snapshot();
      json(200, { server: 'ok', mode: state.mode, upstream: state.status, events: state.events.length, books: Object.keys(state.books).length });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      clients.add(response);
      send(response, monitor.snapshot());
      request.on('close', () => clients.delete(response));
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
  const heartbeat = setInterval(() => { for (const response of clients) response.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); monitor.off('state', broadcast); });
  return { server, monitor, close: () => { monitor.stop(); for (const client of clients) client.end(); server.close(); } };
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
