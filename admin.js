const el = (id) => document.getElementById(id);
const secretFields = ['apiKey', 'searchKey', 'volcSearchKey', 'tencentSearchKey', 'bailianSearchKey'];
const clearField = (key) => `clear${key[0].toUpperCase()}${key.slice(1)}`;
function showProvider() {
  document.querySelectorAll('[data-provider]').forEach((panel) => {
    panel.hidden = panel.dataset.provider !== el('searchProvider').value;
    // Hidden fields keep unsaved drafts, but must not block HTML form validation.
    panel.querySelectorAll('input').forEach((input) => { input.disabled = panel.hidden; });
  });
}
el('searchProvider').addEventListener('change', showProvider);
async function callAdmin(url, payload) {
  const response = await fetch(url, { method: payload ? 'POST' : 'GET', cache: 'no-store',
    headers: payload ? { 'Content-Type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || '请求失败'); error.status = response.status; throw error; }
  return result;
}
function showSettings(data) {
  el('adminLogin').hidden = true; el('settingsArea').hidden = false;
  for (const key of ['marketSource', 'endpoint', 'model', 'searchProvider', 'bailianEndpoint', 'bailianModel']) el(key).value = data[key] || '';
  el('enabled').checked = data.enabled;
  el('keyState').textContent = data.hasApiKey ? '已保存' : '未配置';
  el('searchState').textContent = data.hasSearchKey ? '已保存' : '未配置';
  for (const prefix of ['volc', 'tencent', 'bailian']) {
    el(`${prefix}SearchState`).textContent = data[`has${prefix[0].toUpperCase()}${prefix.slice(1)}SearchKey`] ? '已保存' : '未配置';
  }
  for (const key of secretFields) { el(key).value = ''; el(clearField(key)).checked = false; }
  showProvider();
}
el('adminLogin').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    await callAdmin('/api/admin/login', { password: el('adminPassword').value });
    el('adminPassword').value = ''; showSettings(await callAdmin('/api/admin/settings')); el('adminStatus').textContent = '';
  } catch (error) { el('adminStatus').textContent = error.message; } finally { button.disabled = false; }
});
el('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault(); el('saveSettings').disabled = true; el('adminStatus').textContent = '正在保存…';
  const payload = {};
  for (const key of ['marketSource', 'endpoint', 'model', 'searchProvider', 'bailianEndpoint', 'bailianModel', ...secretFields]) payload[key] = el(key).value;
  for (const key of ['enabled', ...secretFields.map(clearField)]) payload[key] = el(key).checked;
  try { showSettings(await callAdmin('/api/admin/settings', payload)); el('adminStatus').textContent = '设置已保存并生效。'; }
  catch (error) { el('adminStatus').textContent = error.message; }
  finally { el('saveSettings').disabled = false; }
});
el('adminLogout').addEventListener('click', async () => {
  try { await callAdmin('/api/admin/logout', {}); location.reload(); }
  catch (error) { el('adminStatus').textContent = error.message; }
});
callAdmin('/api/admin/settings').then(showSettings).catch((error) => {
  if (error.status !== 401) el('adminStatus').textContent = error.message;
});
