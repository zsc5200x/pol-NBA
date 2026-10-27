import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramReceiver, parseTelegramAllowlist } from '../src/trading/telegram.mjs';

function telegramResponse(result, { status = 200, ok = true, errorCode, parameters } = {}) {
  return new Response(JSON.stringify({ ok, result, error_code: errorCode, parameters }), { status });
}

function harness({ updates = [], onSignal = async () => {}, response, ...options } = {}) {
  const requests = [];
  let calls = 0;
  let resolveFirst;
  const firstCall = new Promise(resolve => { resolveFirst = resolve; });
  const receiver = new TelegramReceiver({
    token: '123456:secret-token',
    allowedChatIds: ['-1001'],
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const callNumber = calls++;
      const selected = response
        ? await response({ url, init, calls: callNumber })
        : telegramResponse(callNumber === 0 ? updates : []);
      resolveFirst();
      return selected;
    },
    onSignal,
    retryMinMs: 1,
    retryMaxMs: 5,
    sleep: async () => {},
    ...options,
  });
  return { receiver, requests, firstCall };
}

test('parses Telegram allowlists without losing negative channel IDs', () => {
  assert.deepEqual([...parseTelegramAllowlist('-1001, 123, -2002')], ['-1001', '123', '-2002']);
  assert.throws(() => parseTelegramAllowlist('12,not-an-id'), /decimal integers/);
  assert.throws(() => new TelegramReceiver({ token: 'token', allowedChatIds: [], onSignal() {} }), /allowed Telegram chat ID/);
});

test('polls only allowed chat and sender messages, text/caption only, without sending anything', async t => {
  const seen = [];
  const { receiver, requests, firstCall } = harness({
    allowedSenderIds: ['77'],
    updates: [
      { update_id: 1, message: { message_id: 10, chat: { id: -1001 }, from: { id: 77 }, text: 'allowed' } },
      { update_id: 2, message: { message_id: 11, chat: { id: -1001 }, from: { id: 78 }, text: 'wrong sender' } },
      { update_id: 3, message: { message_id: 12, chat: { id: -2000 }, from: { id: 77 }, text: 'wrong chat' } },
      { update_id: 4, message: { message_id: 13, chat: { id: -1001 }, from: { id: 77 }, photo: [] } },
      { update_id: 5, channel_post: { message_id: 14, chat: { id: -1001 }, caption: 'channel caption' } },
    ],
    onSignal: async message => seen.push(message),
  });
  t.after(() => receiver.stop());
  receiver.start();
  await firstCall;
  await receiver.stop();

  assert.deepEqual(seen.map(message => [message.chatId, message.messageId, message.kind, message.text]), [
    ['-1001', '10', 'message', 'allowed'],
    ['-1001', '14', 'channel_post', 'channel caption'],
  ]);
  assert.equal(requests.length, 1);
  const pollUrl = new URL(requests[0].url);
  assert.equal(pollUrl.pathname, '/bot123456:secret-token/getUpdates');
  assert.deepEqual(JSON.parse(pollUrl.searchParams.get('allowed_updates')), ['message', 'channel_post']);
  assert.equal(requests[0].init.method, undefined, 'the receiver only uses read-only getUpdates');
  assert.equal(receiver.status().running, false);
});

test('advances offset only after the signal callback succeeds and retries the same update', async t => {
  let callbacks = 0;
  let fetches = 0;
  const requests = [];
  const update = { update_id: 20, message: { message_id: 30, chat: { id: -1001 }, from: { id: 77 }, text: 'signal' } };
  const receiver = new TelegramReceiver({
    token: 'secret', allowedChatIds: ['-1001'],
    fetchImpl: async (url) => {
      requests.push(new URL(String(url)).searchParams.get('offset'));
      fetches++;
      return telegramResponse(fetches <= 2 ? [update] : []);
    },
    onSignal: async () => { callbacks++; if (callbacks === 1) throw new Error('handler failure'); else receiver.stop(); },
    retryMinMs: 0, retryMaxMs: 0, sleep: async () => {}, pollTimeoutSeconds: 0,
  });
  t.after(() => receiver.stop());
  receiver.start();
  await receiver.loopPromise;

  assert.equal(callbacks, 2);
  assert.deepEqual(requests, [null, null]);
  assert.equal(receiver.status().lastError, null);
  assert.equal(receiver.status().running, false);
});

test('a successful callback is acknowledged on the next long poll', async t => {
  const requests = [];
  let calls = 0;
  const update = { update_id: 5, message: { message_id: 1, chat: { id: -1001 }, text: 'signal' } };
  const receiver = new TelegramReceiver({
    token: 'secret', allowedChatIds: ['-1001'],
    fetchImpl: async url => {
      requests.push(new URL(String(url)).searchParams.get('offset'));
      if (calls++ === 0) return telegramResponse([update]);
      receiver.stop();
      return telegramResponse([]);
    },
    onSignal: async () => {},
    retryMinMs: 0,
    pollTimeoutSeconds: 0,
  });
  t.after(() => receiver.stop());
  receiver.start();
  await receiver.loopPromise;
  assert.deepEqual(requests, [null, '6']);
});

test('a Telegram 409 conflict stops polling and does not expose the bot token', async t => {
  const { receiver } = harness({
    response: async () => telegramResponse([], { status: 409, ok: false, errorCode: 409 }),
  });
  t.after(() => receiver.stop());
  receiver.start();
  await receiver.loopPromise;
  const status = receiver.status();
  assert.equal(status.running, false);
  assert.equal(status.stopReason, 'poll_conflict');
  assert.equal(status.lastError, 'poll_conflict');
  assert.equal(JSON.stringify(status).includes('secret-token'), false);
});

test('an unauthorized token stops polling without logging request details', async t => {
  const { receiver } = harness({
    response: async () => telegramResponse([], { status: 401, ok: false, errorCode: 401 }),
  });
  t.after(() => receiver.stop());
  receiver.start();
  await receiver.loopPromise;
  assert.equal(receiver.status().stopReason, 'unauthorized');
  assert.equal(JSON.stringify(receiver.status()).includes('secret-token'), false);
});

test('stop aborts the outstanding long poll and does not schedule a retry', async () => {
  let aborted = false;
  const receiver = new TelegramReceiver({
    token: 'secret', allowedChatIds: ['-1001'],
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
    onSignal: async () => assert.fail('no signal should be received'),
  });
  receiver.start();
  await receiver.stop();
  assert.equal(aborted, true);
  assert.equal(receiver.status().running, false);
});
