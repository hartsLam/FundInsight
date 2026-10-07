function numeric(value, positive = false) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && (!positive || n > 0) ? n : null;
}

function parseSina(raw, code) {
  if (!/^\d{6}$/.test(code)) throw new Error('Invalid fund code');
  const match = raw.match(new RegExp(`var\\s+hq_str_fu_${code}\\s*=\\s*"([^"\\r\\n]*)"\\s*;?`));
  const parts = match?.[1].split(',') || [];
  const gsz = numeric(parts[2], true);
  if (parts.length < 8 || gsz === null || !/^\d{4}-\d{2}-\d{2}$/.test(parts[7]) || !/^\d{2}:\d{2}:\d{2}$/.test(parts[1])) throw new Error('Sina fund valuation unavailable');
  return { name: parts[0], gsz, previousNav: numeric(parts[3], true), gszzl: numeric(parts[6]), gztime: `${parts[7]} ${parts[1]}`, estimateSource: '新浪财经', estimateUrl: `https://finance.sina.com.cn/fund/quotes/${code}/bc.shtml` };
}

function parseEastmoney(payload, code) {
  const row = Array.isArray(payload.data) && payload.data.find(item => item.FCODE === code);
  if (payload.success === false || !row) throw new Error('Fund valuation response invalid');
  const timestamp = typeof row.GZTIME === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(row.GZTIME) ? row.GZTIME : null;
  return { name: row.SHORTNAME, dwjz: numeric(row.NAV, true), jzrq: /^\d{4}-\d{2}-\d{2}$/.test(row.PDATE || '') ? row.PDATE : null,
    gsz: timestamp ? numeric(row.GSZ, true) : null, gszzl: timestamp ? numeric(row.GSZZL) : null, gztime: timestamp,
    navSource: '天天基金', estimateSource: '天天基金', estimateUrl: `https://fund.eastmoney.com/${code}.html` };
}

async function loadFundValue(code, { fetchJson, fetchBytes, now = Date.now }) {
  let official = null;
  for (const host of ['fundcomapi.tiantianfunds.com', 'fundcomapi.eastmoney.com']) {
    try {
      official = parseEastmoney(await fetchJson(`https://${host}/mm/newCore/FundValuationLast?FCODES=${code}&FIELDS=FCODE,SHORTNAME,GSZZL,GZTIME,GSZ,NAV,PDATE`, {}, 8000), code);
      break;
    } catch {}
  }
  let sina = null;
  try {
    const raw = await fetchBytes(`https://hq.sinajs.cn/?_=${now()}&list=fu_${code}`, { headers: { Referer: 'https://finance.sina.com.cn/' } }, 8000);
    sina = parseSina(new TextDecoder('gbk').decode(raw), code);
  } catch {}
  const choices = [sina, official].filter(value => value?.gsz !== null && value?.gsz !== undefined && value.gztime);
  choices.sort((a, b) => Date.parse(b.gztime.replace(' ', 'T') + (b.gztime.includes('+') || b.gztime.endsWith('Z') ? '' : '+08:00')) - Date.parse(a.gztime.replace(' ', 'T') + (a.gztime.includes('+') || a.gztime.endsWith('Z') ? '' : '+08:00')));
  if (!official && !sina) throw new Error('Fund valuation sources unavailable');
  return { name: official?.name || sina?.name, dwjz: official?.dwjz ?? null, jzrq: official?.jzrq ?? null, navSource: official?.navSource || null,
    gsz: null, gszzl: null, gztime: null, estimateSource: null, estimateUrl: null, ...choices[0] };
}

module.exports = { parseSina, parseEastmoney, loadFundValue };
