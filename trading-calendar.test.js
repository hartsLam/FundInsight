const { test } = require('node:test');
const assert = require('node:assert/strict');
const { marketSession, isTradingDate } = require('../trading-calendar');
const { isQuoteFresh, shortTermSignal, quotesWithFallback } = require('../market-signal');
const { parseSinaStockQuotes, fetchSinaStockQuotes } = require('../sina-stock-quotes');
const time = value => Date.parse(value + '+08:00');

test('exchange calendar accepts last closing quotes throughout official holidays', () => {
  for (const [date, previous] of [['2026-09-25','2026-09-24'],['2026-10-07','2026-09-30'],['2026-02-23','2026-02-13'],['2026-01-01','2025-12-31']]) {
    const now = time(`${date}T17:00:00`);
    assert.equal(marketSession(now).referenceDate, previous);
    assert.equal(marketSession(now).phase, 'closed');
    assert.equal(isQuoteFresh(`${previous} 15:00:00`, now), true);
    assert.equal(isQuoteFresh(`${previous} 10:00:00`, now), false);
    assert.equal(isQuoteFresh(`${date} 15:00:00`, now), false);
  }
  assert.equal(isTradingDate('2026-09-20'), false);
  assert.equal(isTradingDate('2026-10-10'), false);
});

test('reopening cannot reuse holiday closing prices as live prices', () => {
  assert.equal(isQuoteFresh('2026-09-24 15:00:00', time('2026-09-28T09:29:00')), true);
  assert.equal(isQuoteFresh('2026-09-24 15:00:00', time('2026-09-28T09:31:00')), false);
  assert.equal(isQuoteFresh('2026-09-28 09:30:00', time('2026-09-28T09:31:00')), true);
  assert.equal(marketSession(time('2027-09-25T10:00:00')).known, false);
  assert.equal(isQuoteFresh('2027-09-25 10:00:00', time('2027-09-25T10:01:00')), false);
});

test('holiday signal is an explicit dated close reference, not missing data or a live prediction', () => {
  const holdings = [1,2,3].map(i => ({ code: `30000${i}`, market: 0, weight: 10, quote: { pct: -2, quoteTime: '2026-09-24T07:00:00.000Z', quoteSource: 'sina' } }));
  const signal = shortTermSignal(holdings, [], null, time('2026-09-25T17:00:00'));
  assert.equal(signal.stance, '承压');
  assert.equal(signal.quoteCoverage, 100);
  assert.match(signal.reason, /休市.*2026-09-24/);
  assert.equal(signal.session.closingReference, true);
});

const holding = { code: '300308', market: 0, name: 'test' };
function sinaLine(symbol = 'sz300308', price = '895.86') {
  const fields = Array(33).fill('0');
  Object.assign(fields, { 0: 'test', 1: '918.51', 2: '922.50', 3: price, 8: '18486628', 9: '16868775637.99', 30: '2026-09-24', 31: '16:29:45' });
  return `var hq_str_${symbol}="${fields.join(',')}";`;
}

test('Sina parser binds requested symbols, retains source time and computes daily percentage', () => {
  const [row] = parseSinaStockQuotes(sinaLine() + sinaLine('sh600000'), [holding]);
  assert.equal(row.quoteSource, 'sina');
  assert.equal(row.quoteTime, '2026-09-24T08:29:45.000Z');
  assert.equal(row.pct, -2.89);
  assert.equal(row.volume, 184866.28);
  assert.equal(parseSinaStockQuotes(sinaLine('sz300308', '0'), [holding]).length, 0);
  assert.equal(parseSinaStockQuotes('var hq_str_sz300308="";', [holding]).length, 0);
});

test('Sina loader sends source Referer and rejects empty responses', async () => {
  const rows = await fetchSinaStockQuotes([holding], async (url, options) => {
    assert.match(url, /list=sz300308/);
    assert.equal(options.headers.Referer, 'https://finance.sina.com.cn/');
    return Buffer.from(sinaLine());
  });
  assert.equal(rows.length, 1);
  await assert.rejects(fetchSinaStockQuotes([holding], async () => Buffer.from('')), /未返回/);
});

test('third provider fills failures only, without repeated requests when primary is valid', async () => {
  let calls = 0;
  const third = async () => { calls++; return parseSinaStockQuotes(sinaLine(), [holding]); };
  const unavailable = async () => { throw Error('offline'); };
  const now = time('2026-09-25T17:00:00');
  const result = await quotesWithFallback([holding], unavailable, unavailable, now, [third]);
  assert.equal(result[0].quoteSource, 'sina');
  assert.equal(calls, 1);
  await quotesWithFallback([holding], async () => result, unavailable, now, [third]);
  assert.equal(calls, 1);
});
