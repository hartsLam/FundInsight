(() => {
  const themes = [
    { id: 'sage', name: '瓷白 · 朱砂', colors: ['#e9edf4', '#ffffff', '#a83c40', '#637b9d'] },
    { id: 'emerald', name: '翡翠 · 清透', colors: ['#e8f0ed', '#ffffff', '#00865c', '#587caa'] },
    { id: 'sunrise', name: '晨曦 · 磨砂', colors: ['#fae8d9', '#fffaf5', '#b9441d', '#a64072'] },
    { id: 'aegis', name: '极夜 · 霓光', colors: ['#101216', '#202227', '#76abff', '#b59aef'] }
  ];
  const valid = value => themes.some(theme => theme.id === value);
  let selected = 'sage';
  let glass = 70;
  const preferenceKey = 'fund-appearance';
  try { const saved = localStorage.getItem('fund-theme'); if (valid(saved)) selected = saved; } catch {}
  function restore(value) {
    try {
      const saved = JSON.parse(value);
      if (valid(saved?.theme)) selected = saved.theme;
      if (typeof saved?.glass === 'number' && Number.isFinite(saved.glass)) glass = Math.max(0, Math.min(100, Math.round(saved.glass)));
    } catch {}
  }
  try { restore(localStorage.getItem(preferenceKey)); } catch {}
  function applyGlass() {
    const root = document.documentElement;
    root.dataset.glass = String(glass);
    root.style.setProperty('--glass-amount', `${glass}%`);
    root.style.setProperty('--glass-strength', String(glass / 100));
    root.style.setProperty('--preferred-blur', `${glass * .4}px`);
    root.style.setProperty('--preferred-control-blur', `${glass * .2}px`);
    root.style.setProperty('--preferred-mobile-blur', `${glass * .08}px`);
  }
  function remember() {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ theme: selected, glass })); return true; } catch { return false; }
  }
  applyGlass();
  document.documentElement.dataset.theme = selected;
  function start() {
    const trigger = document.getElementById('themeButton');
    if (!trigger) return;
    const dialog = document.createElement('dialog'); dialog.id = 'themeDialog'; dialog.className = 'theme-dialog'; dialog.setAttribute('aria-labelledby', 'themeTitle');
    const header = document.createElement('header'); header.className = 'theme-dialog-head';
    const title = document.createElement('h2'); title.id = 'themeTitle'; title.textContent = '选择主题';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'theme-close'; close.textContent = '×'; close.setAttribute('aria-label', '关闭主题选择'); close.title = '关闭';
    close.addEventListener('click', () => dialog.close()); header.append(title, close);
    const grid = document.createElement('div'); grid.className = 'theme-options';
    const status = document.createElement('p'); status.className = 'theme-status'; status.setAttribute('role', 'status');
    for (const theme of themes) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'theme-option'; card.dataset.choice = theme.id;
      const name = document.createElement('strong'); name.textContent = theme.name;
      const palette = document.createElement('span'); palette.className = 'theme-palette'; palette.setAttribute('aria-hidden', 'true');
      for (const color of theme.colors) { const swatch = document.createElement('i'); swatch.style.backgroundColor = color; palette.append(swatch); }
      const state = document.createElement('span'); state.className = 'theme-choice-state';
      card.append(name, palette, state);
      card.addEventListener('click', () => {
        selected = theme.id; document.documentElement.dataset.theme = selected;
        const remembered = remember();
        render(); status.textContent = remembered ? `已应用「${theme.name}」` : `已应用「${theme.name}」，当前浏览器无法保存设置。`;
        window.dispatchEvent(new Event('fund-theme-change'));
        close.focus({ preventScroll: true });
      });
      grid.append(card);
    }
    function render() {
      for (const card of grid.children) {
        const active = card.dataset.choice === selected;
        card.disabled = active; card.setAttribute('aria-pressed', String(active));
        card.querySelector('.theme-choice-state').textContent = active ? '✓ 使用中' : '应用主题';
      }
    }
    const setting = document.createElement('div'); setting.className = 'glass-setting';
    const heading = document.createElement('div'); heading.className = 'glass-setting-heading';
    const label = document.createElement('label'); label.htmlFor = 'glassAmount'; label.textContent = '毛玻璃程度';
    const output = document.createElement('output'); output.htmlFor = 'glassAmount';
    const slider = document.createElement('input'); slider.id = 'glassAmount'; slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
    const limits = document.createElement('div'); limits.className = 'glass-setting-limits';
    for (const text of ['0%', '100%']) { const span = document.createElement('span'); span.textContent = text; limits.append(span); }
    function renderSlider() { slider.value = String(glass); output.value = `${glass}%`; slider.setAttribute('aria-valuetext', `${glass}%`); }
    slider.addEventListener('input', () => { glass = Number(slider.value); applyGlass(); renderSlider(); });
    slider.addEventListener('change', () => { status.textContent = remember() ? '' : '当前浏览器无法保存设置。'; });
    heading.append(label, output); setting.append(heading, slider, limits);
    dialog.append(header, grid, status, setting); document.body.append(dialog); render(); renderSlider();
    trigger.addEventListener('click', () => { render(); status.textContent = ''; dialog.showModal(); });
    dialog.addEventListener('close', () => trigger.focus());
    window.addEventListener('storage', event => {
      if (event.key !== preferenceKey) return;
      selected = 'sage'; glass = 70; restore(event.newValue);
      document.documentElement.dataset.theme = selected; applyGlass();
      render(); renderSlider(); window.dispatchEvent(new Event('fund-theme-change'));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
