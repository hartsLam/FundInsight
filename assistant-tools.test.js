const { test } = require('node:test');
const assert = require('node:assert/strict');
const { technicalSnapshot, permittedStocks, normalizePlan, fallbackPlan } = require('../assistant-tools');

const stock = { code: '300308', market: 0, name: '中际旭创' };
function series(n = 80) {
  return { ...stock, adjustment: 'qfq', source: 'test', rows: Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), open: i + 10, close: i + 10, high: i + 11, low: i + 9, volume: i === n - 1 ? 200 : 100
  })) };
}

test('technical indicators have reproducible values and explicitly stated conventions', () => {
  const result = technicalSnapshot(series(), stock, Date.UTC(2026, 2, 21));
  assert.equal(result.ma[5], 87);
  assert.equal(result.ma[20], 79.5);
  assert.equal(result.rsi14, 100);
  assert.equal(result.volumeVsPrevious5, 2);
  assert.deepEqual(result.previous20Range, { low: 68, high: 89 });
  assert.equal(result.macd.dif, 7);
  assert.equal(result.macd.dea, 7);
  assert.equal(result.macd.histogram, 0);
  assert.equal(result.boll20.middle, 79.5);
  assert.equal(result.recentBars.length, 20);
});

test('short, missing, unadjusted and stale samples are never fabricated', () => {
  const data = series(4);
  data.adjustment = 'none';
  data.rows.at(-1).volume = null;
  const result = technicalSnapshot(data, stock, Date.UTC(2026, 8, 20));
  assert.equal(result.ma[5], null);
  assert.equal(result.rsi14, null);
  assert.equal(result.macd, null);
  assert.equal(result.volumeVsPrevious5, null);
  assert.equal(result.previous20Range, null);
  assert.equal(result.changePct[5], null);
  assert.equal(result.warnings.length, 3);
});

test('rejects wrong security, invalid prices and unordered or duplicate candles', () => {
  assert.throws(() => technicalSnapshot({ ...series(), code: '600519' }, stock), /标识/);
  for (const mutate of [d => { d.rows[1].close = null; }, d => { d.rows[1].high = 1; }, d => { d.rows[1].date = d.rows[0].date; }]) {
    const d = series(); mutate(d); assert.throws(() => technicalSnapshot(d, stock), /异常/);
  }
});

test('plans limit tools to holdings and user-specified codes; no fund or arbitrary URL access', () => {
  const stocks = permittedStocks('比较600519和300308，不是162201', [{ role: 'assistant', content: '601398' }], [stock], '162201');
  assert.equal(stocks.has('600519'), true);
  assert.equal(stocks.has('601398'), false);
  assert.equal(stocks.has('162201'), false);
  const plan = normalizePlan({ intent: 'technical', stockCodes: ['300308', '600519', '601398', 'https://127.0.0.1', '162201'], needNews: false }, stocks, '162201');
  assert.deepEqual(plan.stockCodes, ['300308', '600519']);
  assert.equal(plan.rejectedTargets.length, 3);
  assert.equal(fallbackPlan('中际旭创的MACD如何', stocks).stockCodes[0], '300308');
  assert.throws(() => normalizePlan({ intent: 'unknown', stockCodes: [] }, stocks, '162201'));
  const knowledge = normalizePlan({ intent: 'knowledge', stockCodes: ['300308'], needNews: true }, stocks, '162201');
  assert.deepEqual(knowledge.stockCodes, []);
  assert.equal(knowledge.needNews, false);
});
