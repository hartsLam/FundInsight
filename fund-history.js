function parseFundHistory(text, code) {
  if (typeof text !== 'string' || text.length > 10000000) throw Error('历史净值数据格式异常');
  const declared = /\bvar\s+fS_code\s*=\s*["'](\d{6})["']/.exec(text);
  if (!declared || declared[1] !== code) throw Error('历史净值基金代码不匹配');
  const match = /\bvar\s+Data_netWorthTrend\s*=\s*\[/.exec(text);
  if (!match) throw Error('该基金暂无可用单位净值历史');
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false, end = -1;
  // Extract the JSON array only; never execute provider JavaScript.
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw Error('历史净值数据不完整');
  const raw = JSON.parse(text.slice(start, end));
  const dates = new Map();
  for (const row of raw) {
    if (!Number.isFinite(row?.x) || row.x < 631152000000 || row.x > 4102444800000 || !Number.isFinite(row.y) || row.y <= 0) continue;
    const date = new Date(row.x + 8 * 3600000).toISOString().slice(0, 10);
    dates.set(date, { date, nav: row.y, changePct: Number.isFinite(row.equityReturn) ? row.equityReturn : null,
      dividend: typeof row.unitMoney === 'string' ? row.unitMoney.slice(0, 160) : '' });
  }
  const rows = [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw Error('该基金暂无可用单位净值历史');
  return rows;
}

function createFundHistoryService({ fetchText, now = Date.now }) {
  const cache = new Map();
  const pending = new Map();
  return async function get(code) {
    if (!/^\d{6}$/.test(code)) throw Error('基金代码无效');
    const old = cache.get(code);
    if (old && now() - old.loadedAt < 15 * 60000) return old.payload;
    if (pending.has(code)) return pending.get(code);
    const task = (async () => {
      try {
        const text = await fetchText(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Math.floor(now() / 900000)}`, {
          headers: { Referer: `https://fund.eastmoney.com/${code}.html` }
        });
        const rows = parseFundHistory(text, code);
        const payload = { code, rows, source: '天天基金 / 东方财富', sourceUrl: `https://fundf10.eastmoney.com/jjjz_${code}.html`,
          updatedAt: new Date(now()).toISOString(), stale: false };
        cache.set(code, { loadedAt: now(), payload });
        return payload;
      } catch (error) {
        if (old && now() - old.loadedAt < 86400000) return { ...old.payload, stale: true };
        throw error;
      }
    })();
    pending.set(code, task);
    try { return await task; } finally { pending.delete(code); }
  };
}

module.exports = { parseFundHistory, createFundHistoryService };
