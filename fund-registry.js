const fs = require('node:fs');
const path = require('node:path');
const fail = message => Object.assign(new Error(message), { status: 400 });
function createFundRegistry({ dataDir, lookup, initialCode = '162201' }) {
  const file = path.join(dataDir, 'funds.json');
  let state = { defaultCode: initialCode, funds: [{ code: initialCode, name: initialCode === '162201' ? '宏利成长混合' : initialCode }] };
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(saved.funds) || !saved.funds.length || saved.funds.some(f => !/^\d{6}$/.test(f.code) || typeof f.name !== 'string') || !saved.funds.some(f => f.code === saved.defaultCode)) throw Error('Invalid funds.json');
    state = saved;
  }
  const list = () => structuredClone(state);
  function resolve(code) {
    const selected = code || state.defaultCode;
    if (typeof selected !== 'string' || !/^\d{6}$/.test(selected) || !state.funds.some(f => f.code === selected)) throw fail('该基金尚未添加，请在首页管理基金中添加后选择。');
    return selected;
  }
  async function update(input) {
    const code = String(input.code || '').trim();
    if (!/^\d{6}$/.test(code)) throw fail('基金代码须为六位数字。');
    let info;
    if (input.action === 'add') {
      if (state.funds.some(f => f.code === code)) throw fail('该基金已添加。');
      if (state.funds.length >= 20) throw fail('最多可添加20只基金。');
      info = await lookup(code);
      if (!info?.name) throw fail('无法核验此基金，请检查代码或稍后再试。');
    }
    const next = list();
    const index = next.funds.findIndex(f => f.code === code);
    if (input.action === 'add') {
      if (index !== -1) throw fail('该基金已添加。');
      if (next.funds.length >= 20) throw fail('最多可添加20只基金。');
      next.funds.push({ code, name: String(info.name).slice(0, 100) });
    } else {
      resolve(code);
      if (input.action === 'remove') {
        if (next.funds.length === 1) throw fail('至少保留一只基金。');
        next.funds.splice(index, 1);
        if (next.defaultCode === code) next.defaultCode = next.funds[0].code;
      } else if (input.action === 'default') next.defaultCode = code;
      else if (input.action === 'move') {
        if (![1, -1].includes(input.direction)) throw fail('排序方向无效。');
        const target = index + input.direction;
        if (target >= 0 && target < next.funds.length) [next.funds[index], next.funds[target]] = [next.funds[target], next.funds[index]];
      } else throw fail('基金操作无效。');
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    state = next;
    return list();
  }
  return { list, resolve, update };
}
module.exports = { createFundRegistry };
