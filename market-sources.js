function holdingsRequest(code, year = '', now = Date.now()) {
  const url = new URL('https://fundf10.eastmoney.com/FundArchivesDatas.aspx');
  url.search = new URLSearchParams({ type: 'jjcc', code, topline: '20', year: String(year), month: '', rt: String(now) });
  return { url: url.href, options: { headers: { Referer: 'https://fundf10.eastmoney.com/' } } };
}

async function probeSource(fetchText, label, url, parser = text => text.length, options = {}) {
  const started = Date.now();
  try {
    const body = await fetchText(url, options, 8000);
    return { label, ok: true, ms: Date.now() - started, sample: parser(body) };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - started, error: error.message };
  }
}

module.exports = { holdingsRequest, probeSource };
