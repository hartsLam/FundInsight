const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAIService } = require("./ai-service");
const { loadFundValue } = require('./fund-value');
const { createFundRegistry } = require('./fund-registry');
const { createIndustryService } = require('./stock-industry');
const { createFundHistoryService } = require('./fund-history');
const { createIntradayService } = require('./fund-intraday');
const { holdingsRequest, probeSource } = require('./market-sources');
const { loadIndustryBoards } = require('./industry-boards');
const { quoteTime, isQuoteFresh, quotesWithFallback, shortTermSignal } = require('./market-signal');
const { fetchSinaStockQuotes } = require('./sina-stock-quotes');
const getFundHistory = createFundHistoryService({ fetchText });

const PORT = Number(process.env.PORT || 3210);
const FUND_CODE = process.env.FUND_CODE || "162201";
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 5);
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.join(__dirname, "data");
const getFundIntraday = createIntradayService({ dataDir: CACHE_DIR, fetchJson, fetchBytes, getHistory: getFundHistory });
const DASHBOARD_CACHE_FILE = path.join(CACHE_DIR, "dashboard-cache.json");
const AUTH_TIMEZONE = process.env.AUTH_TIMEZONE || "Asia/Shanghai";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
if (!ACCESS_PASSWORD || !ACCESS_PASSWORD.trim()) {
  throw new Error("Set ACCESS_PASSWORD before starting the server.");
}
const AUTH_COOKIE = "fund_dashboard_auth";
const AUTH_SECRET = process.env.ACCESS_SECRET || crypto.randomBytes(32).toString('hex');

const SOURCE = {
  fund: "天天基金/东方财富基金档案",
  quote: "东方财富 Push2 行情",
  kline: "东方财富 Push2His K线",
  news: "东方财富财经资讯"
};

const industryService = createIndustryService({ dataDir: CACHE_DIR, fetchJson });

const cache = new Map();
const dashboards = new Map();
const refreshing = new Map();
let settingsRevision = 0;
const fundRegistry = createFundRegistry({ dataDir: CACHE_DIR, initialCode: FUND_CODE, lookup: async code => {
  const result = await fetchJson(`https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast?FCODES=${code}&FIELDS=FCODE,SHORTNAME`);
  const row = result.data?.find(item => item.FCODE === code);
  return row?.SHORTNAME ? { name: row.SHORTNAME } : null;
} });
const aiService = createAIService({
  dataDir: CACHE_DIR,
  getDashboard: code => buildDashboard(false, code),
  getKline: (market, code, days) => fetchKline(market, code, days),
  getFundHistory,
  getFundIntraday,
  fundRegistry,
  getNews: fetchNewsCandidates,
  onSettingsChanged: () => { settingsRevision++; cache.clear(); dashboards.clear(); }
});

function todayParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AUTH_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    key: `${values.year}${values.month}${values.day}`
  };
}

function authToken() {
  const { key } = todayParts();
  const digest = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(`${key}:${FUND_CODE}`)
    .digest("base64url");
  return `${key}.${digest}`;
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return index === -1 ? [item, ""] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function hasValidAuth(req) {
  return parseCookies(req)[AUTH_COOKIE] === authToken();
}

function setAuthCookie(res) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(authToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`
  );
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function text(res, status, payload, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0"
  });
  res.end(payload);
}

function safeLog(label, error) {
  console.warn(`${label} failed:`, error?.message || error);
}

async function optional(label, loader, fallback) {
  try {
    return await loader();
  } catch (error) {
    safeLog(label, error);
    return fallback;
  }
}

function loadSavedDashboard(code) {
  try {
    const file = path.join(CACHE_DIR, `dashboard-${code}.json`);
    const source = fs.existsSync(file) ? file : DASHBOARD_CACHE_FILE;
    if (!fs.existsSync(source)) return null;
    const payload = JSON.parse(fs.readFileSync(source, "utf8"));
    if (payload.fund?.code !== code) return null;
    return { loadedAt: Date.parse(payload.updatedAt) || Date.now(), payload };
  } catch (error) {
    safeLog("load dashboard cache", error);
    return null;
  }
}

function saveDashboard(payload) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `dashboard-${payload.fund.code}.json`), JSON.stringify(payload), "utf8");
  } catch (error) {
    safeLog("save dashboard cache", error);
  }
}

function fallbackDashboard(error, code = FUND_CODE) {
  return {
    fund: {
      code,
      name: fundRegistry.list().funds.find(f => f.code === code)?.name || code,
      navDate: null,
      nav: null,
      estimate: null,
      estimatePct: null,
      estimateTime: null
    },
    report: {
      title: "数据暂时不可用",
      date: null,
      previousTitle: null,
      previousDate: null
    },
    holdings: [],
    changes: [],
    distribution: { industry: [], market: [], concepts: [] },
    boards: [],
    indexes: [],
    news: [],
    events: [{
      type: "系统",
      title: "数据暂时不可用",
      summary: "上游数据源暂时不可用，服务会继续自动刷新。",
      source: "本地服务",
      time: new Date().toISOString(),
      url: null,
      matched: []
    }],
    analysis: {
      stance: "待更新",
      topWeight: 0,
      topTenWeight: 0,
      quoteContribution: null,
      boardMomentum: 0,
      breadth: 0,
      lines: [
        "数据暂时不可用，服务会继续自动刷新。",
        "如果这是刚部署后的首次启动，请稍后刷新页面。"
      ],
      disclaimer: "内容仅供信息展示，不构成投资建议。"
    },
    source: SOURCE,
    updatedAt: new Date().toISOString(),
    stale: true,
    warning: "实时数据暂时不可用，当前展示降级页面。",
    error: error?.message || "upstream unavailable"
  };
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  }[ext] || "application/octet-stream";
}

async function fetchText(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 fund-162201-dashboard",
        Referer: "https://www.eastmoney.com/",
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBytes(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 fund-162201-dashboard",
        Referer: "https://www.eastmoney.com/",
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  return JSON.parse(await fetchText(url, options, timeoutMs));
}

async function checkSource(label, url, parser, options) {
  return probeSource(fetchText, label, url, parser, options);
}

async function checkSources() {
  const now = Date.now();
  const holdings = holdingsRequest(FUND_CODE, '', now);
  const checks = [
    checkSource(
      "fund-estimate",
      `https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast?FCODES=${FUND_CODE}&FIELDS=FCODE,GSZ,GZTIME,NAV,PDATE`,
      (textValue) => JSON.parse(textValue).data
    ),
    checkSource(
      "fund-holdings",
      holdings.url,
      (textValue) => {
        if (!parseHoldingTables(getFundContent(textValue)).length) throw Error('持仓接口未返回可解析的持仓表');
        return 'content found';
      },
      holdings.options
    ),
    checkSource(
      "stock-quotes",
      "https://push2.eastmoney.com/api/qt/ulist.np/get?secids=0.300308&fields=f12,f14,f2,f3,f100",
      (textValue) => textValue.slice(0, 160)
    ),
    checkSource(
      "stock-quotes-backup",
      "https://qt.gtimg.cn/q=sz300308",
      (textValue) => textValue.slice(0, 160)
    ),
    checkSource(
      "stock-kline",
      "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.300308&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=20250101&end=20500101",
      (textValue) => textValue.slice(0, 160)
    ),
    checkSource(
      "stock-kline-backup",
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sz300308,day,,,40,qfq",
      (textValue) => textValue.slice(0, 160)
    ),
    checkSource(
      "market-news",
      `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&pageSize=5&page=1&req_trace=${now}`,
      (textValue) => textValue.slice(0, 160)
    )
  ];
  return {
    checkedAt: new Date().toISOString(),
    results: await Promise.all(checks)
  };
}

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.value;
  const value = await loader();
  cache.set(key, { time: Date.now(), value });
  return value;
}

function stripTags(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value) {
  const cleaned = String(value || "").replace(/,/g, "").replace(/%/g, "").trim();
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}

function percent(value) {
  return Math.round(value * 100) / 100;
}

function getFundContent(scriptText) {
  const match = scriptText.match(/content:"([\s\S]*?)",arryear:/);
  if (!match) return "";
  return match[1]
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function parseHoldingTables(html) {
  const tables = [];
  const tablePattern = /<h4[\s\S]*?<label[^>]*>([\s\S]*?股票投资明细)[\s\S]*?截止至：<font[^>]*>([^<]+)<\/font>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/g;
  let tableMatch;

  while ((tableMatch = tablePattern.exec(html))) {
    const title = stripTags(tableMatch[1]);
    const date = stripTags(tableMatch[2]);
    const rowsHtml = tableMatch[3];
    const holdings = [];
    const rowPattern = /<tr>([\s\S]*?)<\/tr>/g;
    let rowMatch;

    while ((rowMatch = rowPattern.exec(rowsHtml))) {
      const row = rowMatch[1];
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      const codeMatch = row.match(/unify\/r\/(\d)\.(\d{6})/);
      if (!codeMatch || cells.length < 9) continue;
      holdings.push({
        rank: toNumber(cells[0]),
        market: Number(codeMatch[1]),
        code: codeMatch[2],
        name: stripTags(cells[2]),
        weight: toNumber(cells[6]),
        shares: toNumber(cells[7]),
        marketValue: toNumber(cells[8])
      });
    }

    const quarterMatch = title.match(/(\d{4})年(\d)季度/);
    tables.push({
      title,
      date,
      year: quarterMatch ? Number(quarterMatch[1]) : null,
      quarter: quarterMatch ? Number(quarterMatch[2]) : null,
      holdings
    });
  }

  return tables;
}

async function fetchFundTables(code, year = "") {
  const request = holdingsRequest(code, year);
  const scriptText = await fetchText(request.url, request.options);
  return parseHoldingTables(getFundContent(scriptText));
}

async function fetchFundEstimate(code) {
  return cached(`estimate:${code}`, 60 * 1000, () => loadFundValue(code, { fetchJson, fetchBytes }));
}

async function currentAndPreviousHoldings(code) {
  return cached(`holdings:${code}`, 30 * 60 * 1000, async () => {
    const latest = (await fetchFundTables(code))[0];
    if (!latest) throw new Error("无法解析基金持仓数据");

    let previous = null;
    if (latest.year && latest.quarter) {
      if (latest.quarter === 1) {
        previous = (await fetchFundTables(code, latest.year - 1)).find((table) => table.quarter === 4);
      } else {
        previous = (await fetchFundTables(code, latest.year)).find((table) => table.quarter === latest.quarter - 1);
      }
    }

    return { latest, previous };
  });
}

async function fetchQuotes(holdings) {
  if (!holdings.length) return [];
  const secids = holdings.map((item) => `${item.market}.${item.code}`).join(",");
  const primary = aiService.marketSource();
  return cached(`quotes:${primary}:${secids}`, 60 * 1000, async () => {
    const eastmoney = () => fetchEastmoneyQuotes(holdings, secids);
    const tencent = () => fetchTencentQuotes(holdings);
    return quotesWithFallback(holdings, primary === 'tencent' ? tencent : eastmoney, primary === 'tencent' ? eastmoney : tencent, Date.now(), [() => fetchSinaStockQuotes(holdings, fetchBytes)]);
  });
}

async function fetchEastmoneyQuotes(holdings, secids) {
  const fields = [
    "f12", "f13", "f14", "f2", "f3", "f4", "f5", "f6", "f17", "f18",
    "f20", "f21", "f62", "f100", "f102", "f103", "f124"
  ].join(",");
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=${fields}&ut=bd1d9ddb04089700cf9c27f6f7426281`;
  const payload = await fetchJson(url, {
    headers: { Referer: "https://quote.eastmoney.com/" }
  });

  if (!Array.isArray(payload.data?.diff) || !payload.data.diff.length) throw new Error('Empty stock quotes');
  return payload.data.diff.map((row) => ({
    code: row.f12,
    market: row.f13,
    name: row.f14,
    price: row.f2 === "-" ? null : row.f2 / 100,
    pct: row.f3 === "-" ? null : row.f3 / 100,
    change: row.f4 === "-" ? null : row.f4 / 100,
    volume: row.f5,
    amount: row.f6,
    open: row.f17 === "-" ? null : row.f17 / 100,
    previousClose: row.f18 === "-" ? null : row.f18 / 100,
    marketCap: row.f20,
    freeMarketCap: row.f21,
    mainNetInflow: row.f62,
    industry: row.f100 || "未分类",
    marketIndustry: row.f100 || null,
    region: row.f102 || "",
    concepts: row.f103 ? String(row.f103).split(",").slice(0, 8) : [],
    quoteSource: 'eastmoney',
    quoteTime: quoteTime(row.f124)
  }));
}

function marketPrefix(market) {
  return Number(market) === 1 ? "sh" : "sz";
}

function isMissingIndustry(value) {
  return !value || value === "-" || String(value).includes("未分类");
}

async function fetchTencentQuotes(holdings) {
  const symbols = holdings.map((item) => `${marketPrefix(item.market)}${item.code}`).join(",");
  const raw = await fetchBytes(`https://qt.gtimg.cn/q=${symbols}`, {
    headers: {
      Referer: "https://finance.qq.com/",
      "User-Agent": "Mozilla/5.0 fund-162201-dashboard"
    }
  }, 12000);
  const decoded = new TextDecoder("gbk").decode(raw);
  const holdingMap = new Map(holdings.map((item) => [item.code, item]));

  const quotes = decoded
    .split(";")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const rawValue = line.slice(line.indexOf("=") + 1).trim();
      const value = rawValue.startsWith("\"") ? rawValue.slice(1, -1) : rawValue;
      const parts = value.split("~");
      const code = parts[2];
      const holding = holdingMap.get(code) || {};
      return {
        code,
        market: Number(holding.market),
        name: holding.name || parts[1] || code,
        price: Number(parts[3]) || null,
        pct: parts[32]?.trim() && Number.isFinite(Number(parts[32])) ? Number(parts[32]) : null,
        change: parts[31]?.trim() && Number.isFinite(Number(parts[31])) ? Number(parts[31]) : null,
        volume: Number(parts[36]) || null,
        amount: Number(parts[37]) ? Number(parts[37]) * 10000 : null,
        open: Number(parts[5]) || null,
        previousClose: Number(parts[4]) || null,
        marketCap: Number(parts[45]) ? Number(parts[45]) * 100000000 : null,
        freeMarketCap: Number(parts[44]) ? Number(parts[44]) * 100000000 : null,
        mainNetInflow: null,
        industry: "未分类",
        region: "",
        concepts: [],
        quoteSource: "tencent",
        quoteTime: quoteTime(parts[30])
      };
    }).filter((row) => holdingMap.has(row.code) && row.price !== null);
  if (!quotes.length) throw new Error('Empty Tencent stock quotes');
  return quotes;
}

function mergeQuotes(holdings, quotes) {
  const quoteMap = new Map(quotes.map((item) => [item.code, item]));
  return holdings.map((item) => {
    const quote = quoteMap.get(item.code);
    if (!quote) {
      return {
        ...item,
        quote: {
          code: item.code,
          market: item.market,
          name: item.name,
          price: null,
          pct: null,
          change: null,
          volume: null,
          amount: null,
          open: null,
          previousClose: null,
          marketCap: null,
          freeMarketCap: null,
          mainNetInflow: null,
          industry: "未分类",
          region: "",
          concepts: [],
          quoteSource: "unavailable"
        }
      };
    }
    return {
      ...item,
      quote: {
        ...quote,
        industry: isMissingIndustry(quote.industry) ? "未分类" : quote.industry,
        concepts: quote.concepts || []
      }
    };
  });
}

function compareHoldings(latest, previous) {
  const previousMap = new Map((previous?.holdings || []).map((item) => [item.code, item]));
  const latestMap = new Map(latest.holdings.map((item) => [item.code, item]));
  const changes = latest.holdings.map((item) => {
    const old = previousMap.get(item.code);
    return {
      code: item.code,
      name: item.name,
      weight: item.weight,
      previousWeight: old ? old.weight : 0,
      change: percent(item.weight - (old ? old.weight : 0)),
      status: old ? (item.weight > old.weight ? "增持" : item.weight < old.weight ? "减持" : "持平") : "新进"
    };
  });

  for (const old of previous?.holdings || []) {
    if (!latestMap.has(old.code)) {
      changes.push({
        code: old.code,
        name: old.name,
        weight: 0,
        previousWeight: old.weight,
        change: percent(-old.weight),
        status: "退出"
      });
    }
  }

  return changes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

function distribution(holdings) {
  const industry = new Map();
  const market = new Map();
  const concepts = new Map();

  for (const item of holdings) {
    const quote = item.quote;
    const industryName = isMissingIndustry(quote?.industry) ? "未分类" : quote.industry;
    industry.set(industryName, percent((industry.get(industryName) || 0) + item.weight));
    market.set(item.market === 1 ? "沪市/科创" : "深市/创业", percent((market.get(item.market === 1 ? "沪市/科创" : "深市/创业") || 0) + item.weight));

    for (const concept of quote?.concepts || []) {
      concepts.set(concept, percent((concepts.get(concept) || 0) + item.weight));
    }
  }

  const sorted = (map) => [...map.entries()]
    .map(([name, weight]) => ({ name, weight: percent(weight) }))
    .sort((a, b) => b.weight - a.weight);

  return {
    industry: sorted(industry),
    market: sorted(market),
    concepts: sorted(concepts).slice(0, 10)
  };
}

async function fetchIndustryBoards(holdings) {
  return loadIndustryBoards(holdings, { fetchJson, cached });
}

async function fetchMarketIndexes() {
  const indexes = [{ market: 1, code: '000001', name: '上证指数' }, { market: 0, code: '399001', name: '深证成指' }, { market: 0, code: '399006', name: '创业板指' }];
  return (await fetchQuotes(indexes)).map(({ code, name, price, pct, change, amount, quoteSource }) => ({ code, name, price, pct, change, amount, quoteSource }));
}

async function fetchEastmoneyMarketIndexes() {
  const secids = "1.000001,0.399001,0.399006";
  const fields = "f12,f13,f14,f2,f3,f4,f6";
  const payload = await cached("market-indexes", 60 * 1000, () => fetchJson(`https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=${fields}`, {
    headers: { Referer: "https://quote.eastmoney.com/" }
  }));
  return (payload.data?.diff || []).map((row) => ({
    code: row.f12,
    name: row.f14,
    price: row.f2 / 100,
    pct: row.f3 / 100,
    change: row.f4 / 100,
    amount: row.f6
  }));
}

async function fetchNewsCandidates() {
  const url = `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&pageSize=30&page=1&req_trace=${Date.now()}`;
  const payload = await fetchJson(url, {
    headers: { Referer: "https://www.eastmoney.com/" }
  });
  const rows = payload.data?.list || [];
  return rows.map((row) => {
    return {
      title: row.title,
      summary: row.summary,
      time: row.showTime,
      source: row.mediaName,
      url: row.uniqueUrl || row.url,
      matched: []
    };
  });
}

function buildKeywords(holdings, dist) {
  const words = new Set();
  for (const item of holdings.slice(0, 8)) {
    words.add(item.name);
    words.add(item.quote?.industry);
    for (const concept of item.quote?.concepts || []) {
      if (concept.includes("光") || concept.includes("算力") || concept.includes("芯片") || concept.includes("半导体") || concept.includes("AI")) {
        words.add(concept);
      }
    }
  }
  for (const item of dist.industry.slice(0, 5)) words.add(item.name);
  return [...words].filter(Boolean).slice(0, 24);
}

function insight(holdings, dist, boards, estimate, news) {
  const topWeight = percent(holdings.slice(0, 3).reduce((sum, item) => sum + item.weight, 0));
  const topTenWeight = percent(holdings.slice(0, 10).reduce((sum, item) => sum + item.weight, 0));
  const signal = shortTermSignal(holdings, boards, estimate);
  const { quoteContribution, breadth, boardMomentum, boardCoverage, boardCoveredWeight, stance } = signal;
  const topIndustries = dist.industry.slice(0, 3).map((item) => item.name).join("、");

  const leadingBoard = boards
    .slice()
    .sort((a, b) => Math.abs(b.pct || 0) - Math.abs(a.pct || 0))[0];
  const eventLine = news[0]
    ? `近期事件以「${news[0].title}」等为主，需观察其是否继续映射到${topIndustries || "重仓行业"}的成交额和资金流。`
    : leadingBoard
      ? `当前最直接的市场事件是${leadingBoard.name}板块涨跌幅 ${leadingBoard.pct > 0 ? "+" : ""}${leadingBoard.pct}%，成交约 ${Math.round(leadingBoard.amount / 1e8)} 亿元。`
      : "暂未抓取到与重仓行业高度匹配的即时事件，短线更多跟随板块成交和指数风险偏好。";

  return {
    stance,
    signal,
    topWeight,
    topTenWeight,
    quoteContribution,
    boardMomentum,
    boardCoverage,
    boardCoveredWeight,
    breadth,
    lines: [
      `最新披露重仓集中在${topIndustries || "若干行业"}，前三大持仓合计约 ${topWeight}%，前十合计约 ${topTenWeight}%。`,
      `有效披露重仓行情的静态贡献${quoteContribution === null ? '暂不可计算' : `约 ${quoteContribution}%`}；${boardMomentum === null ? '行业行情暂不可用或时间无法核验' : `已匹配板块的加权贡献约 ${boardMomentum}%，覆盖披露重仓权重的 ${boardCoverage}%`}。`,
      eventLine,
      signal.reason,
      signal.basis === 'holdings' ? '此处仅反映有效重仓股行情的整体方向，不能替代基金实时持仓与净值。'
      : stance === "偏强"
        ? "短线预判偏积极，但需要板块继续放量并避免高位重仓股回撤；若成交缩量，估值弹性会迅速降低。"
        : stance === "承压"
          ? "短线预判偏防守，重仓行业若继续弱于大盘，基金净值可能跟随承压；企稳信号优先看龙头股和行业指数止跌。"
          : stance === '数据不足' ? '行情或板块覆盖不足，暂不判断短线强弱；数据缺失不代表市场中性。'
          : "短线预判维持中性，继续观察行业轮动和重仓股分化。"
    ],
    disclaimer: "基金持仓为季报披露数据，实时估算会与基金实际组合存在偏差；内容仅用于信息展示，不构成投资建议。"
  };
}

function signedText(value, suffix = "%") {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${percent(value)}${suffix}`;
}

function buildMarketEvents(dist, boards, indexes, news) {
  const boardEvents = boards.filter(board => Number.isFinite(board.pct)).slice(0, 5).map((board) => {
    const direction = board.pct > 0 ? "走强" : board.pct < 0 ? "走弱" : "横盘";
    return {
      type: "板块",
      title: `${board.name}板块${direction} ${signedText(board.pct)}`,
      summary: `关联持仓占基金净值约 ${percent(board.weight)}%${Number.isFinite(board.amount) ? `，今日板块成交约 ${Math.round(board.amount / 1e8)} 亿元` : ''}。`,
      source: SOURCE.quote,
      time: new Date().toISOString(),
      url: null,
      matched: [board.name]
    };
  }).filter(Boolean);

  const indexEvents = indexes.slice(0, 3).map((item) => ({
    type: "大盘",
    title: `${item.name} ${signedText(item.pct)}`,
    summary: `指数点位 ${percent(item.price)}，成交额约 ${Math.round(item.amount / 1e8)} 亿元，用于观察风险偏好背景。`,
    source: SOURCE.quote,
    time: new Date().toISOString(),
    url: null,
    matched: [item.name]
  }));

  const newsEvents = news.map((item) => ({
    type: "资讯",
    ...item
  }));

  return [...boardEvents, ...indexEvents, ...newsEvents].slice(0, 10);
}

async function fetchKline(market, code, days = 100) {
  const primary = aiService.marketSource();
  const cacheKey = `kline:${primary}:${market}.${code}:${days}`;
  return cached(cacheKey, 60 * 1000, async () => {
    try {
      return primary === 'tencent' ? await fetchTencentKline(market, code, days) : await fetchEastmoneyKline(market, code, days);
    } catch (error) {
      safeLog("eastmoney kline", error);
      return primary === 'tencent' ? fetchEastmoneyKline(market, code, days) : fetchTencentKline(market, code, days);
    }
  });
}

async function fetchEastmoneyKline(market, code, days = 100) {
  const end = "20500101";
  const startYear = new Date().getFullYear() - 2;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market}.${code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=${startYear}0101&end=${end}`;
  const payload = await fetchJson(url, {
    headers: { Referer: "https://quote.eastmoney.com/" }
  });
  if (!Array.isArray(payload.data?.klines) || !payload.data.klines.length) throw new Error('Empty stock kline');
  const rows = payload.data.klines.slice(-days).map((line) => {
    const [date, open, close, high, low, volume, amount, amplitude, pct, change, turnover] = line.split(",");
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: Number(amount),
      amplitude: Number(amplitude),
      pct: Number(pct),
      change: Number(change),
      turnover: Number(turnover)
    };
  });
  return {
    name: payload.data?.name || code,
    code,
    market: Number(market),
    rows,
    source: SOURCE.kline,
    adjustment: 'qfq',
    updatedAt: new Date().toISOString()
  };
}

async function fetchTencentKline(market, code, days = 100) {
  const symbol = `${marketPrefix(market)}${code}`;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`;
  const payload = await fetchJson(url, {
    headers: {
      Referer: "https://gu.qq.com/",
      "User-Agent": "Mozilla/5.0 fund-162201-dashboard"
    }
  }, 12000);
  const data = payload.data?.[symbol] || {};
  const rawRows = data.qfqday || data.day || [];
  if (!rawRows.length) throw new Error('Empty backup kline');
  const rows = rawRows.slice(-days).map((row, index, all) => {
    const previousClose = index > 0 ? Number(all[index - 1][2]) : null;
    const close = Number(row[2]);
    const change = previousClose ? close - previousClose : 0;
    const pct = previousClose ? change / previousClose * 100 : 0;
    return {
      date: row[0],
      open: Number(row[1]),
      close,
      high: Number(row[3]),
      low: Number(row[4]),
      volume: Number(row[5]),
      amount: null,
      amplitude: null,
      pct,
      change,
      turnover: null
    };
  });
  return {
    name: data.qt?.[1] || code,
    code,
    market: Number(market),
    rows,
    source: "Tencent fqkline",
    adjustment: data.qfqday?.length ? 'qfq' : 'none',
    updatedAt: new Date().toISOString()
  };
}

async function buildDashboard(force = false, selectedCode) {
  const code = fundRegistry.resolve(selectedCode);
  let dashboardSnapshot = dashboards.get(code);
  if (!force && dashboardSnapshot && Date.now() - dashboardSnapshot.loadedAt < REFRESH_MINUTES * 60 * 1000) {
    return dashboardSnapshot.payload;
  }
  if (refreshing.has(code)) return refreshing.get(code);

  const dashboardRefreshing = (async () => {
    const revision = settingsRevision;
    try {
      const [estimate, disclosed] = await Promise.all([
        optional("fund estimate", () => fetchFundEstimate(code), null),
        optional('fund holdings', () => currentAndPreviousHoldings(code), null)
      ]);
      if (!disclosed && !estimate) throw new Error('基金数据源暂不可用');
      const { latest, previous } = disclosed || { latest: { holdings: [], title: '暂无可用股票持仓披露', date: null }, previous: null };
      const quotes = await optional("stock quotes", () => fetchQuotes(latest.holdings), []);
      const holdings = await industryService.enrich(mergeQuotes(latest.holdings, quotes));
      for (const holding of holdings) holding.quote.signalUsable = Number.isFinite(holding.quote.pct) && isQuoteFresh(holding.quote.quoteTime);
      const changes = compareHoldings(latest, previous);
      const dist = distribution(holdings);
      const [boards, indexes] = await Promise.all([
        optional("industry boards", () => fetchIndustryBoards(holdings), []),
        optional("market indexes", fetchMarketIndexes, [])
      ]);
      const news = [];
      const events = buildMarketEvents(dist, boards, indexes, news);
      const analysis = insight(holdings, dist, boards, estimate, news);

      const payload = {
        fund: {
          code,
          name: estimate?.name || fundRegistry.list().funds.find(f => f.code === code)?.name || code,
          navDate: estimate?.jzrq || null,
          nav: estimate?.dwjz ?? null,
          estimate: estimate?.gsz ?? null,
          estimatePct: estimate?.gszzl ?? null,
          estimateTime: estimate?.gztime || null,
          estimateSource: estimate?.estimateSource || null,
          estimateUrl: estimate?.estimateUrl || null,
          navSource: estimate?.navSource || null
        },
        report: {
          title: latest.title,
          date: latest.date,
          previousTitle: previous?.title || null,
          previousDate: previous?.date || null
        },
        holdings,
        changes,
        distribution: dist,
        boards,
        indexes,
        news,
        events,
        analysis,
        source: SOURCE,
        updatedAt: new Date().toISOString(),
        warning: !latest.holdings.length ? '该基金暂无可用股票持仓，股票调仓、行业分布与贡献估算暂不可用或不适用。' : null
      };
      if (!latest.holdings.length) { payload.analysis.quoteContribution = null; payload.analysis.stance = '数据不足'; payload.analysis.lines = [payload.warning]; }

      if (revision === settingsRevision) {
        dashboardSnapshot = { loadedAt: Date.now(), payload };
        dashboards.set(code, dashboardSnapshot);
        saveDashboard(payload);
      }
      return payload;
    } catch (error) {
      safeLog("dashboard refresh", error);
      const saved = dashboardSnapshot || loadSavedDashboard(code);
      if (saved?.payload) {
        const payload = {
          ...saved.payload,
          stale: true,
          warning: "实时数据暂时不可用，当前展示上一次成功缓存。"
        };
        if (revision === settingsRevision) dashboards.set(code, { loadedAt: Date.now(), payload });
        return payload;
      }
      return fallbackDashboard(error, code);
    }
  })();

  refreshing.set(code, dashboardRefreshing);
  try {
    return await dashboardRefreshing;
  } finally {
    refreshing.delete(code);
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = !hasValidAuth(req) && (url.pathname === "/" || url.pathname === "/index.html")
    ? "/login.html"
    : url.pathname;
  const safePath = decodeURIComponent(pathname === "/admin" ? "/admin.html" : pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    text(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      text(res, 404, "Not found");
      return;
    }
    text(res, 200, data, mimeType(filePath));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (await aiService.handle(req, res, url, hasValidAuth(req), json)) return;
    if (url.pathname === '/api/funds') {
      if (!hasValidAuth(req)) return json(res, 401, { error: '请先登录。' });
      return json(res, 200, fundRegistry.list());
    }

    if (url.pathname === "/api/health") {
      json(res, 200, { ok: true, fund: FUND_CODE, updatedAt: new Date().toISOString() });
      return;
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      if (String(body.password || "") === ACCESS_PASSWORD) {
        setAuthCookie(res);
        json(res, 200, { ok: true });
        return;
      }
      json(res, 401, { error: "验证失败。" });
      return;
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      clearAuthCookie(res);
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/logout") {
      clearAuthCookie(res);
      res.writeHead(302, { Location: "/login.html" });
      res.end();
      return;
    }

    if (url.pathname === "/api/dashboard") {
      if (!hasValidAuth(req)) {
        json(res, 401, { error: "请先登录。" });
        return;
      }
      json(res, 200, await buildDashboard(url.searchParams.get("refresh") === "1", url.searchParams.get('fund')));
      return;
    }

    if (url.pathname === "/api/debug/sources") {
      if (!hasValidAuth(req)) {
        json(res, 401, { error: "请先登录。" });
        return;
      }
      json(res, 200, await checkSources());
      return;
    }

    if (url.pathname === '/api/fund-intraday') {
      if (!hasValidAuth(req)) { json(res, 401, { error: '请先登录。' }); return; }
      const code = fundRegistry.resolve(url.searchParams.get('fund'));
      json(res, 200, await getFundIntraday(code));
      return;
    }

    if (url.pathname === '/api/fund-history') {
      if (!hasValidAuth(req)) { json(res, 401, { error: '请先登录。' }); return; }
      const code = fundRegistry.resolve(url.searchParams.get('fund'));
      json(res, 200, await getFundHistory(code));
      return;
    }

    if (url.pathname === "/api/kline") {
      if (!hasValidAuth(req)) {
        json(res, 401, { error: "请先登录。" });
        return;
      }
      const market = url.searchParams.get("market");
      const code = url.searchParams.get("code");
      const days = Number(url.searchParams.get("days") || 100);
      if (!/^[01]$/.test(market || "") || !/^\d{6}$/.test(code || "")) {
        json(res, 400, { error: "market 必须为 0/1，code 必须为 6 位股票代码" });
        return;
      }
      json(res, 200, await fetchKline(market, code, Math.min(Math.max(days, 30), 240)));
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    json(res, error.status || 500, {
      error: error.message,
      hint: "上游公开接口可能临时限流或不可用，请稍后重试。"
    });
  }
});

server.listen(PORT, () => {
  console.log(`Fund dashboard listening on http://localhost:${PORT}`);
  buildDashboard(true).catch((error) => console.warn("Initial refresh failed:", error.message));
  setInterval(async () => {
    for (const fund of fundRegistry.list().funds) {
      try { await buildDashboard(true, fund.code); }
      catch (error) { console.warn('Scheduled refresh failed:', error.message); }
    }
  }, REFRESH_MINUTES * 60 * 1000);
});
