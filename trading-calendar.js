// Exchange holidays, not the civil workday calendar: makeup weekends never open.
const calendars = {
  2025: { source: 'https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20241223_10767110.shtml',
    closed: [['01-01', '01-01'], ['01-28', '02-04'], ['04-04', '04-06'], ['05-01', '05-05'], ['05-31', '06-02'], ['10-01', '10-08']] },
  2026: { source: 'https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml',
    closed: [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']] }
};

function isTradingDate(date) {
  const calendar = calendars[date.slice(0, 4)];
  if (!calendar) return null;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const mmdd = date.slice(5);
  return ![0, 6].includes(day) && !calendar.closed.some(([start, end]) => mmdd >= start && mmdd <= end);
}

function marketSession(now = Date.now()) {
  const local = new Date(now + 8 * 3600000).toISOString();
  const today = local.slice(0, 10), minutes = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  const open = isTradingDate(today);
  if (open === null) return { known: false, phase: 'unknown', referenceDate: null, label: '交易日历待更新' };
  let referenceDate = today;
  const phase = !open ? 'closed' : minutes < 570 ? 'preopen' : minutes >= 900 ? 'afterclose' : minutes >= 690 && minutes < 780 ? 'lunch' : 'trading';
  if (!open || minutes < 570) {
    const day = new Date(`${today}T00:00:00Z`);
    let found = false;
    for (let i = 0; i < 40; i++) {
      day.setUTCDate(day.getUTCDate() - 1);
      referenceDate = day.toISOString().slice(0, 10);
      const trading = isTradingDate(referenceDate);
      if (trading === null) break;
      if (trading) { found = true; break; }
    }
    if (!found) return { known: false, phase: 'unknown', referenceDate: null, label: '交易日历待更新' };
  }
  const closingReference = ['closed', 'preopen', 'afterclose'].includes(phase);
  const anchor = closingReference ? 900 : minutes >= 690 && minutes < 795 ? 690 : minutes;
  return { known: true, phase, referenceDate, anchor, closingReference,
    label: phase === 'closed' ? '休市 · 最近交易日收盘参考' : phase === 'preopen' ? '开盘前 · 上一交易日收盘参考' : phase === 'afterclose' ? '收盘参考' : phase === 'lunch' ? '午间休市参考' : '盘中参考',
    source: calendars[today.slice(0, 4)].source };
}

module.exports = { isTradingDate, marketSession };
