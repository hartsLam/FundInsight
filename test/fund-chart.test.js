const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFundHistory, createFundHistoryService } = require('../fund-history');
const { parseIntraday, createIntradayService } = require('../fund-intraday');

const source = rows => `var fS_code="162201";var Data_netWorthTrend=${JSON.stringify(rows)};throw Error('must never execute');`;
const row = { x: Date.parse('2026-09-18T00:00:00+08:00'), y: 7.0991, equityReturn: 2.38, unitMoney: 'text with ] bracket' };

test('history parses only JSON, preserves China dates, sorts and ignores invalid NAVs', () => {
  const result = parseFundHistory(source([row, { ...row, y: null }, { ...row, x: row.x - 86400000, y: 6.9343 }]), '162201');
  assert.equal(result.length, 2);
  assert.equal(result[0].date, '2026-09-17');
  assert.equal(result[1].nav, 7.0991);
  assert.equal(result[1].dividend, 'text with ] bracket');
  assert.throws(() => parseFundHistory(source([row]), '161725'), /代码不匹配/);
  assert.throws(() => parseFundHistory(source([]), '162201'), /暂无/);
});

test('history coalesces requests, expires cache and labels bounded stale fallback', async () => {
  let calls = 0, time = 1000, offline = false;
  const get = createFundHistoryService({ now: () => time, fetchText: async () => { calls++; if (offline) throw Error('offline'); return source([row]); } });
  await Promise.all([get('162201'), get('162201')]);
  assert.equal(calls, 1);
  await get('162201'); assert.equal(calls, 1);
  time += 900000; offline = true;
  assert.equal((await get('162201')).stale, true);
  time += 86400000;
  await assert.rejects(get('162201'));
});

const snapshot = { gsz: 7.0944, gszzl: 2.3092, gztime: '2026-09-18 16:04:00' };
const payload = { result: { status: { code: 0 }, data: { yes: '7.0991', detail: '09:30,7.0609,10:00,7.0063,15:03,7.0944' } } };
const now = Date.parse('2026-09-21T08:00:00+08:00');

test('intraday uses dated prior NAV, not rolled-forward provider yes; old day stays old', () => {
  const result = parseIntraday(payload, snapshot, [{ date: '2026-09-17', nav: 6.9343 }, { date: '2026-09-18', nav: 7.0991 }], now);
  assert.equal(result.referenceDate, '2026-09-18');
  assert.equal(result.today, '2026-09-21');
  assert.equal(result.baseline.nav, 6.9343);
  assert.ok(Math.abs(result.rows.at(-1).changePct - 2.3092) < 0.001);
  assert.equal(result.dateBasis, 'snapshot-match');
});

test('intraday does not invent a date, baseline, or zero for unmatched or absent evidence', () => {
  for (const value of [null, { ...snapshot, gsz: 9 }, { ...snapshot, gztime: '2026-09-22 16:04:00' }]) {
    const result = parseIntraday(payload, value, [], now);
    assert.equal(result.referenceDate, null);
    assert.equal(result.rows[0].changePct, null);
  }
  assert.throws(() => parseIntraday({ result: { status: { code: 0 }, data: { detail: 'bad' } } }, snapshot), /格式/);
});

test('empty series falls back to one timestamped sample, persists it and does not synthesize a line', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intraday-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const deps = { dataDir: dir, now: () => now, getHistory: async () => ({ rows: [] }), fetchJson: async () => ({ result: { status: { code: 0 }, data: null } }),
    fetchBytes: async () => { calls++; return Buffer.from('var hq_str_fu_162201="fund,16:04:00,7.0944,6.9343,9.33,0,2.3092,2026-09-18";'); } };
  const get = createIntradayService(deps);
  const [result] = await Promise.all([get('162201'), get('162201')]);
  assert.equal(calls, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.mode, 'sampled');
  assert.equal(result.referenceDate, '2026-09-18');
  assert.equal((await createIntradayService(deps)('162201')).rows.length, 1);
});

const closePayload = { result: { status: { code: 0 }, data: { yes: '7.1233', detail:
  Array.from({ length: 20 }, (_, i) => `${i === 19 ? '15:02' : `14:${String(i * 3).padStart(2, '0')}`},${i === 19 ? '7.0690' : (7.1 + i / 1000).toFixed(4)}`).join(',') } } };
const closeSnapshot = { gsz: 7.0651, previousNav: 7.1233, gztime: '2026-09-22 16:03:00' };
const closeHistory = [{ date: '2026-09-22', nav: 7.05 }, { date: '2026-09-21', nav: 7.1233 }];
const closeNow = Date.parse('2026-09-22T17:00:00+08:00');

test('post-close estimate revision uses matching dated baselines, not exact last NAV equality', () => {
  const result = parseIntraday(closePayload, closeSnapshot, closeHistory, closeNow);
  assert.equal(result.referenceDate, '2026-09-22');
  assert.equal(result.dateBasis, 'snapshot-baseline');
  assert.equal(result.baseline.date, '2026-09-21');
  assert.equal(result.rows.at(-1).nav, 7.0690);
  assert.ok(Number.isFinite(result.rows.at(-1).changePct));
});

test('nearby estimates alone do not date a curve without all baseline checks', () => {
  for (const [snap, hist, input] of [
    [{ ...closeSnapshot, previousNav: 8 }, closeHistory, closePayload],
    [closeSnapshot, [], closePayload],
    [{ ...closeSnapshot, gsz: 7.2 }, closeHistory, closePayload],
    [{ ...closeSnapshot, gztime: '2026-09-23 16:03:00' }, closeHistory, closePayload],
    [closeSnapshot, closeHistory, { result: { status: { code: 0 }, data: { ...closePayload.result.data, yes: '7.05' } } }],
    [closeSnapshot, closeHistory, { result: { status: { code: 0 }, data: { yes: '7.1233', detail: '14:00,7.0690' } } }]
  ]) assert.equal(parseIntraday(input, snap, hist, closeNow).referenceDate, null);
});

test('known curve date survives later quote revision and never relabels old points as today', () => {
  const first = parseIntraday(closePayload, closeSnapshot, closeHistory, closeNow);
  const known = { fingerprint: first.fingerprint, date: first.referenceDate, basis: first.dateBasis };
  const later = parseIntraday(closePayload, null, closeHistory, closeNow + 86400000, known);
  assert.equal(later.referenceDate, '2026-09-22');
  assert.equal(later.today, '2026-09-23');
  const changed = structuredClone(closePayload);
  changed.result.data.detail = changed.result.data.detail.replace('7.0690', '7.0691');
  assert.equal(parseIntraday(changed, null, closeHistory, closeNow, known).referenceDate, null);
});

test('corroborated curve date persists across service restart and temporary snapshot failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intraday-date-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deps = { dataDir: dir, now: () => closeNow, fetchJson: async () => closePayload, getHistory: async () => ({ rows: closeHistory }),
    fetchBytes: async () => Buffer.from('var hq_str_fu_162201="Fund,16:03:00,7.0651,7.1233,0,0,-0.8,2026-09-22";') };
  assert.equal((await createIntradayService(deps)('162201')).referenceDate, '2026-09-22');
  deps.fetchBytes = async () => { throw Error('offline'); };
  assert.equal((await createIntradayService(deps)('162201')).referenceDate, '2026-09-22');
});
