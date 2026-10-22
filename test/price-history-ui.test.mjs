import test from 'node:test';
import assert from 'node:assert/strict';
import { historyPrice, historyMovement, historyTime, recordsForSelection, orderedHistorySides, historyOutcomes } from '../public/price-history.js';

test('历史按平台单位显示，缺失价格不作为零，涨跌避免浮点误差', () => {
  assert.equal(historyPrice(0.52, 'pol'), '52 分');
  assert.equal(historyPrice(0.95, 'crown'), '0.950');
  assert.equal(historyPrice(null, 'crown'), '—');
  assert.equal(historyMovement(0.52, 0.50, 'pol').text, '↑ +2 分');
  assert.equal(historyMovement(0.9, 0.95, 'crown').text, '↓ −0.050');
  assert.equal(historyMovement(0.1 + 0.2, 0.3, 'pol').text, '持平');
  assert.equal(historyMovement(null, 0.95, 'crown').description, '无前次有效报价');
});

test('历史遵循后端不可比判定，不对不同赔率格式或无效报价重算涨跌', () => {
  assert.equal(historyMovement(1.93, 0.93, 'crown', null).className, '');
  assert.equal(historyMovement(1.93, 0.93, 'crown', null).text, '—');
  assert.equal(historyMovement(0.52, 0.50, 'pol', 0).text, '持平');
  assert.equal(historyMovement(0.52, null, 'pol', 0.02).text, '↑ +2 分');
});

test('时间保留日期与秒，按项目时区跨日显示', () => {
  assert.deepEqual(historyTime('2026-10-22T16:12:05.000Z', 'Asia/Shanghai'), { date: '10-23', time: '00:12:05' });
  assert.deepEqual(historyTime('bad'), { date: '时间未知', time: '—' });
});

test('响应过滤严格限制同场同线同平台，避免异步切换时串线', () => {
  const context = { event: { id: 'e1' }, market: { id: 'm1' }, type: 'spreads' };
  const base = { eventId: 'e1', marketId: 'm1', type: 'spreads', source: 'pol' };
  const records = [
    { ...base, id: 1 }, { ...base, id: 9 }, { ...base, id: 8, marketId: 'm2' },
    { ...base, id: 7, eventId: 'e2' }, { ...base, id: 6, type: 'totals' },
    { ...base, id: 5, source: 'crown' },
  ];
  assert.deepEqual(recordsForSelection(records, context, 'pol').map(row => row.id), [9, 1]);
});

test('让分双方按盘口参考球队排序，并按token匹配价格而非响应数组顺序', () => {
  const event = { title: 'Denver Nuggets vs Oklahoma City Thunder' };
  const market = { type: 'spreads', outcomes: [{ name: 'Thunder', tokenId: 'thunder' }, { name: 'Nuggets', tokenId: 'nuggets' }] };
  const record = { sides: [{ tokenId: 'thunder', price: 0.46 }, { tokenId: 'nuggets', price: 0.55 }] };
  assert.deepEqual(historyOutcomes(market, event).map(side => side.tokenId), ['nuggets', 'thunder']);
  assert.deepEqual(orderedHistorySides(record, market, event).map(side => side.price), [0.55, 0.46]);
  assert.deepEqual(orderedHistorySides({ sides: [record.sides[0]] }, market, event).map(side => side.price), [null, 0.46]);
  assert.deepEqual(market.outcomes.map(side => side.tokenId), ['thunder', 'nuggets']);
});

test('大小分即使上游小分在前，表格也按大分和小分匹配水位', () => {
  const market = { type: 'totals', outcomes: [{ name: 'Under', tokenId: 'under' }, { name: 'Over', tokenId: 'over' }] };
  const record = { sides: [{ tokenId: 'under', price: 0.91 }, { tokenId: 'over', price: 0.93 }] };
  assert.deepEqual(orderedHistorySides(record, market).map(side => side.price), [0.93, 0.91]);
});
