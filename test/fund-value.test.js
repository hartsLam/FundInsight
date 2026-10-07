const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSina, parseEastmoney, loadFundValue } = require('../fund-value');
const raw = 'var hq_str_fu_162201="Fund,16:04:00,7.0944,6.9343,9.3308,0,2.3092,2026-09-18,7.0933,2.2933";';
const payload = { success: true, data: [{ FCODE: '162201', SHORTNAME: 'Fund', NAV: 7.0991, PDATE: '2026-09-18', GSZ: null, GSZZL: null, GZTIME: null }] };
test('Sina parses valuation and preserves its actual timestamp', () => {
  const value = parseSina(raw, '162201');
  assert.equal(value.gsz, 7.0944);
  assert.equal(value.previousNav, 6.9343);
  assert.equal(value.gszzl, 2.3092);
  assert.equal(value.gztime, '2026-09-18 16:04:00');
  assert.throws(() => parseSina('<html>not found</html>', '162201'));
  assert.throws(() => parseSina(raw.replace('7.0944', '-'), '162201'));
});
test('missing valuations stay null instead of becoming zero or NAV', () => {
  const value = parseEastmoney(payload, '162201');
  assert.equal(value.gsz, null);
  assert.equal(value.gszzl, null);
  assert.equal(value.dwjz, 7.0991);
});
test('combines official NAV and independent valuation without conflating dates', async () => {
  const value = await loadFundValue('162201', { fetchJson: async () => payload, fetchBytes: async (url) => { assert.ok(url.endsWith('&list=fu_162201')); return Buffer.from(raw); } });
  assert.equal(value.gsz, 7.0944);
  assert.equal(value.dwjz, 7.0991);
  assert.equal(value.estimateSource, '新浪财经');
  assert.equal(value.jzrq, '2026-09-18');
});
test('Sina failure preserves NAV with no made-up estimate', async () => {
  const value = await loadFundValue('162201', { fetchJson: async () => payload, fetchBytes: async () => { throw Error('offline'); } });
  assert.equal(value.gsz, null);
  assert.equal(value.dwjz, 7.0991);
});
test('backup host and newer timestamp take precedence', async () => {
  let calls = 0;
  const value = await loadFundValue('162201', { fetchJson: async () => {
    if (++calls === 1) throw Error('offline');
    return { data: [{ ...payload.data[0], GSZ: 7.2, GSZZL: 1.2, GZTIME: '2026-09-21 10:00:00' }] };
  }, fetchBytes: async () => Buffer.from(raw) });
  assert.equal(calls, 2);
  assert.equal(value.gsz, 7.2);
  assert.equal(value.estimateSource, '天天基金');
});
