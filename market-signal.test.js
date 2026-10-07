const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quoteTime, isQuoteFresh, quotesWithFallback, shortTermSignal } = require('../market-signal');
const now = Date.parse('2026-09-24T10:30:00+08:00');
const stamp = quoteTime('20260924102800');
const stocks = percentages => percentages.map((pct, i) => ({ code: String(300001 + i), market: 0, weight: 10, quote: { pct, quoteTime: stamp, quoteSource: 'eastmoney' } }));

test('quote timestamps parse real provider formats and reject invalid times', () => {
  assert.equal(stamp, '2026-09-24T02:28:00.000Z');
  assert.equal(quoteTime(Date.parse(stamp) / 1000), stamp);
  assert.equal(quoteTime('2026-09-24 10:28'), stamp);
  for (const value of [null, '-', '', '2026-09-24', 1e99]) assert.equal(quoteTime(value), null);
  assert.equal(isQuoteFresh(stamp, now), true);
  assert.equal(isQuoteFresh('2026-09-24 10:00:00', now), false);
  assert.equal(isQuoteFresh('2026-09-23 15:00:00', now), false);
  assert.equal(isQuoteFresh('2026-09-24 11:00:00', now), false);
});

test('freshness respects lunch, closing time, weekends and pre-open sessions', () => {
  assert.equal(isQuoteFresh('2026-09-24 11:30:00', Date.parse('2026-09-24T12:40:00+08:00')), true);
  assert.equal(isQuoteFresh('2026-09-24 11:30:00', Date.parse('2026-09-24T13:20:00+08:00')), false);
  assert.equal(isQuoteFresh('2026-09-24 15:00:00', Date.parse('2026-09-24T23:00:00+08:00')), true);
  assert.equal(isQuoteFresh('2026-09-24 15:00:00', Date.parse('2026-09-27T12:00:00+08:00')), true);
  assert.equal(isQuoteFresh('2026-09-24 15:00:00', Date.parse('2026-09-28T08:30:00+08:00')), true);
  assert.equal(isQuoteFresh('2026-09-25 15:00:00', Date.parse('2026-09-28T08:30:00+08:00')), false);
});

test('missing boards use explicitly labeled holdings reference, not fabricated board momentum', () => {
  for (const [pcts, expected] of [[[2, 1, 3], '偏强'], [[-2, -1, -3], '承压'], [[2, -2, 0], '分化']]) {
    const signal = shortTermSignal(stocks(pcts), [], null, now);
    assert.equal(signal.stance, expected);
    assert.equal(signal.basis, 'holdings');
    assert.equal(signal.label, '持仓参考');
    assert.equal(signal.quoteCoverage, 100);
    assert.equal(signal.boardMomentum, null);
    assert.match(signal.reason, /缺少板块验证/);
  }
});

test('combined judgment requires fresh boards; stale estimates cannot override current holdings', () => {
  const holdings = stocks([5, 5, 5]);
  const board = { weight: 30, pct: 4, quoteTime: stamp };
  const signal = shortTermSignal(holdings, [board], { gszzl: -10, gztime: '2026-09-23 15:00:00' }, now);
  assert.equal(signal.basis, 'combined');
  assert.equal(signal.stance, '偏强');
  assert.equal(shortTermSignal(holdings, [{ ...board, quoteTime: null }], null, now).basis, 'holdings');
});

test('insufficient, missing, stale quotes cannot become a bullish or neutral state', () => {
  const holdings = stocks([1, 2, 3, 4]);
  holdings[0].quote.quoteTime = null;
  holdings[1].quote.quoteTime = '2026-09-23T07:00:00.000Z';
  const signal = shortTermSignal(holdings, [], null, now);
  assert.equal(signal.stance, '数据不足');
  assert.equal(signal.quoteCoverage, 50);
  assert.equal(signal.validQuoteCount, 2);
  assert.equal(signal.quoteContribution, 0.7);
  assert.equal(shortTermSignal([], [], null, now).stance, '数据不足');
  const absent = shortTermSignal(stocks([null, NaN, undefined]), [], null, now);
  assert.equal(absent.quoteContribution, null);
  assert.equal(absent.breadth, null);
});

test('coverage uses weights rather than stock counts and breadth needs directional agreement', () => {
  const holdings = stocks([10, -1, -1]);
  assert.equal(shortTermSignal(holdings, [], null, now).stance, '分化');
  holdings[0].weight = 80; holdings[0].quote.quoteTime = null;
  assert.equal(shortTermSignal(holdings, [], null, now).quoteCoverage, 20);
});

test('quote failover fills partial responses and replaces stale data, keeping fresh primary quotes', async () => {
  const holdings = stocks([1, 2, 3]);
  const primary = holdings.slice(0, 2).map(item => ({ code: item.code, market: item.market, ...item.quote }));
  primary[1].quoteTime = null;
  const backup = holdings.map(item => ({ code: item.code, market: item.market, ...item.quote, quoteSource: 'tencent' }));
  const result = await quotesWithFallback(holdings, async () => primary, async () => backup, now);
  assert.deepEqual(result.map(row => row.quoteSource), ['eastmoney', 'tencent', 'tencent']);
  let extra = 0;
  await quotesWithFallback(holdings, async () => backup, async () => { extra++; return []; }, now);
  assert.equal(extra, 0);
  const failure = async () => { throw Error('offline'); };
  assert.equal((await quotesWithFallback(holdings, failure, async () => backup, now)).length, 3);
  assert.equal((await quotesWithFallback(holdings, async () => primary, failure, now)).length, 2);
  assert.deepEqual(await quotesWithFallback(holdings, failure, failure, now), []);
});
