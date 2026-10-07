const options = { headers: { Referer: 'https://quote.eastmoney.com/' } };
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const round = value => Number(value.toFixed(2));

async function fetchBoardJson(fetchJson, url) {
  try { return await fetchJson(url, options, 6000); }
  catch {
    const backup = new URL(url);
    backup.hostname = '82.push2.eastmoney.com';
    return fetchJson(backup.href, options, 6000);
  }
}

async function loadIndustryBoards(holdings, { fetchJson, cached }) {
  if (!holdings.length) return [];
  const catalog = await cached('industry-boards:v2', 60000, async () => {
    const rows = new Map();
    // Push2 may cap pz at 100 even when a larger page size is requested.
    for (let page = 1; page <= 50; page++) {
      const url = new URL('https://push2.eastmoney.com/api/qt/clist/get');
      url.search = new URLSearchParams({ pn: String(page), pz: '100', po: '0', fid: 'f12', np: '1', fltt: '2', invt: '2', fs: 'm:90+t:2', fields: 'f12,f14,f2,f3,f4,f6,f20,f124' });
      const payload = await fetchBoardJson(fetchJson, url.href);
      const batch = payload.data?.diff;
      if (!Array.isArray(batch) || !batch.length) throw Error('行业板块分页数据缺失');
      const before = rows.size;
      for (const row of batch) if (row.f12 && row.f14) rows.set(row.f12, row);
      if (rows.size === before) throw Error('行业板块分页重复');
      const total = Number(payload.data.total);
      if (Number.isFinite(total) && rows.size >= total || !Number.isFinite(total) && batch.length < 100) return [...rows.values()];
    }
    throw Error('行业板块分页超出限制');
  });
  const byName = new Map(catalog.map(row => [row.f14, row]));
  const matches = new Array(holdings.length);
  let cursor = 0;
  async function worker() {
    while (cursor < holdings.length) {
      const index = cursor++, holding = holdings[index], quote = holding.quote || {};
      let name = quote.marketIndustry;
      if (!byName.has(name) && /^[01]$/.test(String(holding.market)) && /^\d{6}$/.test(holding.code)) {
        try {
          name = await cached(`stock-board:${holding.market}.${holding.code}`, 86400000, async () => {
            const data = await fetchBoardJson(fetchJson, `https://push2.eastmoney.com/api/qt/stock/get?secid=${holding.market}.${holding.code}&fields=f127`);
            if (!data.data?.f127 || data.data.f127 === '-') throw Error('股票所属行业缺失');
            return data.data.f127;
          });
        } catch {}
      }
      let method = 'quote-industry';
      if (!byName.has(name)) {
        name = [quote.industry, ...(quote.industryPath || []).slice().reverse()].find(value => byName.has(value));
        method = 'EM2016-hierarchy';
      }
      if (name) matches[index] = { holding, row: byName.get(name), method };
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, holdings.length) }, worker));
  const result = new Map();
  for (const match of matches.filter(Boolean)) {
    const { holding, row, method } = match;
    if (!row) continue;
    let board = result.get(row.f12);
    if (!board) {
      board = { code: row.f12, name: row.f14, price: numeric(row.f2), pct: numeric(row.f3), change: numeric(row.f4), amount: numeric(row.f6), marketCap: numeric(row.f20), weight: 0, industries: [], matchMethods: [] };
      board.quoteTime = Number.isFinite(row.f124) && row.f124 > 0 && row.f124 < 1e11 ? new Date(row.f124 * 1000).toISOString() : null;
      result.set(row.f12, board);
    }
    board.weight += Number.isFinite(holding.weight) ? holding.weight : 0;
    if (holding.quote?.industry && !board.industries.includes(holding.quote.industry)) board.industries.push(holding.quote.industry);
    if (!board.matchMethods.includes(method)) board.matchMethods.push(method);
  }
  return [...result.values()].map(board => ({ ...board, weight: round(board.weight) })).sort((a, b) => b.weight - a.weight);
}

function boardSignal(holdings, boards, pressure) {
  const total = holdings.reduce((sum, item) => sum + (Number.isFinite(item.weight) ? item.weight : 0), 0);
  const valid = boards.filter(board => Number.isFinite(board.pct) && board.weight > 0);
  const covered = valid.reduce((sum, board) => sum + board.weight, 0);
  const coverage = total > 0 ? Math.min(100, covered / total * 100) : 0;
  const momentum = covered > 0 ? round(valid.reduce((sum, board) => sum + board.weight * board.pct, 0) / 100) : null;
  let stance = coverage >= 50 && Number.isFinite(pressure) ? '中性观察' : '数据不足';
  if (stance !== '数据不足' && pressure > 1 && momentum > 0.8) stance = '偏强';
  if (stance !== '数据不足' && pressure < -1 && momentum < -0.8) stance = '承压';
  return { boardMomentum: momentum, boardCoverage: round(coverage), boardCoveredWeight: round(covered), stance };
}

module.exports = { loadIndustryBoards, boardSignal };
