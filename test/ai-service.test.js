const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { TimedCache, createAIService, publicIp } = require('../ai-service');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-ai-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cache coalesces, persists, expires at 15 minutes, and retries failures', async (t) => {
  const file = path.join(temp(t), 'cache.json');
  let now = 1000, calls = 0;
  const cache = new TimedCache(file, () => now);
  const loader = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { n: calls }; };
  await Promise.all(Array.from({ length: 8 }, () => cache.get('news', loader)));
  assert.equal(calls, 1);
  const restored = new TimedCache(file, () => now);
  now += 899999;
  assert.equal((await restored.get('news', loader)).cached, true);
  now++;
  await restored.get('news', loader);
  assert.equal(calls, 2);
  await assert.rejects(cache.get('bad', async () => { throw Error('offline'); }));
  assert.equal((await cache.get('bad', async () => 7)).value, 7);
});

function fixture(t, search = false, brokenNews = false) {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'admin-password.txt'), 'test-admin-only');
  fs.writeFileSync(path.join(dir, 'admin-settings.json'), JSON.stringify({ enabled: true, endpoint: 'https://8.8.8.8/v1', model: 'test', apiKey: 'secret-test-key', searchKey: search ? 'search-test-key' : '' }));
  let now = 1000000;
  const counts = { ai: 0, feed: 0, search: 0 };
  const deps = { dataDir: dir, now: () => now,
    getDashboard: async () => ({ fund: { code: '162201' }, updatedAt: '2026-09-19', holdings: [{ code: '000001', weight: 5, quote: { pct: 2 } }], indexes: [] }),
    getNews: async () => { counts.feed++; if (brokenNews) throw Error('offline'); return [{ title: 'Market event', url: 'https://example.com/news', summary: 'Evidence' }]; },
    request: async (url, options) => {
      if (url.includes('tavily')) { counts.search++; return { ok: true, json: async () => ({ results: [{ title: 'Event', url: 'https://example.com/news', content: 'Evidence' }] }) }; }
      counts.ai++;
      const prompt = JSON.parse(options.body).messages[0].content;
      if (prompt.includes('问答取数规划器')) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ intent: 'holdings', stockCodes: [], needNews: false }) } }] }) };
      const content = prompt.includes('queries') ? JSON.stringify({ queries: ['macro policy'] }) : prompt.includes('events') ? JSON.stringify({ summary: 'Summary', events: [{ title: 'Valid', impact: 'Possible', sourceIds: ['N1', 'N99'] }, { title: 'Invalid', impact: 'No evidence', sourceIds: ['N99'] }] }) : 'Answer [N1]';
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    }
  };
  return { service: createAIService(deps), deps, counts, advance: () => { now += 900000; } };
}

test('research shares news and interpretation across requests and restart', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.service.research()));
  assert.equal(f.counts.feed, 1);
  assert.equal(f.counts.ai, 1);
  assert.deepEqual(results[0].events[0].sourceIds, ['N1']);
  assert.equal(results[0].events.length, 1);
  assert.equal((await createAIService(f.deps).research()).cached, true);
  await f.service.ask('Explain holdings');
  assert.equal(f.counts.ai, 3);
  assert.equal(f.counts.feed, 1);
  f.advance();
  await f.service.research();
  assert.equal(f.counts.feed, 2);
  assert.equal(f.counts.ai, 4);
});

test('AI plans real search once within cache TTL', async t => {
  const f = fixture(t, true);
  await f.service.research();
  await f.service.research();
  assert.deepEqual(f.counts, { ai: 2, feed: 0, search: 1 });
});

test('fund Q&A remains available when news is unavailable', async t => {
  const f = fixture(t, false, true);
  const answer = await f.service.ask('Explain holdings');
  assert.deepEqual(answer.sources, []);
  assert.equal(f.counts.ai, 2);
  assert.equal(f.counts.feed, 0);
});

async function route(service, pathname, method = 'GET', payload = {}, cookie = '', authorized = true, headers = {}) {
  const req = Readable.from([JSON.stringify(payload)]);
  Object.assign(req, { method, headers: { host: 'localhost', cookie, ...headers }, socket: { remoteAddress: 'test-ip' } });
  const output = { headers: {} };
  await service.handle(req, { setHeader: (key, value) => output.headers[key] = value }, new URL(pathname, 'http://localhost'), authorized, (_, status, body) => Object.assign(output, { status, body }));
  return output;
}

test('origin checks normalize default ports and protect login and research behind proxies', async t => {
  const f = fixture(t);
  const local = createAIService({ ...f.deps, publicOrigin: '' });
  const proxy = createAIService({ ...f.deps, publicOrigin: 'https://example.com' });
  for (const pathname of ['/api/admin/login', '/api/ai/research']) {
    const call = (service, headers) => route(service, pathname, 'POST', { password: 'test-admin-only' }, '', true, headers);
    assert.equal((await call(local, { origin: 'https://example.com', host: 'example.com:443' })).status, 200);
    assert.equal((await call(local, { origin: 'http://localhost:3210', host: 'localhost:3210' })).status, 200);
    assert.equal((await call(local, { origin: 'http://localhost:3211', host: 'localhost:3210' })).status, 403);
    assert.equal((await call(proxy, { origin: 'https://example.com', host: '127.0.0.1:3210' })).status, 200);
    for (const origin of ['https://evil.example', 'https://example.com.evil.example', 'http://example.com', 'https://example.com:444', 'null', 'invalid', 'https://example.com/path']) {
      assert.equal((await call(proxy, { origin, host: 'example.com', 'x-forwarded-host': 'example.com' })).status, 403);
    }
    assert.equal((await call(local, { origin: 'https://evil.example', host: 'localhost', 'x-forwarded-host': 'evil.example' })).status, 403);
  }
  assert.throws(() => createAIService({ ...f.deps, publicOrigin: 'https://example.com/path' }), /PUBLIC_ORIGIN/);
});

test('admin authorization, secret masking, source change and API auth', async t => {
  const { service } = fixture(t);
  assert.equal((await route(service, '/api/admin/settings')).status, 401);
  const bad = await route(service, '/api/admin/login', 'POST', { password: 'wrong' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, '验证失败。');
  const login = await route(service, '/api/admin/login', 'POST', { password: 'test-admin-only' });
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  const settings = await route(service, '/api/admin/settings', 'GET', {}, cookie);
  assert.equal(settings.body.hasApiKey, true);
  assert.equal(JSON.stringify(settings.body).includes('secret-test-key'), false);
  const saved = await route(service, '/api/admin/settings', 'POST', { marketSource: 'tencent', enabled: true, endpoint: 'https://8.8.8.8/v1', model: 'test' }, cookie);
  assert.equal(saved.status, 200);
  assert.equal(service.marketSource(), 'tencent');
  assert.equal(saved.body.hasApiKey, true);
  const unsafe = await route(service, '/api/admin/settings', 'POST', { marketSource: 'tencent', endpoint: 'https://127.0.0.1' }, cookie);
  assert.equal(unsafe.status, 400);
  assert.equal((await route(service, '/api/ai/status', 'GET', {}, '', false)).status, 401);
});

test('private endpoints are rejected', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1']) assert.equal(publicIp(ip), false);
  assert.equal(publicIp('8.8.8.8'), true);
});

test('research and Q&A bind to selected fund while sharing only raw news', async t => {
  const f = fixture(t);
  const seen = [];
  const original = f.deps.request;
  f.deps.getDashboard = async code => ({ fund: { code, name: code }, updatedAt: '2026-09-20', holdings: [] });
  f.deps.request = async (url, options) => { seen.push(JSON.parse(JSON.parse(options.body).messages[1].content)); return original(url, options); };
  const service = createAIService(f.deps);
  const first = await service.research('162201');
  const second = await service.research('161725');
  assert.equal(first.fundCode, '162201'); assert.equal(second.fundCode, '161725');
  assert.equal(f.counts.feed, 1); assert.equal(f.counts.ai, 2);
  assert.equal((await service.research('162201')).cached, true);
  const answer = await service.ask('Explain', [], '161725');
  assert.equal(answer.fundCode, '161725');
  assert.equal(seen.at(-1).context.fund.code, '161725');
  assert.equal(f.counts.ai, 4);
});

test('front fund management requires site auth and origin but not admin; settings stay protected', async t => {
  const f = fixture(t);
  const { createFundRegistry } = require('../fund-registry');
  f.deps.fundRegistry = createFundRegistry({ dataDir: f.deps.dataDir, lookup: async code => ({ name: code }) });
  const service = createAIService(f.deps);
  assert.equal((await route(service, '/api/ai/funds', 'GET', {}, '', false)).status, 401);
  assert.equal((await route(service, '/api/ai/funds', 'POST', { action: 'add', code: '161725' }, '', false)).status, 401);
  assert.equal((await route(service, '/api/ai/funds', 'POST', { action: 'add', code: '161725' }, '', true, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await route(service, '/api/ai/funds', 'POST', { action: 'add', code: '161725' })).status, 200);
  assert.equal((await route(service, '/api/ai/funds')).body.funds.length, 2);
  assert.equal((await route(service, '/api/admin/settings')).status, 401);
});

test('fund administration uses admin auth and unknown fund AI requests are rejected', async t => {
  const f = fixture(t);
  const { createFundRegistry } = require('../fund-registry');
  f.deps.fundRegistry = createFundRegistry({ dataDir: f.deps.dataDir, lookup: async code => ({ name: code }) });
  const service = createAIService(f.deps);
  assert.equal((await route(service, '/api/admin/funds')).status, 401);
  const login = await route(service, '/api/admin/login', 'POST', { password: 'test-admin-only' });
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  assert.equal((await route(service, '/api/admin/funds', 'POST', { action: 'add', code: '161725' }, cookie)).status, 200);
  assert.equal((await route(service, '/api/admin/funds', 'GET', {}, cookie)).body.funds.length, 2);
  assert.equal((await route(service, '/api/ai/research', 'POST', { fund: '000000' })).status, 400);
  assert.equal(f.counts.ai, 0);
});

test('truncated generation retries only once and reuses completed cache', async t => {
  const f = fixture(t);
  let calls = 0;
  f.deps.request = async (url, options) => {
    const body = JSON.parse(options.body);
    calls++;
    assert.equal(body.max_tokens, calls === 1 ? 4096 : 8192);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: calls === 1 ? 'length' : 'stop', message: { content: calls === 1 ? '{' : JSON.stringify({ summary: 'Complete', events: [] }) } }] }) };
  };
  const service = createAIService(f.deps);
  await service.research(); await service.research();
  assert.equal(calls, 2);
});

test('repeated truncation fails without storing partial report', async t => {
  const f = fixture(t);
  let calls = 0;
  f.deps.request = async () => { calls++; return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }) }; };
  await assert.rejects(createAIService(f.deps).research(), /扩容重试/);
  assert.equal(calls, 2);
});

test('legacy settings migrate to Tavily or feed without dropping credentials', t => {
  assert.equal(fixture(t, true).service.publicSettings().searchProvider, 'tavily');
  assert.equal(fixture(t, false).service.publicSettings().searchProvider, 'feed');
});

test('provider switching isolates caches, retains secrets, and survives restart', async t => {
  const f = fixture(t, true);
  const calls = { volcengine: 0, tencent: 0, bailian: 0 };
  const oldRequest = f.deps.request;
  f.deps.request = async (url, options) => {
    let response;
    if (url.includes('feedcoopapi')) { calls.volcengine++; response = { Result: { WebResults: [{ Title: 'Volc news', Url: 'https://example.com/volc', Summary: 'Evidence' }] } }; }
    else if (url.includes('wsa.cloud')) { calls.tencent++; response = { Response: { Pages: [JSON.stringify({ title: 'Tencent news', url: 'https://example.com/tencent', passage: 'Evidence' })] } }; }
    else if (url === 'https://8.8.8.8/native') { calls.bailian++; response = { output: { search_info: { search_results: [{ title: 'Bailian news', url: 'https://example.com/bailian' }] } } }; }
    else return oldRequest(url, options);
    return { ok: true, json: async () => response };
  };
  const service = createAIService(f.deps);
  const login = await route(service, '/api/admin/login', 'POST', { password: 'test-admin-only' });
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  const base = { marketSource: 'eastmoney', enabled: true, endpoint: 'https://8.8.8.8/v1', model: 'test' };
  const saved = await route(service, '/api/admin/settings', 'POST', { ...base, searchProvider: 'tavily', volcSearchKey: 'volc-secret', tencentSearchKey: 'tencent-secret', bailianSearchKey: 'bailian-secret', bailianEndpoint: 'https://8.8.8.8/native' }, cookie);
  assert.equal(saved.status, 200);
  for (const value of ['volc-secret', 'tencent-secret', 'bailian-secret', 'search-test-key']) assert.equal(JSON.stringify(saved.body).includes(value), false);
  for (const provider of ['tavily', 'volcengine', 'tencent', 'bailian']) {
    assert.equal((await route(service, '/api/admin/settings', 'POST', { ...base, searchProvider: provider }, cookie)).status, 200);
    const [first] = await Promise.all([service.research(), service.research(), service.research()]);
    assert.equal(first.cached, false);
    assert.equal((await service.research()).cached, true);
  }
  assert.deepEqual(calls, { volcengine: 1, tencent: 1, bailian: 1 });
  assert.equal(f.counts.search, 1);
  await route(service, '/api/admin/settings', 'POST', { ...base, searchProvider: 'tavily', searchKey: '' }, cookie);
  assert.equal((await service.research()).cached, true);
  assert.equal((await createAIService(f.deps).research()).cached, true);
  const rotated = await route(service, '/api/admin/settings', 'POST', { ...base, searchProvider: 'tavily', searchKey: 'new-tavily-secret' }, cookie);
  assert.equal(rotated.status, 200);
  assert.equal((await service.research()).cached, false);
  assert.equal(f.counts.search, 2);
  const removed = await route(service, '/api/admin/settings', 'POST', { ...base, searchProvider: 'feed', clearVolcSearchKey: true }, cookie);
  assert.equal(removed.body.hasVolcSearchKey, false);
  assert.equal(removed.body.hasTencentSearchKey, true);
  const missing = await route(service, '/api/admin/settings', 'POST', { ...base, searchProvider: 'volcengine' }, cookie);
  assert.equal(missing.status, 400);
  assert.equal(service.publicSettings().searchProvider, 'feed');
});
