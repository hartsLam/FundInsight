const fs = require('node:fs');
const path = require('node:path');

const DAY = 86400000;
const RETRY = 15 * 60000;

function parseIndustry(rows, code, sourceUrl, now) {
  const row = Array.isArray(rows) && rows.find(item => item.SECURITY_CODE === code);
  const full = row && typeof row.EM2016 === 'string' ? row.EM2016.trim() : '';
  if (!full || full === '-' || full.includes('未分类') || full.length > 180 || /[<>]/.test(full)) return null;
  const levels = full.split('-').map(value => value.trim()).filter(Boolean);
  if (!levels.length) return null;
  return { industry: levels.at(-1), industryPath: levels, industrySource: '东方财富公司资料',
    industryStandard: '东方财富 EM2016', industrySourceUrl: sourceUrl,
    industryUpdatedAt: new Date(now).toISOString(), industryStale: false };
}

function createIndustryService({ dataDir, fetchJson, now = Date.now }) {
  const file = path.join(dataDir, 'stock-industries-v1.json');
  const entries = new Map();
  const pending = new Map();
  const retryAt = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, entry] of Object.entries(saved)) {
      if (/^[01]\.\d{6}$/.test(key) && Number.isFinite(entry?.at) && typeof entry?.value?.industry === 'string' && Array.isArray(entry.value.industryPath)) entries.set(key, entry);
    }
  } catch {}

  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { console.warn('Industry cache persistence failed'); }
  }

  async function get(stock) {
    const code = String(stock.code);
    const market = Number(stock.market);
    if (!/^\d{6}$/.test(code) || ![0, 1].includes(market)) return null;
    const key = `${market}.${code}`;
    const old = entries.get(key);
    if (old && now() - old.at < DAY) return { ...old.value, industryStale: false };
    const stale = () => old && now() - old.at < 7 * DAY ? { ...old.value, industryStale: true } : null;
    if ((retryAt.get(key) || 0) > now()) return stale();
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const symbol = `${market === 1 ? 'SH' : 'SZ'}${code}`;
      const sourceUrl = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/Index?type=web&code=${symbol}`;
      const backup = new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
      backup.search = new URLSearchParams({ reportName: 'RPT_F10_ORG_BASICINFO', columns: 'SECURITY_CODE,EM2016',
        filter: `(SECURITY_CODE="${code}")`, source: 'HSF10', client: 'PC' });
      const urls = [`https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${symbol}`, backup.href];
      for (const url of urls) {
        try {
          const payload = await fetchJson(url, { headers: { Referer: sourceUrl } }, 6000);
          const value = parseIndustry(payload.jbzl || payload.result?.data, code, sourceUrl, now());
          if (!value) continue;
          entries.set(key, { at: now(), value });
          retryAt.delete(key);
          persist();
          return value;
        } catch {}
      }
      retryAt.set(key, now() + RETRY);
      return stale();
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }

  async function enrich(holdings) {
    const result = new Array(holdings.length);
    let cursor = 0;
    // Bound upstream concurrency even when a new fund has many disclosed holdings.
    async function worker() {
      while (cursor < holdings.length) {
        const index = cursor++;
        const item = holdings[index];
        const profile = await get(item);
        result[index] = { ...item, quote: { ...item.quote, ...(profile || {
          industry: '未分类', industryPath: [], industrySource: null, industrySourceUrl: null,
          industryUpdatedAt: null, industryStale: false
        }) } };
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, holdings.length) }, worker));
    return result;
  }
  return { get, enrich };
}

module.exports = { createIndustryService, parseIndustry };
