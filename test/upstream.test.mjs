import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { Polymarket, requestJson } from '../src/upstream.mjs';

function fakeHttpsRequest(body, { encoding, inspect } = {}) {
  return (_url, options, callback) => {
    inspect?.(options);
    const request = new EventEmitter();
    request.write = () => {};
    request.destroy = error => {
      if (error) request.emit('error', error);
      request.emit('close');
    };
    request.end = () => queueMicrotask(() => {
      const response = Readable.from([body]);
      response.headers = encoding ? { 'content-encoding': encoding } : {};
      response.statusCode = 200;
      response.on('close', () => request.emit('close'));
      callback(response);
    });
    return request;
  };
}

test('requestJson accepts plain JSON and advertises gzip support', async () => {
  const result = await requestJson('https://example.test/plain', {
    httpsRequest: fakeHttpsRequest(Buffer.from('{"events":[]}'), {
      inspect: options => assert.equal(options.headers['Accept-Encoding'], 'gzip'),
    }),
  });
  assert.deepEqual(result, { events: [] });
});

test('requestJson decodes gzip JSON and rejects truncated gzip', async () => {
  const body = gzipSync(Buffer.from('{"events":[{"id":"game-1"}]}'));
  assert.deepEqual(await requestJson('https://example.test/gzip', {
    httpsRequest: fakeHttpsRequest(body, { encoding: 'gzip' }),
  }), { events: [{ id: 'game-1' }] });
  await assert.rejects(requestJson('https://example.test/truncated', {
    httpsRequest: fakeHttpsRequest(body.subarray(0, body.length - 5), { encoding: 'gzip' }),
  }), /unexpected end/i);
});

test('requestJson applies the 16 MB bound after decompression', async () => {
  const body = gzipSync(Buffer.from(JSON.stringify({ value: 'x'.repeat(16 * 1024 * 1024) })));
  assert.ok(body.length < 100_000);
  await assert.rejects(requestJson('https://example.test/too-large', {
    httpsRequest: fakeHttpsRequest(body, { encoding: 'gzip' }),
  }), /exceeds 16 MB/);
});

test('discover fetches every small page and preserves the NBA time window and versions', async () => {
  const calls = [];
  const pages = [
    { events: Array.from({ length: 5 }, (_, index) => ({ id: `game-${index}` })), next_cursor: 'page-2' },
    { events: [{ id: 'game-5' }], next_cursor: 'page-3' },
    { events: [{ id: 'game-6' }] },
  ];
  const upstream = new Polymarket({ request: async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/sports') return [{ sport: 'nba', series: '10345' }];
    calls.push(parsed);
    return pages[calls.length - 1];
  } });
  const events = await upstream.discover({ range: 'upcoming', now: new Date('2026-10-23T12:00:00Z') });
  assert.deepEqual(events.map(event => event.id), Array.from({ length: 7 }, (_, index) => `game-${index}`));
  assert.equal(calls.length, 3);
  for (const url of calls) {
    assert.equal(url.searchParams.get('series_id'), '10345');
    assert.equal(url.searchParams.get('closed'), 'any');
    assert.equal(url.searchParams.get('limit'), '5');
    assert.deepEqual(url.searchParams.getAll('version'), ['v1', 'v2']);
    assert.equal(url.searchParams.get('start_time_min'), '2026-10-22T12:00:00.000Z');
    assert.equal(url.searchParams.get('start_time_max'), '2026-10-27T12:00:00.000Z');
  }
  assert.deepEqual(calls.map(url => url.searchParams.get('after_cursor')), [null, 'page-2', 'page-3']);
});

test('discover rejects repeated cursors instead of reporting an incomplete list', async () => {
  const upstream = new Polymarket({ request: async url => new URL(url).pathname === '/sports'
    ? [{ sport: 'nba', series: '10345' }]
    : { events: [{ id: 'game-1' }], next_cursor: 'same-cursor' } });
  await assert.rejects(upstream.discover({ range: 'past' }), /repeated pagination cursor/);
});

test('discover keeps a finite pagination bound without returning a partial list', async () => {
  let pageCount = 0;
  const upstream = new Polymarket({ request: async url => new URL(url).pathname === '/sports'
    ? [{ sport: 'nba', series: '10345' }]
    : { events: [], next_cursor: `page-${++pageCount}` } });
  await assert.rejects(upstream.discover({ range: 'both' }), /pagination limit reached/);
  assert.equal(pageCount, 50);
});
