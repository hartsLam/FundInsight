(() => {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');
  const mobileMenu = document.getElementById('mobileMenu');
  document.querySelector('.topbar-actions')?.prepend(mobileMenu);
  const backdrop = document.getElementById('sidebarBackdrop');
  const mobile = matchMedia('(max-width: 1279px)');
  let collapsed = false;
  try { collapsed = localStorage.getItem('fund-sidebar-collapsed') === 'true'; } catch {}
  function drawer(open) {
    document.body.classList.toggle('sidebar-open', open);
    backdrop.hidden = !open;
    sidebar.inert = mobile.matches && !open;
    mobileMenu.setAttribute('aria-expanded', String(open));
    if (open) toggle.focus();
  }
  function layout() {
    document.body.classList.toggle('sidebar-collapsed', !mobile.matches && collapsed);
    toggle.setAttribute('aria-expanded', String(mobile.matches || !collapsed));
    toggle.title = toggle.getAttribute('aria-expanded') === 'true' ? '收起侧栏' : '展开侧栏';
    toggle.setAttribute('aria-label', toggle.title);
    drawer(false);
  }
  toggle.addEventListener('click', () => {
    if (mobile.matches) { drawer(false); mobileMenu.focus(); return; }
    collapsed = !collapsed;
    try { localStorage.setItem('fund-sidebar-collapsed', String(collapsed)); } catch {}
    layout();
  });
  mobileMenu.addEventListener('click', () => drawer(!document.body.classList.contains('sidebar-open')));
  backdrop.addEventListener('click', () => { drawer(false); mobileMenu.focus(); });
  sidebar.addEventListener('keydown', event => { if (event.key === 'Escape' && mobile.matches) { drawer(false); mobileMenu.focus(); } });
  mobile.addEventListener('change', layout);
  sidebar.querySelectorAll('.sage-nav a, .sage-nav button').forEach(item => {
    const label = document.createElement('span');
    [...item.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).forEach(node => label.append(node));
    item.append(label); item.title = label.textContent.trim(); item.setAttribute('aria-label', item.title);
  });
  window.fundReady.then(fund => { document.getElementById('sidebarFundLabel').textContent = `${fund.name}\n${fund.code}`; }).catch(() => {});
  layout();
  const links = [...document.querySelectorAll('.sage-nav a[href^="#"]')];
  links.forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    const target = document.querySelector(link.getAttribute('href'));
    if (mobile.matches) drawer(false);
    target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    history.replaceState(null, '', link.getAttribute('href'));
    links.forEach(item => { item.classList.toggle('active', item === link); if (item === link) item.setAttribute('aria-current', 'location'); else item.removeAttribute('aria-current'); });
  }));
  document.getElementById('sidebarAssistant').addEventListener('click', () => {
    if (mobile.matches) drawer(false);
    const launcher = document.getElementById('chatLauncher');
    if (!launcher.hidden) launcher.click();
    else document.getElementById('question').focus();
  });
})();
