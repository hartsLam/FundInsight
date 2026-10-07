const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIndustryService, parseIndustry } = require('../stock-industry');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-industry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const stock = { code: '600519', market: 1 };
const rows = [{ SECURITY_CODE: '600519', EM2016: '食品饮料-饮料-白酒' }];

test('parses published hierarchy, refuses missing or mismatched records', () => {
  const result = parseIndustry(rows, stock.code, 'https://example.com', 0);
  assert.equal(result.industry, '白酒');
  assert.deepEqual(result.industryPath, ['食品饮料', '饮料', '白酒']);
  assert.equal(parseIndustry(rows, '000001', '', 0), null);
  assert.equal(parseIndustry([{ SECURITY_CODE: '600519', EM2016: '-' }], stock.code, '', 0), null);
  assert.equal(parseIndustry(null, stock.code, '', 0), null);
});

test('independent of price data, shares requests, persists and refreshes after 24 hours', async t => {
  const dataDir = temp(t);
  let time = 1000, calls = 0;
  const deps = { dataDir, now: () => time, fetchJson: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 5)); return { jbzl: rows };
  } };
  const service = createIndustryService(deps);
  const result = await service.enrich([stock, stock, stock]);
  assert.equal(calls, 1);
  assert.equal(result[0].quote.industry, '白酒');
  await createIndustryService(deps).get(stock);
  assert.equal(calls, 1);
  time += 86400000;
  await service.get(stock);
  assert.equal(calls, 2);
});

test('fallback endpoint, stale annotation, negative cache and eventual expiry', async t => {
  let time = 1000, calls = 0, offline = false;
  const service = createIndustryService({ dataDir: temp(t), now: () => time, fetchJson: async url => {
    calls++;
    if (offline || url.includes('PageAjax')) throw Error('offline');
    assert.equal(new URL(url).searchParams.get('filter'), '(SECURITY_CODE="600519")');
    return { result: { data: rows } };
  } });
  assert.equal((await service.get(stock)).industry, '白酒');
  assert.equal(calls, 2);
  offline = true;
  time += 86400000;
  assert.equal((await service.get(stock)).industryStale, true);
  await service.get(stock);
  assert.equal(calls, 4);
  time += 7 * 86400000;
  const [item] = await service.enrich([{ ...stock, quote: { price: 123, industry: 'old-static-value' } }]);
  assert.equal(item.quote.industry, '未分类');
  assert.equal(item.quote.price, 123);
  assert.equal(item.quote.industrySource, null);
});

test('rejects unsupported codes and limits concurrent profile requests', async t => {
  let active = 0, max = 0;
  const service = createIndustryService({ dataDir: temp(t), fetchJson: async url => {
    active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    const code = new URL(url).searchParams.get('code').slice(2);
    return { jbzl: [{ SECURITY_CODE: code, EM2016: '金融-银行' }] };
  } });
  assert.equal(await service.get({ code: '00700', market: 116 }), null);
  const result = await service.enrich(Array.from({ length: 12 }, (_, i) => ({ code: String(600000 + i), market: 1 })));
  assert.equal(result.length, 12);
  assert.ok(max <= 4);
  assert.ok(result.every(item => item.quote.industry === '银行'));
});
