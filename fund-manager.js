(() => {
  const $ = id => document.getElementById(id);
  const dialog = $('fundDialog');
  let busy = false, data;
  async function call(url, payload) {
    const response = await fetch(url, { method: payload ? 'POST' : 'GET', cache: 'no-store',
      headers: payload ? { 'Content-Type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) location.href = '/login.html';
      throw new Error(response.status === 401 ? '请重新验证访问密码。' : result.error || '操作失败，请重试。');
    }
    return result;
  }
  function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
  function render() {
    $('fundCount').textContent = `${data.funds.length} 只基金`;
    $('managedFunds').replaceChildren();
    data.funds.forEach((fund, index) => {
      const row = element('div', '', 'managed-fund');
      const selected = window.currentFund?.code === fund.code;
      row.classList.toggle('is-selected', selected);
      const name = element('div', '', 'managed-fund-name');
      name.append(element('strong', fund.name), element('small', fund.code));
      const label = element('label', '', 'fund-selection');
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'selectedFund'; radio.checked = selected;
      radio.setAttribute('aria-label', `选中 ${fund.name} ${fund.code}`);
      radio.addEventListener('change', () => { if (!busy) window.selectFund(fund.code); });
      label.append(radio, element('span', selected ? '已选中' : '选中'));
      const actions = element('div', '', 'fund-actions');
      for (const [title, action, direction, disabled] of [['上移', 'move', -1, index === 0], ['下移', 'move', 1, index === data.funds.length - 1], ['移除', 'remove', null, data.funds.length === 1]]) {
        const button = element('button', action === 'remove' ? '移除' : ''); button.type = 'button'; button.title = title; button.setAttribute('aria-label', `${title} ${fund.name}`); button.disabled = disabled;
        if (action === 'move') { const icon = document.createElement('img'); icon.src = '/icons/arrow-up.svg'; icon.alt = ''; icon.width = 18; icon.height = 18; if (direction === 1) icon.style.transform = 'rotate(180deg)'; button.append(icon); }
        button.addEventListener('click', () => { if (action === 'remove' && !confirm(`移除 ${fund.name}（${fund.code}）？`)) return; change({ action, code: fund.code, direction }); });
        actions.append(button);
      }
      row.append(name, label, actions); $('managedFunds').append(row);
    });
  }
  function syncSelection() {
    const code = window.currentFund?.code;
    if (!code) return;
    if (!data.funds.some(fund => fund.code === code)) {
      window.selectFund(data.funds.some(f => f.code === data.defaultCode) ? data.defaultCode : data.funds[0].code);
    }
  }
  async function load() {
    data = await call('/api/ai/funds'); render(); syncSelection();
    $('fundManager').hidden = false;
  }
  async function change(payload) {
    if (busy) return;
    busy = true;
    $('fundStatus').textContent = payload.action === 'add' ? '正在核验基金…' : '正在保存…';
    $('fundManager').querySelectorAll('button,input').forEach(control => { control.disabled = true; });
    try {
      data = await call('/api/ai/funds', payload); syncSelection();
      if (payload.action === 'add') $('newFundCode').value = '';
      $('fundStatus').textContent = '基金列表已更新。';
    } catch (error) { $('fundStatus').textContent = error.message; }
    finally { busy = false; render(); $('newFundCode').disabled = false; $('addFundForm').querySelector('button').disabled = false; }
  }
  $('manageFunds').addEventListener('click', async () => {
    if (dialog.open) return;
    dialog.showModal(); $('fundStatus').textContent = '正在读取…';
    try { await window.fundReady; await load(); $('fundStatus').textContent = ''; }
    catch (error) { $('fundStatus').textContent = error.message; }
  });
  $('closeFunds').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { $('manageFunds').focus(); });
  $('addFundForm').addEventListener('submit', event => { event.preventDefault(); change({ action: 'add', code: $('newFundCode').value.trim() }); });
})();
