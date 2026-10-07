(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('fundCanvas');
  let fund, history = null, rows = [], range = '1y', hover = null, message = '正在读取历史净值…', requestId = 0;
  let mode = 'intraday', intraday = null;
  const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12, '3y': 36 };
  const buttons = [...$('fundRanges').querySelectorAll('button')];
  const iso = date => date.toISOString().slice(0, 10);
  function subtractMonths(value, count) {
    const date = new Date(`${value}T00:00:00Z`);
    const day = date.getUTCDate();
    date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - count);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
    return iso(date);
  }
  function summary() {
    const row = rows[hover ?? rows.length - 1];
    $('fundChartValue').textContent = row ? row.nav.toFixed(4) : '--';
    $('fundChartDate').textContent = row ? `${mode === 'intraday' ? row.time : row.date} · ${mode === 'intraday' ? '估算净值' : '单位净值'}${Number.isFinite(row.changePct) ? ` · ${row.changePct > 0 ? '+' : ''}${row.changePct.toFixed(2)}%` : ''}` : mode === 'intraday' ? '估算净值' : '单位净值';
    if (row?.quality === 'suspect') $('fundChartDate').textContent += ' · 跳变待核实（空心点与灰色虚线，来源原值）';
  }
  function applyIntraday() {
    rows = intraday?.rows || []; hover = null;
    const date = intraday?.referenceDate;
    const period = !date ? '日期待核实' : date === intraday.today ? `${date} 今日估值` : `${date} 最近参考交易日估值（非今日）`;
    message = rows.length ? '' : '暂无可用盘中估值点';
    $('chartTitle').textContent = `${fund.name} · 盘中估值`;
    $('fundChartStatus').textContent = rows.length ? `${period} · ${rows.length} 个${intraday.mode === 'sampled' ? '采样' : '分时'}点${rows.length === 1 ? ' · 尚不足以形成曲线' : ''}` : message;
    $('fundChartKind').textContent = '估算净值 · 非基金公司公布净值';
    $('fundChartSource').textContent = '新浪估值来源';
    $('fundChartSource').href = `https://finance.sina.com.cn/fund/quotes/${fund.code}/bc.shtml`;
    $('fundChartNotice').textContent = `${intraday.warning} ${intraday.baseline ? `涨跌基准：${intraday.baseline.date} 单位净值 ${intraday.baseline.nav.toFixed(4)}。` : ''}估值仅供参考，以最终公布净值为准。`;
    if (rows.some(row => row.quality === 'suspect')) $('fundChartNotice').textContent += ' 灰色空心点为待核实原值，灰色虚线仅连接相邻记录，不代表已确认走势；彩色实线为未被标记的估值点连线。';
    canvas.setAttribute('aria-label', `${fund.name}盘中估算净值，${period}，${rows.length}个记录`);
    summary(); draw();
  }
  function applyRange() {
    if (mode !== 'history') return;
    if (!history) return;
    const all = history.rows;
    const end = range === 'custom' ? $('fundEndDate').value : all.at(-1).date;
    const start = range === 'custom' ? $('fundStartDate').value : range === 'all' ? all[0].date : [all[0].date, subtractMonths(end, months[range])].sort().at(-1);
    if (!start || !end || start > end) { $('fundChartStatus').textContent = '开始日期不能晚于结束日期。'; return; }
    rows = all.filter(row => row.date >= start && row.date <= end);
    if (range !== 'custom') { $('fundStartDate').value = start; $('fundEndDate').value = end; }
    hover = null;
    $('chartTitle').textContent = `${fund.name} · 净值走势`;
    $('fundChartKind').textContent = '单位净值 · 日频 · 非复权';
    $('fundChartSource').textContent = '历史净值来源';
    $('fundChartSource').href = `https://fundf10.eastmoney.com/jjjz_${fund.code}.html`;
    $('fundChartNotice').textContent = '分红、拆分会影响单位净值，不等同于投资收益率。';
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.range === range)));
    message = rows.length ? '' : '所选日期范围没有已公布净值。';
    $('fundChartStatus').textContent = rows.length ? `${rows[0].date} 至 ${rows.at(-1).date} · ${rows.length} 个净值记录${history.stale ? ' · 历史缓存，更新暂不可用' : ''}` : message;
    canvas.setAttribute('aria-label', `${fund.name}单位净值走势，${start}至${end}，${rows.length}条记录`);
    summary(); draw();
  }
  async function load() {
    if (!fund) return;
    const id = ++requestId;
    const requestedMode = mode;
    message = mode === 'intraday' ? '正在读取盘中估值…' : '正在读取历史净值…'; $('fundChartStatus').textContent = message;
    if (!rows.length) draw();
    try {
      const response = await fetch(`/api/fund-${requestedMode === 'intraday' ? 'intraday' : 'history'}?fund=${fund.code}`, { cache: 'no-store' });
      if (response.status === 401) { location.href = '/login.html'; return; }
      const data = await response.json();
      if (!response.ok) throw Error(data.error || '历史净值暂不可用');
      if (id !== requestId) return;
      if (data.code !== fund.code || !Array.isArray(data.rows)) throw Error('基金数据格式异常');
      if (requestedMode === 'intraday') { intraday = data; applyIntraday(); return; }
      if (!data.rows.length) throw Error('暂无可用历史净值');
      history = data;
      $('chartTitle').textContent = `${fund.name} · 净值走势`;
      $('fundChartSource').href = `https://fundf10.eastmoney.com/jjjz_${fund.code}.html`;
      for (const input of [$('fundStartDate'), $('fundEndDate')]) { input.min = data.rows[0].date; input.max = data.rows.at(-1).date; }
      applyRange();
    } catch (error) {
      if (id !== requestId) return;
      message = error.message;
      $('fundChartStatus').textContent = `${message}${rows.length ? '（保留上次曲线）' : ''}`;
      draw();
    }
  }
  function draw() {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width, height = rect.height, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const palette = getComputedStyle(document.documentElement);
    const color = (name, fallback) => palette.getPropertyValue(name).trim() || fallback;
    const line = mode === 'intraday' ? color('--chart-line', '#247d6b') : color('--chart-history', '#537ca3');
    ctx.font = '12px sans-serif';
    if (!rows.length) {
      ctx.fillStyle = color('--chart-label', '#586e62');
      ctx.fillText(message.length > 24 ? '历史净值暂不可用，请查看下方提示。' : message, 20, 40);
      return;
    }
    const left = 60, right = 18, top = 22, bottom = 34;
    const w = width - left - right, h = height - top - bottom;
    const values = rows.map(row => row.nav);
    if (mode === 'intraday' && intraday?.baseline) values.push(intraday.baseline.nav);
    let low = Math.min(...values), high = Math.max(...values);
    const margin = (high - low || high * 0.02 || 0.01) * 0.08;
    low -= margin; high += margin;
    const endMinute = mode === 'intraday' ? Math.max(900, minute(rows.at(-1).time)) : null;
    const x = i => left + (mode === 'intraday' ? (minute(rows[i].time) - 570) / (endMinute - 570) * w : rows.length === 1 ? w / 2 : i / (rows.length - 1) * w);
    const y = nav => top + (high - nav) / (high - low) * h;
    ctx.lineWidth = 1; ctx.strokeStyle = color('--chart-grid', '#bac9bb'); ctx.fillStyle = color('--chart-label', '#586e62');
    for (let i = 0; i <= 4; i++) {
      const yy = top + h * i / 4;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width - right, yy); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText((high - (high - low) * i / 4).toFixed(4), left - 9, yy + 4);
    }
    ctx.textAlign = 'left'; ctx.fillText(mode === 'intraday' ? '09:30' : rows[0].date, left, height - 10);
    if (rows.length > 1 || mode === 'intraday') { ctx.textAlign = 'right'; ctx.fillText(mode === 'intraday' ? `${Math.floor(endMinute / 60)}:${String(endMinute % 60).padStart(2, '0')}` : rows.at(-1).date, width - right, height - 10); }
    if (mode === 'intraday' && intraday?.baseline) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = '#75847e'; ctx.beginPath(); ctx.moveTo(left, y(intraday.baseline.nav)); ctx.lineTo(width - right, y(intraday.baseline.nav)); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.strokeStyle = line; ctx.lineWidth = 2;
    ctx.beginPath();
    rows.forEach((row, i) => {
      if (row.quality === 'suspect') return;
      const connected = i && rows[i - 1].quality !== 'suspect' && !(mode === 'intraday' && minute(row.time) - minute(rows[i - 1].time) > 10);
      if (connected) ctx.lineTo(x(i), y(row.nav)); else ctx.moveTo(x(i), y(row.nav));
    });
    ctx.stroke();
    ctx.strokeStyle = '#929292'; ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]); ctx.beginPath();
    rows.forEach((row, i) => {
      const previous = rows[i - 1];
      if (!previous || (row.quality !== 'suspect' && previous.quality !== 'suspect')) return;
      if (mode === 'intraday' && minute(row.time) - minute(previous.time) > 10) return;
      ctx.moveTo(x(i - 1), y(previous.nav)); ctx.lineTo(x(i), y(row.nav));
    });
    ctx.stroke(); ctx.setLineDash([]);
    rows.forEach((row, i) => {
      if (row.quality !== 'suspect') return;
      ctx.beginPath(); ctx.arc(x(i), y(row.nav), 3.5, 0, Math.PI * 2); ctx.stroke();
    });
    const index = hover ?? rows.length - 1;
    if (hover !== null) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = '#75847e'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x(index), top); ctx.lineTo(x(index), height - bottom); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = line; ctx.beginPath(); ctx.arc(x(index), y(rows[index].nav), 4, 0, Math.PI * 2);
    if (rows[index].quality === 'suspect') { ctx.strokeStyle = '#929292'; ctx.stroke(); } else ctx.fill();
  }
  function updateControls() {
    $('fundRanges').hidden = mode !== 'history';
    $('fundChartModes').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.mode === mode)));
    buttons.forEach(item => item.setAttribute('aria-pressed', String(mode === 'history' && item.dataset.range === range)));
    $('fundDateForm').hidden = mode !== 'history' || range !== 'custom';
  }
  function selectMode(nextMode) {
    mode = nextMode; requestId++;
    updateControls();
    rows = []; hover = null; message = '正在读取基金数据…'; summary(); draw();
    if (mode === 'history' && history) applyRange();
    else if (mode === 'intraday' && intraday) applyIntraday();
    load();
  }
  for (const button of $('fundChartModes').querySelectorAll('button')) button.addEventListener('click', () => selectMode(button.dataset.mode));
  for (const button of buttons) button.addEventListener('click', () => {
    range = button.dataset.range;
    if (mode !== 'history') { selectMode('history'); return; }
    updateControls();
    applyRange();
  });
  $('fundDateForm').addEventListener('submit', event => { event.preventDefault(); applyRange(); });
  canvas.addEventListener('pointermove', event => {
    if (!rows.length) return;
    const rect = canvas.getBoundingClientRect();
    hover = Math.max(0, Math.min(rows.length - 1, Math.round((event.clientX - rect.left - 60) / (rect.width - 78) * (rows.length - 1))));
    if (mode === 'intraday') {
      const target = 570 + (event.clientX - rect.left - 60) / (rect.width - 78) * (Math.max(900, minute(rows.at(-1).time)) - 570);
      hover = rows.reduce((best, row, i) => Math.abs(minute(row.time) - target) < Math.abs(minute(rows[best].time) - target) ? i : best, 0);
    }
    summary(); draw();
  });
  canvas.addEventListener('pointerleave', () => { hover = null; summary(); draw(); });
  canvas.addEventListener('keydown', event => {
    if (!rows.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    hover = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, (hover ?? rows.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)));
    summary(); draw();
  });
  new ResizeObserver(draw).observe(canvas);
  window.addEventListener('fund-theme-change', draw);
  window.refreshFundChart = load;
  window.getFundChartContext = () => ({ mode, range, start: $('fundStartDate').value, end: $('fundEndDate').value });
  setInterval(() => { if (mode === 'intraday' && !document.hidden) load(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (mode === 'intraday' && !document.hidden) load(); });
  window.fundReady.then(selected => { fund = selected; return load(); }).catch(error => { message = error.message; $('fundChartStatus').textContent = message; draw(); });
})();
