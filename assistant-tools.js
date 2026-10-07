const { SMA, RSI, MACD, BollingerBands } = require('technicalindicators');

const round = value => Number.isFinite(value) ? Number(value.toFixed(4)) : null;
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

function technicalSnapshot(payload, stock, now = Date.now()) {
  if (payload?.code !== stock.code || Number(payload.market) !== Number(stock.market)) throw Error('K线证券标识不匹配');
  const rows = payload.rows;
  if (!Array.isArray(rows) || rows.length < 2) throw Error('有效K线不足两根');
  let previous = '';
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date <= previous ||
      !['open', 'close', 'high', 'low'].every(key => numeric(row[key]) && Number(row[key]) > 0) ||
      Number(row.high) < Math.max(Number(row.open), Number(row.close), Number(row.low)) ||
      Number(row.low) > Math.min(Number(row.open), Number(row.close))) throw Error('K线日期或价格异常');
    previous = row.date;
  }
  const closes = rows.map(row => Number(row.close));
  const latest = rows.at(-1);
  const ma = Object.fromEntries([5, 10, 20, 60].map(period => [period, round(SMA.calculate({ period, values: closes }).at(-1))]));
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).at(-1);
  const bands = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes }).at(-1);
  const prev20 = rows.slice(-21, -1);
  const prevVolumes = rows.slice(-6, -1).map(row => row.volume);
  const volumeAverage = prevVolumes.length === 5 && prevVolumes.every(value => numeric(value) && Number(value) >= 0)
    ? prevVolumes.reduce((sum, value) => sum + Number(value), 0) / 5 : null;
  const warnings = [];
  if (rows.length < 60) warnings.push('历史样本不足60根，部分指标不可用。');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (latest.date === today) warnings.push('最新日线可能包含当日尚未收盘的数据，量价和指标会变化。');
  if (now - Date.parse(`${latest.date}T15:00:00+08:00`) > 7 * 86400000) warnings.push('最后一根K线距当前已超过7天，可能停牌、休市或数据滞后，不能当作实时走势。');
  if (payload.adjustment !== 'qfq') warnings.push('本次来源未提供前复权序列，按未复权或未确认口径展示，不与其他复权口径直接比较。');
  return {
    code: stock.code, name: stock.name || payload.name || stock.code, market: stock.market,
    source: payload.source, fetchedAt: payload.updatedAt, lastDate: latest.date,
    period: '日线', adjustment: payload.adjustment || 'unknown', bars: rows.length,
    firstDate: rows[0].date, latest: { ...latest, close: Number(latest.close) },
    ma, rsi14: closes.length >= 15 ? round(RSI.calculate({ period: 14, values: closes }).at(-1)) : null,
    macd: macd && numeric(macd.signal) ? { dif: round(macd.MACD), dea: round(macd.signal), histogram: round(2 * macd.histogram), convention: '2*(DIF-DEA), EMA12/26/9' } : null,
    boll20: bands ? { upper: round(bands.upper), middle: round(bands.middle), lower: round(bands.lower) } : null,
    changePct: Object.fromEntries([5, 20, 60].map(period => [period, closes.length > period ? round((closes.at(-1) / closes.at(-1 - period) - 1) * 100) : null])),
    previous20Range: prev20.length === 20 ? { low: Math.min(...prev20.map(row => Number(row.low))), high: Math.max(...prev20.map(row => Number(row.high))) } : null,
    volumeVsPrevious5: volumeAverage > 0 && numeric(latest.volume) && Number(latest.volume) >= 0 ? round(Number(latest.volume) / volumeAverage) : null,
    recentBars: rows.slice(-20).map(({ date, open, high, low, close, volume }) => ({ date, open, high, low, close, volume })), warnings
  };
}

function permittedStocks(question, history, holdings, fundCode) {
  const stocks = new Map(holdings.filter(item => /^[036]\d{5}$/.test(item.code) && [0, 1].includes(Number(item.market)))
    .map(item => [item.code, { code: item.code, name: item.name, market: Number(item.market) }]));
  const userText = [question, ...history.filter(turn => turn.role === 'user').map(turn => turn.content)].join(' ');
  for (const code of userText.match(/(?<!\d)[036]\d{5}(?!\d)/g) || []) {
    if (code !== fundCode && !stocks.has(code)) stocks.set(code, { code, market: code.startsWith('6') ? 1 : 0 });
  }
  return stocks;
}

function normalizePlan(plan, stocks, fundCode) {
  if (!plan || !['technical', 'holdings', 'news', 'knowledge', 'mixed', 'fund', 'web'].includes(plan.intent) || !Array.isArray(plan.stockCodes)) throw Error('Invalid assistant plan');
  const requested = [...new Set(plan.stockCodes.map(String))];
  const stockCodes = ['technical', 'mixed'].includes(plan.intent) ? requested.filter(code => code !== fundCode && stocks.has(code)).slice(0, 3) : [];
  return { intent: plan.intent, stockCodes, needNews: plan.intent !== 'knowledge' && (plan.needNews === true || plan.intent === 'news'),
    needFundHistory: plan.needFundHistory === true, needFundIntraday: plan.needFundIntraday === true,
    historyRange: ['1m', '3m', '6m', '1y', '3y', 'all', 'custom'].includes(plan.historyRange) ? plan.historyRange : null,
    searchQueries: Array.isArray(plan.searchQueries) ? [...new Set(plan.searchQueries.filter(q => typeof q === 'string' && q.trim()).map(q => q.trim().slice(0, 180)))].slice(0, 2) : [],
    clarification: typeof plan.clarification === 'string' ? plan.clarification.slice(0, 200) : '',
    rejectedTargets: requested.filter(code => !stockCodes.includes(code)) };
}

function fallbackPlan(question, stocks) {
  const fund = /基金|净值|估值/.test(question) && /走势|盘中|曲线|趋势|涨跌|分析/.test(question);
  const technical = /K\s*线|均线|MACD|RSI|布林|量价|支撑|压力位|技术面|走势|kline/i.test(question);
  return { intent: fund ? 'fund' : technical ? 'technical' : 'holdings', needNews: /新闻|消息|事件|政策/.test(question),
    needFundIntraday: fund && /盘中|估值/.test(question), needFundHistory: fund && !/盘中|估值/.test(question), historyRange: null, searchQueries: [],
    stockCodes: technical && !fund ? [...stocks.values()].filter(item => question.includes(item.code) || (item.name && question.includes(item.name))).slice(0, 3).map(item => item.code) : [],
    clarification: '', rejectedTargets: [] };
}

module.exports = { technicalSnapshot, permittedStocks, normalizePlan, fallbackPlan };
