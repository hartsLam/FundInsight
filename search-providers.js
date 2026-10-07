const SEARCH_LABELS = Object.freeze({ feed: 'AI 财经资讯筛选', tavily: 'Tavily', volcengine: '火山引擎', tencent: '腾讯云', bailian: '阿里云百炼' });
const SEARCH_DEFAULTS = Object.freeze({ volcSearchKey: '', tencentSearchKey: '', bailianSearchKey: '', bailianEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', bailianModel: 'qwen-plus' });
const SEARCH_SECRETS = ['searchKey', 'volcSearchKey', 'tencentSearchKey', 'bailianSearchKey'];
const KEY_FIELDS = { tavily: 'searchKey', volcengine: 'volcSearchKey', tencent: 'tencentSearchKey', bailian: 'bailianSearchKey' };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function searchConfig(config) {
  const provider = config.searchProvider;
  return { provider, key: config[KEY_FIELDS[provider]] || '', ...(provider === 'bailian' ? { endpoint: config.bailianEndpoint, model: config.bailianModel } : {}) };
}

function validateSearch(config) {
  if (!Object.hasOwn(SEARCH_LABELS, config.searchProvider)) throw fail('请选择有效的新闻检索平台。');
  const active = searchConfig(config);
  if (config.enabled && active.provider !== 'feed' && !active.key) throw fail(`请填写${SEARCH_LABELS[active.provider]}搜索 Key，或切换至财经资讯筛选。`);
  if (config.enabled && active.provider === 'bailian' && (!active.endpoint || !active.model)) throw fail('请填写百炼搜索接口地址和模型。');
}

// Only provider-returned source records become evidence; generated answers never become news.
async function searchNews(config, query, { post, validateEndpoint, now = Date.now, purpose = 'news' }) {
  validateSearch(config);
  const active = searchConfig(config);
  let result;
  if (active.provider === 'tavily') {
    result = await post('https://api.tavily.com/search', { query, ...(purpose === 'web' ? { topic: 'general' } : { topic: 'news', time_range: 'week' }), max_results: 6, include_answer: false }, active.key);
    if (!Array.isArray(result.results)) throw fail('Tavily 未返回有效搜索结果。', 502);
    return result.results.map(row => ({ title: row.title, summary: row.content, url: row.url, time: row.published_date || null, source: 'Tavily' }));
  }
  if (active.provider === 'volcengine') {
    result = await post('https://open.feedcoopapi.com/search_api/web_search', { Query: query.slice(0, 100), SearchType: 'web', Count: 6, ...(purpose === 'web' ? {} : { TimeRange: 'OneWeek' }), NeedContent: true, NeedUrl: true }, active.key);
    if (result.ResponseMetadata?.Error || !Array.isArray(result.Result?.WebResults)) throw fail('火山搜索未返回有效结果，请检查搜索 Key 和服务权限。', 502);
    return result.Result.WebResults.map(row => ({ title: row.Title, summary: row.Summary || row.Snippet || row.Content, url: row.Url, time: row.PublishTime || null, source: row.SiteName || '火山引擎' }));
  }
  if (active.provider === 'tencent') {
    // The service-key endpoint does not require Tencent Cloud account-wide credentials.
    result = await post('https://api.wsa.cloud.tencent.com/SearchPro', { Query: query }, active.key);
    if (result.Response?.Error || !Array.isArray(result.Response?.Pages)) throw fail('腾讯搜索未返回有效结果，请检查联网搜索服务 Key 和权限。', 502);
    const rows = [];
    for (const page of result.Response.Pages) {
      let row;
      try { row = typeof page === 'string' ? JSON.parse(page) : page; } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      rows.push({ title: row.title, summary: row.content || row.passage, url: row.url, time: row.date || null, source: row.site || '腾讯云' });
    }
    return rows;
  }
  if (active.provider === 'bailian') {
    const endpoint = await validateEndpoint(active.endpoint);
    result = await post(endpoint, { model: active.model,
      input: { messages: [{ role: 'user', content: `当前日期 ${new Date(now()).toISOString().slice(0, 10)}。${purpose === 'web' ? '检索并核实这个问题，优先原始官方资料' : '搜索最近七天的真实财经新闻'}：${query}。优先官方公告和权威财经媒体。` }] },
      parameters: { enable_search: true, result_format: 'message', max_tokens: 1000,
        search_options: { forced_search: true, enable_source: true, search_strategy: 'turbo', ...(purpose === 'web' ? {} : { freshness: 7 }) } }
    }, active.key);
    const rows = result.output?.search_info?.search_results;
    if (result.code || !Array.isArray(rows) || !rows.length) throw fail('百炼未返回可引用的搜索来源，请检查原生接口地址及模型联网搜索支持。', 502);
    return rows.map(row => ({ title: row.title, summary: row.snippet || row.content || '', url: row.url, time: row.publish_time || null, source: row.site_name || '阿里云百炼' }));
  }
  throw fail('当前模式不使用联网搜索。');
}

module.exports = { SEARCH_LABELS, SEARCH_DEFAULTS, SEARCH_SECRETS, searchConfig, validateSearch, searchNews };
