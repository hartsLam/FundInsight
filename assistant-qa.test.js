const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAIService } = require('../ai-service');

function fixture(t, plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-qa-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'admin-settings.json'), JSON.stringify({ enabled: true, endpoint: 'https://8.8.8.8/v1', model: 'test', apiKey: 'test-only', searchProvider: 'feed' }));
  const calls = { plan: [], answers: [], answerRules: [], kline: [], news: 0 };
  const deps = { dataDir: dir, now: () => Date.UTC(2026, 8, 20),
    getDashboard: async code => ({ fund: { code }, updatedAt: '2026-09-20', report: { date: '2026-06-30' }, holdings: [{ code: '300308', market: 0, name: '中际旭创', weight: 10, quote: { price: 123, pct: 2 } }] }),
    getKline: async (market, code, days) => {
      calls.kline.push({ market, code, days });
      return { code, market, adjustment: 'qfq', source: 'Tencent fqkline', rows: Array.from({ length: 80 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 5, i + 1)).toISOString().slice(0, 10), open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i, volume: 100
      })) };
    },
    getNews: async () => { calls.news++; return [{ title: 'Event', summary: 'Evidence', url: 'https://example.com/news' }]; },
    request: async (url, options) => {
      const body = JSON.parse(options.body);
      const system = body.messages[0].content;
      const input = JSON.parse(body.messages[1].content);
      let content;
      if (system.includes('问答取数规划器')) { calls.plan.push(input); content = typeof plan === 'string' ? plan : JSON.stringify(plan); }
      else if (system.includes('events')) content = JSON.stringify({ summary: 'News summary', events: [] });
      else { calls.answers.push(input); calls.answerRules.push(system); content = '基于日线量价证据的条件性分析 [K1]'; }
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    }
  };
  return { deps, calls, create: () => createAIService(deps) };
}

test('answers receive concise plain-language guidance without weakening evidence rules', async t => {
  const f = fixture(t, { intent: 'knowledge', stockCodes: [] });
  await f.create().ask('什么是均线？');
  const rules = f.calls.answerRules[0];
  assert.match(rules, /先用一句通俗结论/);
  assert.match(rules, /首次出现时/);
  assert.match(rules, /不另列术语词典/);
  assert.match(rules, /默认约150至300字/);
  assert.match(rules, /不能为凑字数省略关键证据/);
  assert.match(rules, /保留实际来源引用/);
  assert.equal(f.calls.kline.length, 0);
  assert.equal(f.calls.news, 0);
});

test('fund charts reach the answer with the selected range and actual intraday date', async t => {
  const f = fixture(t, { intent: 'fund', stockCodes: [], needFundHistory: true, needFundIntraday: true });
  f.deps.getFundHistory = async code => ({ code, source: 'Eastmoney', rows: [
    { date: '2026-08-01', nav: 6 }, { date: '2026-09-17', nav: 7 }, { date: '2026-09-18', nav: 7.1 }
  ] });
  f.deps.getFundIntraday = async code => ({ code, source: 'Sina', referenceDate: '2026-09-18', today: '2026-09-20', rows: [
    { time: '09:30', nav: 7.02 }, { time: '15:00', nav: 7.12 }
  ] });
  const result = await f.create().ask('分析基金盘中估值与历史走势', [], '162201', null,
    { mode: 'history', range: 'custom', start: '2026-09-01', end: '2026-09-18' });
  const input = f.calls.answers[0];
  assert.equal(input.fundSeries[0].count, 2);
  assert.equal(input.fundSeries[1].isToday, false);
  assert.equal(input.fundSeries[1].points[1].nav, 7.12);
  assert.equal(f.calls.kline.length, 0);
  assert.equal(f.calls.news, 0);
  assert.equal(result.evidence.filter(e => e.kind === 'fund-series').length, 2);
});

test('fund technical question gets complete indicators even when planner selects intraday only', async t => {
  const f = fixture(t, { intent: 'fund', stockCodes: [], needFundIntraday: true });
  f.deps.getFundHistory = async code => ({ code, rows: Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), nav: 1 + i / 100 })) });
  f.deps.getFundIntraday = async code => ({ code, rows: [], today: '2026-09-20' });
  const result = await f.create().ask('请对基金做技术分析');
  const indicators = f.calls.answers[0].fundSeries.find(x => x.id === 'F1').indicators;
  assert.equal(indicators.samples, 90);
  assert.equal(indicators.ma[5], 1.87);
  assert.ok(indicators.macd);
  assert.equal(result.evidence.find(x => x.title === '历史净值').indicators.rsi14, 100);
  assert.equal(f.calls.kline.length, 0);
});

test('missing fund data and no search credentials remain explicit', async t => {
  const f = fixture(t, { intent: 'fund', stockCodes: [], needFundIntraday: true });
  const result = await f.create().ask('基金盘中估值走势呢');
  assert.equal(f.calls.answers[0].fundSeries.length, 0);
  assert.ok(result.warnings.some(w => w.includes('未联网检索')));
});

test('assistant web searches use general scope and reuse 15-minute cache', async t => {
  const f = fixture(t, { intent: 'web', stockCodes: [], searchQueries: ['基金净值 官方说明'] });
  fs.writeFileSync(path.join(f.deps.dataDir, 'admin-settings.json'), JSON.stringify({
    enabled: true, endpoint: 'https://8.8.8.8/v1', model: 'test', apiKey: 'test-only', searchProvider: 'tavily', searchKey: 'test-search'
  }));
  let searches = 0, clock = Date.UTC(2026, 8, 20);
  f.deps.now = () => clock;
  const original = f.deps.request;
  f.deps.request = async (url, options) => {
    if (String(url).includes('tavily')) {
      searches++;
      const body = JSON.parse(options.body);
      assert.equal(body.topic, 'general'); assert.equal(body.time_range, undefined);
      return { ok: true, json: async () => ({ results: [{ title: 'Official', content: 'Verified fact', url: 'https://example.com/fund', published_date: '2026-09-18' }] }) };
    }
    return original(url, options);
  };
  const service = f.create();
  await service.ask('联网解释净值');
  const result = await service.ask('再解释一下');
  assert.equal(searches, 1);
  assert.equal(result.sources[0].id, 'W1');
  assert.equal(f.calls.answers[1].web[0].snippet, 'Verified fact');
  assert.equal(f.calls.answers[1].web[0].publishedAt, '2026-09-18');
  assert.equal(result.evidence.find(e => e.kind === 'web').cached, true);
  clock += 15 * 60 * 1000 + 1;
  await service.ask('过期之后再查');
  assert.equal(searches, 2);
});

test('technical questions fetch selected stock candles once, expose evidence and do not fetch news', async t => {
  const f = fixture(t, { intent: 'technical', stockCodes: ['300308'], needNews: false });
  const service = f.create();
  const replies = await Promise.all([service.ask('分析这只股票的K线', [], '162201', '300308'), service.ask('分析这只股票的K线', [], '162201', '300308')]);
  assert.equal(f.calls.plan.length, 1);
  assert.equal(f.calls.kline.length, 1);
  assert.equal(f.calls.news, 0);
  assert.equal(f.calls.plan[0].selectedChartStock.code, '300308');
  assert.equal(f.calls.answers[0].technical[0].ma[20], 170.5);
  assert.equal(replies[0].evidence.find(e => e.kind === 'kline').adjustment, 'qfq');
  assert.equal(replies[0].sources[0].id, 'K1');
});

test('general concepts skip market context and news even when dashboard is down', async t => {
  const f = fixture(t, { intent: 'knowledge', stockCodes: [], needNews: false });
  f.deps.getDashboard = async () => { throw Error('offline'); };
  const result = await f.create().ask('什么是RSI？');
  assert.equal(result.intent, 'knowledge');
  assert.equal(f.calls.news, 0);
  assert.equal(f.calls.kline.length, 0);
  assert.equal(f.calls.answers[0].context, null);
});

test('follow-up history reaches planner; unknown symbols and fund code cannot trigger tools', async t => {
  const f = fixture(t, { intent: 'technical', stockCodes: ['162201', '601398'], clarification: '请提供股票代码' });
  const result = await f.create().ask('它的K线呢', [{ role: 'user', content: '中际旭创' }], '162201', '601398');
  assert.equal(f.calls.plan[0].history[0].content, '中际旭创');
  assert.equal(f.calls.plan[0].selectedChartStock, null);
  assert.equal(f.calls.kline.length, 0);
  assert.ok(result.warnings.length);
});

test('malformed plan recovers conservatively and failed Kline does not fabricate indicators', async t => {
  const f = fixture(t, 'not JSON');
  f.deps.getKline = async () => { throw Error('offline'); };
  const result = await f.create().ask('分析300308的K线');
  assert.equal(f.calls.answers[0].technical.length, 0);
  assert.equal(f.calls.news, 0);
  assert.ok(result.warnings.some(w => w.includes('K线获取')));
  assert.ok(result.answer);
});

test('news questions retain the existing research cache and pipeline', async t => {
  const f = fixture(t, { intent: 'news', stockCodes: [], needNews: true });
  const service = f.create();
  await service.ask('新闻影响是什么');
  await service.ask('继续解释新闻影响');
  assert.equal(f.calls.news, 1);
  assert.equal(f.calls.kline.length, 0);
  assert.ok(f.calls.answers[0].news);
});

test('truncated planner falls back once without retrying a partial plan', async t => {
  const f = fixture(t, '');
  const original = f.deps.request;
  let plans = 0;
  f.deps.request = async (url, options) => {
    if (JSON.parse(options.body).messages[0].content.includes('问答取数规划器')) {
      plans++;
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }) };
    }
    return original(url, options);
  };
  await f.create().ask('分析300308的K线');
  assert.equal(plans, 1);
  assert.equal(f.calls.kline.length, 1);
  assert.equal(f.calls.answers.length, 1);
});

function webFixture(t, plan, draft, searchRows = [{ title: 'Fund announcement', content: 'Verified fund facts', url: 'https://example.com/official' }]) {
  const f = fixture(t, plan);
  fs.writeFileSync(path.join(f.deps.dataDir, 'admin-settings.json'), JSON.stringify({ enabled: true,
    endpoint: 'https://8.8.8.8/v1', model: 'test', apiKey: 'test-only', searchProvider: 'tavily', searchKey: 'test-search' }));
  const old = f.deps.request;
  f.searches = [];
  f.deps.request = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes('tavily')) {
      f.searches.push(body.query);
      if (searchRows === null) throw Error('offline');
      return { ok: true, json: async () => ({ results: searchRows }) };
    }
    if (body.messages[0].content.includes('问答取数规划器')) return old(url, options);
    const input = JSON.parse(body.messages[1].content);
    f.calls.answers.push(input);
    const content = typeof draft === 'function' ? draft(input) : draft;
    return { ok: true, json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }) };
  };
  return f;
}

test('answer-discovered gaps search before returning a final response and use cached evidence', async t => {
  const f = webFixture(t, { intent: 'holdings', stockCodes: [] }, input => input.finalPass
    ? { answer: '根据公告补充分析 [W1]', followUps: ['公告中费用何时生效？'], searchQueries: ['不应继续检索'] }
    : { answer: '需要核实费率。', followUps: [], searchQueries: ['162201 最新费率 官方公告'] });
  const service = f.create();
  const first = await service.ask('最近费率有变化吗？');
  assert.equal(f.searches.length, 1);
  assert.equal(f.calls.answers.length, 2);
  assert.equal(first.answer, '根据公告补充分析 [W1]');
  assert.deepEqual(first.followUps, ['公告中费用何时生效？']);
  assert.equal(f.calls.answers[1].web[0].snippet, 'Verified fund facts');
  assert.equal(first.searchState.status, 'found');
  await service.ask('费用还有变化吗？');
  assert.equal(f.searches.length, 1);
});

test('partial fund tool failure triggers search even when another series succeeded', async t => {
  const f = webFixture(t, { intent: 'fund', stockCodes: [], needFundHistory: true, needFundIntraday: true },
    { answer: '已有历史净值可分析，盘中数据仍未核实。', followUps: [], searchQueries: [] });
  f.deps.getFundHistory = async code => ({ code, rows: [{ date: '2026-09-18', nav: 1 }] });
  f.deps.getFundIntraday = async () => { throw Error('offline'); };
  await f.create().ask('比较历史和盘中走势');
  assert.equal(f.searches.length, 1);
  assert.equal(f.calls.answers[0].fundSeries.length, 1);
  assert.equal(f.calls.answers[0].web.length, 1);
});

test('failed stock tool searches before answer rather than stopping at missing candles', async t => {
  const f = webFixture(t, { intent: 'technical', stockCodes: ['300308'] },
    { answer: '检索所得公告可以补充背景，不冒充K线。', followUps: [], searchQueries: [] });
  f.deps.getKline = async () => { throw Error('offline'); };
  await f.create().ask('分析300308的K线');
  assert.equal(f.searches.length, 1);
  assert.equal(f.calls.answers[0].technical.length, 0);
  assert.equal(f.calls.answers[0].searchState.status, 'found');
});

test('search empty results and failures are distinguished and bounded', async t => {
  for (const [rows, status] of [[[], 'empty'], [null, 'failed']]) {
    const f = webFixture(t, { intent: 'holdings', stockCodes: [] }, input => input.finalPass
      ? { answer: `核实状态：${input.searchState.status}`, followUps: [], searchQueries: ['第三轮禁止'] }
      : { answer: '需要补查。', followUps: [], searchQueries: ['基金官方公告'] }, rows);
    const result = await f.create().ask('基金最近有分红吗？');
    assert.equal(result.searchState.status, status);
    assert.equal(result.answer, `核实状态：${status}`);
    assert.equal(f.searches.length, 1);
    assert.equal(f.calls.answers.length, 2);
  }
});

test('model follow-ups change with context and exclude repeated user questions', async t => {
  const f = webFixture(t, { intent: 'knowledge', stockCodes: [] }, input => ({
    answer: '简明解释', searchQueries: [], followUps: [input.question, input.question.includes('费用') ? '持有一年费用如何算？' : '波动大意味着什么？']
  }));
  const service = f.create();
  assert.deepEqual((await service.ask('费用怎么算？')).followUps, ['持有一年费用如何算？']);
  assert.deepEqual((await service.ask('风险怎么看？', [{ role: 'user', content: '费用怎么算？' }])).followUps, ['波动大意味着什么？']);
  assert.equal(f.searches.length, 0);
});

test('legacy plain-text refusal also gets a search recovery', async t => {
  const f = webFixture(t, { intent: 'holdings', stockCodes: [] }, input => input.finalPass ? '已有补充资料 [W1]' : '信息不足，无法判断。');
  const result = await f.create().ask('该基金管理人最近的变更是什么？');
  assert.equal(f.searches.length, 1);
  assert.equal(result.answer, '已有补充资料 [W1]');
});
