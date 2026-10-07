const { quoteTime } = require('./market-signal');

function parseSinaStockQuotes(text, holdings) {
  const requested = new Map(holdings.map(item => [`${Number(item.market) === 1 ? 'sh' : 'sz'}${item.code}`, item]));
  const rows = new Map();
  for (const match of text.matchAll(/var\s+hq_str_((?:sh|sz)\d{6})\s*=\s*"([^"\r\n]*)"\s*;/g)) {
    const holding = requested.get(match[1]);
    if (!holding) continue;
    const values = match[2].split(',');
    const number = i => values[i]?.trim() && Number.isFinite(Number(values[i])) ? Number(values[i]) : null;
    const price = number(3), previousClose = number(2);
    const time = quoteTime(`${values[30]} ${values[31]}`);
    if (values.length < 32 || !(price > 0) || !(previousClose > 0) || !time) continue;
    rows.set(match[1], { code: holding.code, market: Number(holding.market), name: holding.name || values[0],
      price, previousClose, open: number(1), pct: Number(((price / previousClose - 1) * 100).toFixed(2)),
      change: Number((price - previousClose).toFixed(4)), volume: number(8) === null ? null : number(8) / 100, amount: number(9),
      marketCap: null, freeMarketCap: null, mainNetInflow: null, industry: '未分类', region: '', concepts: [],
      quoteSource: 'sina', quoteTime: time });
  }
  return [...rows.values()];
}

async function fetchSinaStockQuotes(holdings, fetchBytes) {
  const supported = holdings.filter(item => /^[01]$/.test(String(item.market)) && /^\d{6}$/.test(item.code));
  if (!supported.length) return [];
  const symbols = supported.map(item => `${Number(item.market) === 1 ? 'sh' : 'sz'}${item.code}`).join(',');
  const bytes = await fetchBytes(`https://hq.sinajs.cn/list=${symbols}`, { headers: { Referer: 'https://finance.sina.com.cn/' } }, 6000);
  const rows = parseSinaStockQuotes(new TextDecoder('gbk').decode(bytes), supported);
  if (!rows.length) throw Error('新浪未返回有效股票行情');
  return rows;
}

module.exports = { parseSinaStockQuotes, fetchSinaStockQuotes };
