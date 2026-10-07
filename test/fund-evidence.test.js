const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chartContext, historyEvidence, intradayEvidence } = require('../fund-evidence');
test('fund indicators use full warmup history and exclude future NAV', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), nav: i + 1 }));
  const end = rows[79].date;
  const result = historyEvidence({ rows }, chartContext({ range: 'custom', start: rows[75].date, end }));
  assert.equal(result.count, 5);
  assert.equal(result.indicators.samples, 80);
  assert.equal(result.indicators.asOf, end);
  assert.equal(result.indicators.ma[5], 78);
  assert.equal(result.indicators.ma[60], 50.5);
  assert.equal(result.indicators.rsi14, 100);
  assert.equal(result.indicators.macd.dif, 7);
  assert.equal(result.indicators.boll20.middle, 70.5);
});

test('chart context rejects invalid dates and defaults to intraday', () => {
  assert.deepEqual(chartContext({ start: '2026-02-30', end: '2026-03-01', range: 'invalid' }),
    { mode: 'intraday', range: '1y', start: null, end: null });
});
test('history sampling preserves full-range extrema and endpoints', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ date: new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10), nav: i === 3 ? 99 : 1 + i / 1000 }));
  const result = historyEvidence({ code: '162201', rows }, chartContext({ range: 'all' }));
  assert.equal(result.count, 1000); assert.equal(result.points.length, 240);
  assert.equal(result.high.nav, 99); assert.equal(result.last, rows.at(-1));
  assert.equal(result.points[0], rows[0]); assert.equal(result.points.at(-1), rows.at(-1));
});
test('unknown intraday dates and empty ranges never imply current data', () => {
  assert.equal(intradayEvidence({ rows: [], referenceDate: null, today: '2026-09-21' }).isToday, false);
  assert.equal(historyEvidence({ rows: [] }, chartContext()).navChangePct, null);
});
