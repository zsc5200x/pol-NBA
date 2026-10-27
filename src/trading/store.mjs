import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_SETTINGS = Object.freeze({ stakeUsdc: null, buySlippage: 0.02, takeProfitIncrement: 0.02 });
const RECORD_FIELDS = [
  'id', 'externalId', 'status', 'reason', 'team', 'handicap', 'stakeUsdc',
  'entryPrice', 'shares', 'exitPrice', 'buyOrderId', 'sellOrderId', 'createdAt',
];

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const result = {};
  for (const key of RECORD_FIELDS) {
    const value = record[key];
    if (typeof value === 'string') result[key] = value.slice(0, key === 'reason' ? 300 : 160);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result.id && result.status ? result : null;
}

function safeState(state) {
  const settings = state?.settings && typeof state.settings === 'object' ? state.settings : {};
  const records = Array.isArray(state?.records) ? state.records.map(safeRecord).filter(Boolean).slice(-200) : [];
  const processedIds = Array.isArray(state?.processedIds)
    ? [...new Set(state.processedIds.filter(value => typeof value === 'string' && value.length <= 100))].slice(-2000) : [];
  return {
    settings: {
      stakeUsdc: finiteOrNull(settings.stakeUsdc),
      buySlippage: Number.isFinite(settings.buySlippage) ? settings.buySlippage : DEFAULT_SETTINGS.buySlippage,
      takeProfitIncrement: Number.isFinite(settings.takeProfitIncrement) ? settings.takeProfitIncrement : DEFAULT_SETTINGS.takeProfitIncrement,
    },
    records,
    processedIds,
  };
}

export class TradingStateStore {
  constructor(filename = '.local/trading-state.json') {
    this.filename = filename;
    this.pendingWrite = Promise.resolve();
  }

  async load() {
    let raw;
    try { raw = await readFile(this.filename, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return safeState({ settings: DEFAULT_SETTINGS, records: [], seen: [] });
      throw error;
    }
    if (raw.length > 1024 * 1024) throw new Error('TRADING_STATE_TOO_LARGE');
    try { return safeState(JSON.parse(raw)); }
    catch { throw new Error('TRADING_STATE_INVALID'); }
  }

  async save(state) {
    const snapshot = safeState(state);
    const serialized = `${JSON.stringify(snapshot)}\n`;
    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${process.pid}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.filename);
    });
    await this.pendingWrite;
  }
}

export { DEFAULT_SETTINGS };
