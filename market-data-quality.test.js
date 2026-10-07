const { test } = require('node:test');
const assert = require('node:assert/strict');
const { holdingsRequest, probeSource } = require('../market-sources');
const { loadIndustryBoards, boardSignal } = require('../industry-boards');
const { flagIntradayJumps, parseIntraday } = require('../fund-intraday');
const { intradayEvidence } = require('../fund-evidence');

test('holdings probe uses the same request headers and URL as the real loader', async () => {
  const request = holdingsRequest('006228', '', 123);
  assert.equal(new URL(request.url).searchParams.get('code'), '006228');
  assert.equal(request.options.headers.Referer, 'https://fundf10.eastmoney.com/');
  let actual;
  const result = await probeSource(async (...args) => { actual = args; return 'holdings'; }, 'fund-holdings', request.url, value => value.length, request.options);
  assert.equal(result.ok, true);
  assert.deepEqual(actual, [request.url, request.options, 8000]);
  const invalid = await probeSource(async () => 'captcha', 'fund-holdings', request.url, () => { throw Error('invalid holdings'); }, request.options);
  assert.equal(invalid.ok, false);
});

const stock = (code, weight, industry, industryPath = [], marketIndustry) => ({ code, market: 0, weight, quote: { industry, industryPath, marketIndustry } });
const cached = async (key, ttl, fn) => fn();
const catalog = [{ f12: 'BK0448', f14: '通信设备', f3: 3 }, { f12: 'BK0459', f14: '元件', f3: -2 }];

test('board lookup paginates, joins authoritative quote names, and deduplicates weights', async () => {
  const pages = [];
  const holdings = [stock('300308', 10, '通信传输设备'), stock('300502', 8, '通信传输设备'), stock('000636', 5, '电子元件')];
  const boards = await loadIndustryBoards(holdings, { cached, fetchJson: async input => {
    const url = new URL(input);
    if (url.pathname.includes('clist')) { const page = Number(url.searchParams.get('pn')); pages.push(page); return { data: { total: 2, diff: [catalog[page - 1]] } }; }
    return { data: { f127: url.searchParams.get('secid') === '0.000636' ? '元件' : '通信设备' } };
  } });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(boards.length, 2);
  assert.equal(boards[0].weight, 18);
  assert.deepEqual(boards[0].industries, ['通信传输设备']);
  assert.equal(boards[1].weight, 5);
  assert.equal(boardSignal(holdings, boards, 2).boardCoverage, 100);
});

test('industry hierarchy fallback uses only actual ancestor names, never guessed aliases', async () => {
  const boards = await loadIndustryBoards([stock('300308', 10, '通信传输设备', ['信息技术', '通信设备', '通信传输设备']), stock('000001', 5, '不在目录内')], {
    cached, fetchJson: async url => { if (!url.includes('clist')) throw Error('offline'); return { data: { total: 2, diff: catalog } }; }
  });
  assert.equal(boards.length, 1);
  assert.equal(boards[0].name, '通信设备');
  assert.equal(boards[0].weight, 10);
  assert.deepEqual(boards[0].matchMethods, ['EM2016-hierarchy']);
});

test('incomplete or repeated board pages fail rather than silently reporting full data', async () => {
  await assert.rejects(loadIndustryBoards([stock('300308', 10, '通信设备')], { cached, fetchJson: async () => ({ data: { total: 3, diff: catalog } }) }), /分页重复/);
});

test('transient catalog network failure retries only once per page', async () => {
  let calls = 0;
  const hosts = [];
  const holdings = [stock('300308', 10, '通信设备', [], '通信设备')];
  const boards = await loadIndustryBoards(holdings, { cached, fetchJson: async url => { hosts.push(new URL(url).hostname); if (++calls === 1) throw Error('network'); return { data: { total: 2, diff: catalog } }; } });
  assert.equal(calls, 2);
  assert.deepEqual(hosts, ['push2.eastmoney.com', '82.push2.eastmoney.com']);
  assert.equal(boards.length, 1);
  calls = 0;
  await assert.rejects(loadIndustryBoards(holdings, { cached, fetchJson: async () => { calls++; throw Error('offline'); } }), /offline/);
  assert.equal(calls, 2);
});

test('unavailable board quotes stay null and cannot manufacture a neutral stance', async () => {
  const holdings = [stock('300308', 60, '通信设备', [], '通信设备')];
  const boards = await loadIndustryBoards(holdings, { cached, fetchJson: async () => ({ data: { total: 1, diff: [{ ...catalog[0], f3: '-' }] } }) });
  assert.equal(boards[0].pct, null);
  assert.equal(boardSignal(holdings, boards, 2).stance, '数据不足');
  assert.equal(boardSignal(holdings, [], 2).boardMomentum, null);
  assert.equal(boardSignal(holdings, [{ weight: 60, pct: 3 }], 2).stance, '偏强');
  assert.equal(boardSignal(holdings, [{ weight: 60, pct: -3 }], -2).stance, '承压');
  assert.equal(boardSignal(holdings, [{ weight: 10, pct: 10 }], 2).stance, '数据不足');
  assert.equal(boardSignal(holdings, [{ weight: 60, pct: 0 }], 0).stance, '中性观察');
  assert.equal(boardSignal(holdings, [{ weight: 60, pct: 3 }], null).stance, '数据不足');
});

const series = values => values.map((nav, i) => ({ time: `10:${String(i * 3).padStart(2, '0')}`, nav }));

test('isolated sharp reversal is flagged without replacing, deleting or interpolating values', () => {
  const rows = series([1.787, 1.786, 1.788, 1.762, 1.787, 1.788, 1.787]);
  const result = flagIntradayJumps(rows);
  assert.equal(result.length, rows.length);
  assert.deepEqual(result.map(row => row.nav), rows.map(row => row.nav));
  assert.deepEqual(result.filter(row => row.quality).map(row => row.time), ['10:09']);
  assert.equal(rows[3].quality, undefined);
  const evidence = intradayEvidence({ rows: result });
  assert.equal(evidence.rawCount, 7);
  assert.equal(evidence.count, 6);
  assert.equal(evidence.low.nav, 1.786);
  assert.equal(evidence.suspectPoints[0].nav, 1.762);
});

test('persistent moves, normal noise, isolated endpoints and lunch gaps are not hidden', () => {
  for (const values of [[1.78, 1.78, 1.78, 1.76, 1.76, 1.76, 1.76], [1.78, 1.781, 1.779, 1.777, 1.78, 1.781, 1.78], [1.7, 1.78, 1.78, 1.78, 1.78, 1.78, 1.7]]) {
    assert.equal(flagIntradayJumps(series(values)).filter(row => row.quality).length, 0);
  }
  const lunch = series([1.78, 1.78, 1.78, 1.76, 1.78, 1.78, 1.78]);
  lunch.forEach((row, i) => { row.time = ['11:21', '11:24', '11:27', '11:30', '13:01', '13:04', '13:07'][i]; });
  assert.equal(flagIntradayJumps(lunch).filter(row => row.quality).length, 0);
});

test('intraday parser preserves raw series for date fingerprint while carrying quality flags', () => {
  const rows = series([1.787, 1.786, 1.788, 1.762, 1.787, 1.788, 1.787]);
  const data = parseIntraday({ result: { status: { code: 0 }, data: { detail: rows.flatMap(row => [row.time, row.nav]).join(',') } } }, null);
  assert.equal(data.quality.suspectCount, 1);
  assert.equal(data.rows[3].nav, 1.762);
  assert.equal(data.referenceDate, null);
});
