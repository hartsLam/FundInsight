const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFundRegistry } = require('../fund-registry');
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-registry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { dataDir, lookup: async code => code === '000000' ? null : { name: `Fund ${code}` } };
  return { config, registry: createFundRegistry(config) };
}
test('fund registry validates additions, default, ordering, deletion and restart', async t => {
  const { config, registry: r } = fixture(t);
  assert.equal(r.resolve(), '162201');
  await r.update({ action: 'add', code: '161725' });
  await r.update({ action: 'default', code: '161725' });
  await r.update({ action: 'move', code: '161725', direction: -1 });
  assert.equal(r.list().funds[0].code, '161725');
  assert.equal(createFundRegistry(config).resolve(), '161725');
  await r.update({ action: 'remove', code: '161725' });
  assert.equal(r.resolve(), '162201');
  await assert.rejects(r.update({ action: 'remove', code: '162201' }), /至少/);
  await assert.rejects(r.update({ action: 'add', code: '000000' }), /核验/);
  await assert.rejects(r.update({ action: 'add', code: '../x' }), /六位/);
  await assert.rejects(r.update({ action: 'add', code: '162201' }), /已添加/);
  assert.throws(() => r.resolve('161725'), /尚未添加/);
});
test('concurrent fund additions retain every entry and reject duplicates', async t => {
  const { registry: r } = fixture(t);
  await Promise.all(['161725','000001'].map(code => r.update({ action: 'add', code })));
  assert.equal(r.list().funds.length, 3);
  const results = await Promise.allSettled([r.update({ action: 'add', code: '000002' }), r.update({ action: 'add', code: '000002' })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
});
