import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingStateStore } from '../src/trading/store.mjs';

test('persists editable settings, signal dedupe keys and only allowlisted record fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pol-trading-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'nested', 'state.json');
  const store = new TradingStateStore(filename);
  const state = {
    settings: { stakeUsdc: 7.5, buySlippage: 0.03, takeProfitIncrement: 0.02 },
    processedIds: ['signal-1', 'signal-2'],
    records: [{
      id: 'record-1', externalId: 'signal-1', status: 'skipped', reason: 'disabled',
      team: 'Memphis Grizzlies', handicap: 1.5, stakeUsdc: 7.5, createdAt: '2026-10-26T00:00:00.000Z',
      telegramToken: 'must-not-be-stored', privateKey: 'must-not-be-stored', rawMessage: 'private content',
    }],
  };
  await Promise.all([store.save(state), store.save(state)]);

  assert.deepEqual(await store.load(), {
    settings: { stakeUsdc: 7.5, buySlippage: 0.03, takeProfitIncrement: 0.02 },
    processedIds: ['signal-1', 'signal-2'],
    records: [{
      id: 'record-1', externalId: 'signal-1', status: 'skipped', reason: 'disabled',
      team: 'Memphis Grizzlies', handicap: 1.5, stakeUsdc: 7.5, createdAt: '2026-10-26T00:00:00.000Z',
    }],
  });
  const file = await readFile(filename, 'utf8');
  assert.doesNotMatch(file, /telegramToken|privateKey|rawMessage|must-not-be-stored|private content/);
});
