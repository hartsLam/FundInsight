const RANGES = new Set(['1m', '3m', '6m', '1y', '3y', 'all', 'custom']);
const { SMA, RSI, MACD, BollingerBands } = require('technicalindicators');
const round = n => Number.isFinite(n) ? Number(n.toFixed(6)) : null;
function navIndicators(rows) {
  const values = rows.map(row => row.nav);
  const macd = MACD.calculate({ values, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).at(-1);
  const bands = BollingerBands.calculate({ values, period: 20, stdDev: 2 }).at(-1);
  return { basis: '完整日频单位净值，非复权；无成交量与日内OHLC', asOf: rows.at(-1)?.date || null, samples: rows.length,
    ma: Object.fromEntries([5, 10, 20, 60].map(period => [period, round(SMA.calculate({ values, period }).at(-1))])),
    rsi14: values.length >= 15 ? round(RSI.calculate({ values, period: 14 }).at(-1)) : null,
    macd: Number.isFinite(macd?.signal) ? { dif: round(macd.MACD), dea: round(macd.signal), histogram: round(2 * macd.histogram), convention: '2*(DIF-DEA), EMA12/26/9' } : null,
    boll20: bands ? { upper: round(bands.upper), middle: round(bands.middle), lower: round(bands.lower) } : null,
    latestNav: values.at(-1) ?? null,
    recentDividendEvents: rows.slice(-60).filter(row => row.dividend).map(row => ({ date: row.date, event: row.dividend })) };
}
function chartContext(value) {
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  let start = null, end = null;
  try { if (validDate(value?.start) && validDate(value?.end) && value.start <= value.end) { start = value.start; end = value.end; } } catch {}
  return { mode: value?.mode === 'history' ? 'history' : 'intraday', range: RANGES.has(value?.range) ? value.range : '1y', start, end };
}
function thin(rows, count = 240) {
  if (rows.length <= count) return rows;
  return Array.from({ length: count }, (_, i) => rows[Math.round(i * (rows.length - 1) / (count - 1))]);
}
function describeSeries(rows) {
  if (!rows.length) return { count: 0, first: null, last: null, low: null, high: null, points: [] };
  return { count: rows.length, first: rows[0], last: rows.at(-1),
    low: rows.reduce((a, b) => a.nav <= b.nav ? a : b), high: rows.reduce((a, b) => a.nav >= b.nav ? a : b),
    points: thin(rows), downsampled: rows.length > 240 };
}
function historyEvidence(payload, chart, requestedRange) {
  const all = payload.rows.filter(row => Number.isFinite(row.nav) && row.nav > 0);
  const range = RANGES.has(requestedRange) ? requestedRange : chart.range;
  const end = range === 'custom' && chart.end ? chart.end : all.at(-1)?.date;
  let start = all[0]?.date;
  if (range === 'custom' && chart.start) start = chart.start;
  else if (range !== 'all' && end) {
    const count = { '1m': 1, '3m': 3, '6m': 6, '1y': 12, '3y': 36 }[range] || 12;
    const date = new Date(`${end}T00:00:00Z`), day = date.getUTCDate();
    date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - count);
    date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
    start = date.toISOString().slice(0, 10);
  }
  const rows = all.filter(row => row.date >= start && row.date <= end);
  return { id: 'F1', type: 'historical-nav', code: payload.code, range, start, end, source: payload.source,
    sourceUrl: payload.sourceUrl, stale: payload.stale, updatedAt: payload.updatedAt, ...describeSeries(rows),
    navChangePct: rows.length > 1 ? (rows.at(-1).nav / rows[0].nav - 1) * 100 : null,
    indicators: navIndicators(all.filter(row => row.date <= end)),
    note: '单位净值变动不是复权收益率，分红与拆分会影响曲线；points可能等距抽样，极值统计基于完整范围。' };
}
function intradayEvidence(payload) {
  const suspects = payload.rows.filter(row => row.quality === 'suspect');
  return { id: 'F2', type: 'intraday-estimate', code: payload.code, source: payload.source, sourceUrl: payload.sourceUrl,
    referenceDate: payload.referenceDate, today: payload.today, dateBasis: payload.dateBasis, baseline: payload.baseline,
    mode: payload.mode, warning: payload.warning, updatedAt: payload.updatedAt, ...describeSeries(payload.rows.filter(row => row.quality !== 'suspect')),
    rawCount: payload.rows.length, suspectCount: suspects.length, suspectPoints: thin(suspects),
    isToday: payload.referenceDate === payload.today && !!payload.referenceDate,
    note: '估算净值不是公布净值；日期仅按dateBasis核验，未知或旧日期不能称为今日。点间缺失不代表行情平稳。统计已排除待核实跳变点，原值单列于suspectPoints；这是启发式提示，不证明源值错误，不可据此断言真实暴跌或反弹。' };
}
module.exports = { chartContext, historyEvidence, intradayEvidence };
