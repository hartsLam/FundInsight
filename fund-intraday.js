const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSina } = require('./fund-value');

const chinaDate = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

function flagIntradayJumps(rows) {
  const median = values => { const sorted = values.slice().sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
  const session = time => minute(time) < 720 ? 'am' : 'pm';
  return rows.map((row, i) => {
    const before = rows[i - 1], after = rows[i + 1];
    if (!before || !after || session(before.time) !== session(after.time) || minute(row.time) - minute(before.time) > 6 || minute(after.time) - minute(row.time) > 6) return row;
    const incoming = row.nav - before.nav, outgoing = after.nav - row.nav;
    if (incoming * outgoing >= 0) return row;
    const jump = Math.min(Math.abs(incoming), Math.abs(outgoing));
    if (jump / row.nav < 0.005 || Math.abs(after.nav - before.nav) > jump * 0.35) return row;
    const neighbors = rows.slice(Math.max(0, i - 3), i + 4).filter(point => point !== row && session(point.time) === session(row.time) && Math.abs(minute(point.time) - minute(row.time)) <= 12).map(point => point.nav);
    if (neighbors.length < 4) return row;
    const center = median(neighbors), deviation = median(neighbors.map(value => Math.abs(value - center)));
    // A local reversal is only suspect, never proof that the upstream value is wrong.
    if (Math.abs(row.nav - center) < Math.max(center * 0.005, deviation * 4)) return row;
    return { ...row, quality: 'suspect', qualityReason: '短时跳变后快速回归，来源数据待核实' };
  });
}

function parseIntraday(payload, snapshot, history = [], now = Date.now(), known = null) {
  const data = payload?.result?.data;
  if (Number(payload?.result?.status?.code) !== 0 || typeof data?.detail !== 'string') throw Error('分时估值暂不可用');
  const parts = data.detail.split(',');
  if (!parts.length || parts.length % 2 !== 0 || parts.length > 4000) throw Error('分时估值格式异常');
  const points = new Map();
  for (let i = 0; i < parts.length; i += 2) {
    const time = parts[i].trim(), nav = Number(parts[i + 1]);
    if (!/^\d{2}:\d{2}$/.test(time) || minute(time) < 570 || minute(time) > 990 || Number(time.slice(3)) > 59 || !Number.isFinite(nav) || nav <= 0) continue;
    points.set(time, { time, nav });
  }
  const rows = [...points.values()].sort((a, b) => a.time.localeCompare(b.time));
  if (!rows.length) throw Error('暂无有效分时估值点');
  const last = rows.at(-1);
  const stamp = snapshot?.gztime || '';
  const datedSnapshot = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp) && Number.isFinite(snapshot.gsz) &&
    minute(last.time) <= minute(stamp.slice(11)) &&
    stamp.slice(0, 10) <= chinaDate(now) && Date.parse(stamp.replace(' ', 'T') + '+08:00') <= now + 120000;
  const priorNav = date => history.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.date < date && Number.isFinite(row.nav) && row.nav > 0).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const previousForSnapshot = datedSnapshot ? priorNav(stamp.slice(0, 10)) : null;
  const sameNav = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000051;
  const matched = datedSnapshot && sameNav(last.nav, snapshot.gsz);
  // A post-close revision is not a date change. Require all three prior-NAV baselines
  // to agree, a complete close-period curve and a bounded (0.1%) revision.
  const revised = datedSnapshot && rows.length >= 20 && minute(last.time) >= 900 && minute(last.time) <= 910 &&
    sameNav(Number(data.yes), previousForSnapshot?.nav) && sameNav(snapshot.previousNav, previousForSnapshot?.nav) &&
    Math.abs(last.nav / snapshot.gsz - 1) <= 0.001;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const remembered = known?.fingerprint === fingerprint && /^\d{4}-\d{2}-\d{2}$/.test(known.date) &&
    known.date <= chinaDate(now) && ['snapshot-match', 'snapshot-baseline'].includes(known.basis);
  const referenceDate = remembered ? known.date : matched || revised ? stamp.slice(0, 10) : null;
  const dateBasis = remembered ? known.basis : matched ? 'snapshot-match' : revised ? 'snapshot-baseline' : 'unknown';
  // Provider's `yes` can roll forward after close. Use a dated prior official NAV instead.
  const previous = referenceDate ? priorNav(referenceDate) : null;
  const checked = flagIntradayJumps(rows);
  const suspectCount = checked.filter(row => row.quality === 'suspect').length;
  return { rows: checked.map(row => ({ ...row, changePct: previous ? (row.nav / previous.nav - 1) * 100 : null })),
    quality: { suspectCount, method: 'isolated-reversal-v1' },
    referenceDate, dateBasis, fingerprint, today: chinaDate(now),
    baseline: previous ? { date: previous.date, nav: previous.nav } : null,
    warning: referenceDate ? dateBasis === 'snapshot-baseline' ? '交易日期按同源快照与前日净值交叉参考；收盘后的估值修订可能与曲线末值略有不同。' : '交易日期参考同源估值快照，分时接口未直接提供日期。' : '分时日期尚未核实，不作为今日走势；涨跌幅暂不计算。' };
}

function createIntradayService({ dataDir, fetchJson, fetchBytes, getHistory, now = Date.now }) {
  const cache = new Map(), pending = new Map();
  function sample(code, snapshot) {
    if (!snapshot || !Number.isFinite(snapshot.gsz) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(snapshot.gztime || '')) return [];
    const date = snapshot.gztime.slice(0, 10);
    if (date > chinaDate(now())) return [];
    const file = path.join(dataDir, `intraday-samples-${code}.json`);
    let saved = { date, rows: [] };
    try { const old = JSON.parse(fs.readFileSync(file, 'utf8')); if (old.date === date && Array.isArray(old.rows)) saved = old; } catch {}
    const point = { time: snapshot.gztime.slice(11, 16), nav: snapshot.gsz, changePct: snapshot.gszzl };
    saved.rows = saved.rows.filter(row => row.time !== point.time);
    saved.rows.push(point); saved.rows.sort((a, b) => a.time.localeCompare(b.time)); saved.rows = saved.rows.slice(-500);
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); } catch { console.warn('Intraday sample persistence failed'); }
    return saved.rows;
  }
  return async function get(code) {
    if (!/^\d{6}$/.test(code)) throw Error('基金代码无效');
    const old = cache.get(code);
    if (old && now() - old.at < 60000 && old.value.today === chinaDate(now())) return old.value;
    if (pending.has(code)) return pending.get(code);
    const task = (async () => {
      let snapshot = null, payload = null, history = [];
      try { const bytes = await fetchBytes(`https://hq.sinajs.cn/?_=${now()}&list=fu_${code}`, { headers: { Referer: 'https://finance.sina.com.cn/' } }, 8000); snapshot = parseSina(new TextDecoder('gbk').decode(bytes), code); } catch {}
      const samples = sample(code, snapshot);
      try { payload = await fetchJson(`https://app.xincai.com/fund/api/openapi.php/XinCaiFundService.getFundYuCeNav?symbol=${code}`, { headers: { Referer: 'https://finance.sina.com.cn/' } }, 8000); } catch {}
      try { history = (await getHistory(code)).rows; } catch {}
      let value;
      try {
        const dateFile = path.join(dataDir, `intraday-date-${code}.json`);
        let known = null;
        try { known = JSON.parse(fs.readFileSync(dateFile, 'utf8')); } catch {}
        value = { ...parseIntraday(payload, snapshot, history, now(), known), mode: 'provider-series' };
        if (value.referenceDate) {
          try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(`${dateFile}.tmp`, JSON.stringify({ fingerprint: value.fingerprint, date: value.referenceDate, basis: value.dateBasis }), { mode: 0o600 });
            fs.renameSync(`${dateFile}.tmp`, dateFile);
          } catch { console.warn('Intraday date persistence failed'); }
        }
      }
      catch {
        value = { rows: samples, referenceDate: samples.length ? snapshot.gztime.slice(0, 10) : null, today: chinaDate(now()), dateBasis: samples.length ? 'snapshot-timestamp' : 'unknown', baseline: null,
          mode: 'sampled', warning: samples.length ? '分时源暂不可用，仅展示本服务实际采集的估值点；未采集的时段不补造。' : '尚未取得可用分时估值，请稍后刷新。' };
      }
      value = { ...value, code, source: '新浪财经估算', sourceUrl: `https://finance.sina.com.cn/fund/quotes/${code}/bc.shtml`, updatedAt: new Date(now()).toISOString() };
      if (value.quality?.suspectCount) value.warning += ` 检出 ${value.quality.suspectCount} 个待核实跳变点，原值保留；不代表基金实际急跌或急涨。`;
      cache.set(code, { at: now(), value });
      return value;
    })();
    pending.set(code, task);
    try { return await task; } finally { pending.delete(code); }
  };
}

module.exports = { parseIntraday, createIntradayService, flagIntradayJumps };
