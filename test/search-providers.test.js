const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchNews, SEARCH_DEFAULTS, validateSearch, searchConfig } = require('../search-providers');

const configs = (provider) => ({ ...SEARCH_DEFAULTS, enabled: true, searchProvider: provider, searchKey: 't-key', volcSearchKey: 'v-key', tencentSearchKey: 'q-key', bailianSearchKey: 'b-key' });
function fake(response) {
  const calls = [];
  return { calls, post: async (...args) => { calls.push(args); return response; }, validateEndpoint: async value => value, now: () => Date.UTC(2026, 8, 19) };
}

test('Tavily remains compatible', async () => {
  const deps = fake({ results: [{ title: 'News', content: 'Evidence', url: 'https://example.com', published_date: '2026-09-19' }] });
  const rows = await searchNews(configs('tavily'), 'query', deps);
  assert.equal(rows[0].summary, 'Evidence');
  assert.equal(deps.calls[0][2], 't-key');
  assert.equal(deps.calls[0][1].include_answer, false);
});

test('Volcengine uses API key endpoint and maps source records', async () => {
  const deps = fake({ Result: { WebResults: [{ Title: 'News', Summary: 'Evidence', Url: 'https://example.com', PublishTime: '2026-09-19', SiteName: 'Publisher' }] } });
  const rows = await searchNews(configs('volcengine'), 'q'.repeat(180), deps);
  assert.equal(deps.calls[0][0], 'https://open.feedcoopapi.com/search_api/web_search');
  assert.equal(deps.calls[0][1].Query.length, 100);
  assert.equal(deps.calls[0][1].TimeRange, 'OneWeek');
  assert.equal(deps.calls[0][2], 'v-key');
  assert.equal(rows[0].source, 'Publisher');
  assert.equal(rows[0].summary, 'Evidence');
});

test('Tencent service-key API parses JSON-encoded pages and ignores malformed pages', async () => {
  const deps = fake({ Response: { Pages: ['bad json', JSON.stringify({ title: 'News', passage: 'Evidence', url: 'https://example.com', date: '2026/09/19' })] } });
  const rows = await searchNews(configs('tencent'), 'query', deps);
  assert.equal(deps.calls[0][0], 'https://api.wsa.cloud.tencent.com/SearchPro');
  assert.equal(deps.calls[0][2], 'q-key');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, 'Evidence');
});

test('Bailian uses native search sources, never model-created URLs or narrative', async () => {
  const deps = fake({ output: { choices: [{ message: { content: 'Invented narrative https://fake.example' } }], search_info: { search_results: [{ title: 'Real source', url: 'https://example.com' }] } } });
  const rows = await searchNews(configs('bailian'), 'query', deps);
  assert.equal(deps.calls[0][2], 'b-key');
  assert.equal(deps.calls[0][1].parameters.search_options.forced_search, true);
  assert.equal(deps.calls[0][1].parameters.search_options.enable_source, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, '');
  assert.equal(rows[0].url, 'https://example.com');
});

test('provider errors are sanitized even with HTTP 200', async () => {
  for (const provider of ['volcengine', 'tencent', 'bailian', 'tavily']) {
    await assert.rejects(searchNews(configs(provider), 'q', fake({ Response: { Error: { Message: 'secret' } }, code: 'bad', message: 'secret' })), e => e.status === 502 && !e.message.includes('secret'));
  }
  await assert.rejects(searchNews(configs('bailian'), 'q', fake({ output: { choices: [{ message: { content: 'No sources' } }] } })), /可引用/);
});

test('selected provider requires its own key; inactive keys do not change cache identity', () => {
  const config = configs('volcengine');
  assert.throws(() => validateSearch({ ...config, volcSearchKey: '' }), /火山/);
  assert.throws(() => validateSearch({ ...config, searchProvider: '__proto__' }), /有效/);
  assert.deepEqual(searchConfig(config), searchConfig({ ...config, tencentSearchKey: 'different' }));
  assert.notDeepEqual(searchConfig(config), searchConfig({ ...config, volcSearchKey: 'rotated' }));
});
