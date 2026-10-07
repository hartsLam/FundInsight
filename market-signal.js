const { boardSignal } = require('./industry-boards');
const { marketSession } = require('./trading-calendar');
const round = value => Number(value.toFixed(2));
const china = time => new Date(time + 8 * 3600000).toISOString();

function quoteTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  let text = value;
  if (/^\d{14}$/.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12)}`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)) text = text.replace(' ', 'T') + '+08:00';
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const stamp = Date.parse(text);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

function isQuoteFresh(value, now = Date.now()) {
  const normalized = quoteTime(value), stamp = normalized ? Date.parse(normalized) : NaN;
  if (!Number.isFinite(stamp) || stamp > now + 120000) return false;
  const session = marketSession(now);
  if (!session.known) return false;
  const quoteLocal = china(stamp);
  const quoteMinutes = Number(quoteLocal.slice(11, 13)) * 60 + Number(quoteLocal.slice(14, 16));
  return quoteLocal.slice(0, 10) === session.referenceDate && quoteMinutes >= session.anchor - 20;
}

async function quotesWithFallback(holdings, primary, backup, now = Date.now(), additional = []) {
  let first = [];
  try { first = await primary(); } catch {}
  const key = item => `${item.market}.${item.code}`;
  const selected = new Map(first.map(row => [key(row), row]));
  const usable = row => Number.isFinite(row?.pct) && isQuoteFresh(row.quoteTime, now);
  for (const load of [backup, ...additional]) {
    if (!holdings.some(holding => !usable(selected.get(key(holding))))) break;
    try {
      for (const row of await load()) {
        const old = selected.get(key(row));
        if (!old || usable(row) && (!usable(old) || Date.parse(row.quoteTime) > Date.parse(old.quoteTime))) selected.set(key(row), row);
      }
    } catch {}
  }
  return holdings.map(item => selected.get(key(item))).filter(Boolean);
}

function shortTermSignal(holdings, boards, estimate, now = Date.now()) {
  const session = marketSession(now);
  const totalWeight = holdings.reduce((sum, item) => sum + Math.max(0, item.weight || 0), 0);
  const valid = holdings.filter(item => item.weight > 0 && Number.isFinite(item.quote?.pct) && isQuoteFresh(item.quote.quoteTime, now));
  const weight = valid.reduce((sum, item) => sum + item.weight, 0);
  const coverage = totalWeight > 0 ? weight / totalWeight * 100 : 0;
  const contribution = weight > 0 ? valid.reduce((sum, item) => sum + item.weight * item.quote.pct / 100, 0) : null;
  const average = weight > 0 ? contribution / weight * 100 : null;
  const up = valid.filter(item => item.quote.pct > 0).length, down = valid.filter(item => item.quote.pct < 0).length;
  const breadth = valid.length ? up / valid.length * 100 : null;
  const freshEstimate = Number.isFinite(estimate?.gszzl) && isQuoteFresh(estimate.gztime, now);
  const freshBoards = boards.filter(board => isQuoteFresh(board.quoteTime, now));
  const board = boardSignal(holdings, freshBoards, freshEstimate ? estimate.gszzl : contribution);
  const sufficient = coverage >= 70 && valid.length >= Math.min(3, holdings.length) && totalWeight > 0;
  const common = { ...board, session, quoteCoverage: round(coverage), validQuoteCount: valid.length, totalQuoteCount: holdings.length,
    quoteContribution: contribution === null ? null : round(contribution), holdingAverage: average === null ? null : round(average), breadth: breadth === null ? null : round(breadth),
    asOf: valid.length ? valid.map(item => item.quote.quoteTime).sort()[0] : null,
    sources: [...new Set(valid.map(item => item.quote.quoteSource).filter(Boolean))] };
  if (!sufficient) return { ...common, stance: '数据不足', basis: 'unavailable', label: '行情待补全',
    reason: `${session.known ? `所需行情日期 ${session.referenceDate}。` : '交易日历待更新，暂不确认行情有效期。'}有效且时间可核验的行情 ${valid.length}/${holdings.length} 只，覆盖披露重仓权重 ${round(coverage)}%；需覆盖至少 70% 且至少 ${Math.min(3, holdings.length)} 只。缺失、过期或时间未知的行情不参与判断。` };
  if (board.stance !== '数据不足') {
    const pressure = freshEstimate ? estimate.gszzl : contribution;
    const inputLabel = freshEstimate ? '同日有效估值涨跌' : '披露持仓涨跌贡献';
    const rule = board.stance === '偏强' ? '两项分别高于 +1% 与 +0.8 个百分点，因此判断偏强。'
      : board.stance === '承压' ? '两项分别低于 -1% 与 -0.8 个百分点，因此判断承压。'
      : '两项未同时达到偏强或承压条件，暂为中性观察（偏强需分别高于 +1% 与 +0.8 个百分点；承压需分别低于 -1% 与 -0.8 个百分点）。';
    return { ...common, basis: 'combined', label: '板块与持仓参考',
      reason: `${session.label}，行情交易日 ${session.referenceDate}。${inputLabel} ${round(pressure)}%，板块按披露持仓权重加权贡献 ${board.boardMomentum} 个百分点。${rule}个股行情覆盖 ${round(coverage)}%，板块覆盖 ${board.boardCoverage}%，均以披露重仓权重为基数；阈值按计算原值判断。` };
  }
  let stance = '分化';
  if (average > 0.5 && up / valid.length >= 0.6) stance = '偏强';
  if (average < -0.5 && down / valid.length >= 0.6) stance = '承压';
  return { ...common, stance, basis: 'holdings', label: '持仓参考',
    reason: `${session.label}，行情交易日 ${session.referenceDate}。缺少足够的有效板块行情，暂按披露重仓判断：有效行情覆盖 ${round(coverage)}%，加权平均涨跌 ${round(average)}%，上涨 ${up} 只、下跌 ${down} 只。缺少板块验证，不代表基金实际收益或后续走势。` };
}

module.exports = { quoteTime, isQuoteFresh, quotesWithFallback, shortTermSignal };
