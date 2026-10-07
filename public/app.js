const state = {
  dashboard: null
};

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

function signed(value, suffix = "%") {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${fmt.format(value)}${suffix}`;
}

function money(value) {
  if (!Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${fmt.format(value / 1e8)}亿`;
  if (abs >= 1e4) return `${fmt.format(value / 1e4)}万`;
  return fmt.format(value);
}

function toneClass(value) {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

function contribution(item) {
  if (item.quote?.signalUsable === false) return null;
  const pct = item.quote?.pct;
  if (!Number.isFinite(pct)) return null;
  return item.weight * pct / 100;
}

function stockSourceUrl(item) {
  return `https://quote.eastmoney.com/unify/r/${item.market}.${item.code}`;
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 401) {
    window.location.href = "/login.html";
    throw new Error("请先登录。");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "数据暂时不可用，请稍后刷新。");
  }
  return response.json();
}

async function loadDashboard(force = false) {
  if (!window.currentFund || document.body.classList.contains('loading')) return;
  document.body.classList.add("loading");
  $('refreshBtn').disabled = true;
  $('refreshBtn').setAttribute('aria-busy', 'true');
  try {
    const code = window.currentFund.code;
    state.dashboard = await getJson(`/api/dashboard?fund=${code}${force ? '&refresh=1' : ''}`);
    if (state.dashboard.fund.code !== code) throw new Error('返回基金与所选基金不一致，请刷新重试。');
    renderDashboard();
    if (force) await window.refreshFundChart?.();
  } finally {
    document.body.classList.remove("loading");
    $('refreshBtn').disabled = false;
    $('refreshBtn').setAttribute('aria-busy', 'false');
  }
}


function renderDashboard() {
  const data = state.dashboard;
  const fund = data.fund;
  $('fundWarning').textContent = data.warning || '';
  $('fundWarning').hidden = !data.warning;
  $("fundTitle").textContent = `${fund.name}（${fund.code}）`;
  $("estimateValue").textContent = Number.isFinite(fund.estimate) ? fund.estimate.toFixed(4) : "--";
  const source = $("estimateSource");
  source.textContent = fund.estimateSource && Number.isFinite(fund.estimate) ? `${fund.estimateSource}估值` : '估值源暂不可用';
  source.removeAttribute('href');
  if (/^https:\/\//.test(fund.estimateUrl || '')) { source.href = fund.estimateUrl; source.target = '_blank'; source.rel = 'noopener noreferrer'; }
  $("estimateTime").textContent = fund.estimateTime || '--';
  $("publishedNav").textContent = Number.isFinite(fund.nav) ? fund.nav.toFixed(4) : '--';
  $("publishedNavDate").textContent = fund.navDate || '--';
  const sinaPct = fund.estimateSource === '新浪财经' && Number.isFinite(fund.estimatePct) && fund.estimateTime ? fund.estimatePct : null;
  $("estimatePct").textContent = signed(sinaPct);
  $("estimatePct").className = toneClass(sinaPct);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  $("navDate").textContent = sinaPct === null ? '新浪估值暂不可用' : `来自新浪财经，仅供参考${data.stale ? ' · 历史缓存' : fund.estimateTime.slice(0, 10) !== today ? ' · 非今日估值' : ''}`;
  $('estimatePctTime').textContent = sinaPct === null ? '--' : fund.estimateTime;
  $('staticContribution').textContent = signed(data.analysis.quoteContribution);
  $('staticContribution').className = 'muted';
  $("topWeight").textContent = data.holdings.length ? `${fmt.format(data.analysis.topWeight)}%` : '--';
  const industries = $('topHoldingIndustries');
  industries.replaceChildren();
  for (const holding of data.holdings.slice(0, 3)) {
    const row = document.createElement('div');
    const name = document.createElement('dt');
    const industry = document.createElement('dd');
    name.textContent = holding.name || holding.code;
    const classification = holding.quote?.industry;
    industry.textContent = classification && classification !== '未分类' ? classification : '行业待核实';
    industry.title = [holding.quote?.industryPath?.join(' / '), holding.quote?.industrySource].filter(Boolean).join(' · ');
    row.append(name, industry); industries.append(row);
  }
  if (!data.holdings.length) {
    const empty = document.createElement('small'); empty.textContent = '暂无披露持仓行业'; industries.append(empty);
  }
  $("stance").textContent = data.analysis.stance;
  const signal = data.analysis.signal;
  $('stanceBasis').textContent = data.stale ? '历史缓存，非当前判断' : signal ? `${signal.session?.known && signal.basis !== 'unavailable' ? `${signal.session.label} · ` : ''}${signal.label} · 行情覆盖 ${signal.quoteCoverage}%` : '规则参考';
  $('stanceExplanationLabel').textContent = data.stale ? '历史缓存' : data.analysis.stance;
  $('stanceExplanation').textContent = (data.stale ? '当前展示历史缓存，并非实时判断。' : '') + (signal?.reason || '尚未取得可核验的判断依据，暂不作进一步解释。');
  const evidence = $('stanceEvidence'); evidence.replaceChildren();
  for (const [label, value] of [
    ['有效个股', Number.isFinite(signal?.validQuoteCount) ? `${signal.validQuoteCount} / ${signal.totalQuoteCount} 只` : null],
    ['披露重仓行情覆盖', Number.isFinite(signal?.quoteCoverage) ? `${fmt.format(signal.quoteCoverage)}%` : null],
    ['持仓加权平均涨跌', Number.isFinite(signal?.holdingAverage) ? signed(signal.holdingAverage) : null],
    ['板块行情覆盖', Number.isFinite(signal?.boardCoverage) ? `${fmt.format(signal.boardCoverage)}%` : null]
  ]) {
    if (value === null) continue;
    const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; detail.textContent = value; row.append(term, detail); evidence.append(row);
  }
  $("updatedAt").textContent = signal?.asOf ? `行情 ${new Date(signal.asOf).toLocaleString("zh-CN", { hour12: false })}` : '暂无可核验的行情时间';
  $("sourceText").textContent = `数据源：${Object.values(data.source).join(" / ")}`;

  renderImpact();
  renderNews();
  renderDistribution();
  renderChanges();
  renderIndexes();
  renderHoldings();
}


function renderImpact() {
  $("impactLines").innerHTML = state.dashboard.analysis.lines
    .map((line) => `<p>${line}</p>`)
    .join("");
}

function renderNews() {
  const items = state.dashboard.events || state.dashboard.news || [];
  $("newsList").innerHTML = items.map((item) => `
    <article class="news-item">
      ${item.url
        ? `<a href="${item.url}" target="_blank" rel="noreferrer">${item.title}</a>`
        : `<strong>${item.title}</strong>`}
      <p>${item.summary || ""}</p>
      <div class="news-meta">
        ${item.type ? `<span>${item.type}</span>` : ""}
        <span>${item.source || "东方财富"}</span>
        <span>${item.time ? new Date(item.time).toLocaleString("zh-CN", { hour12: false }) : ""}</span>
        ${item.matched?.length ? `<span>${item.matched.join(" / ")}</span>` : ""}
      </div>
    </article>
  `).join("");
}

function renderDistribution() {
  const industries = state.dashboard.distribution.industry.slice(0, 8);
  const max = Math.max(...industries.map((item) => item.weight), 1);
  $("industryBars").innerHTML = industries.map((item) => `
    <div class="bar-row">
      <span>${item.name}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(5, item.weight / max * 100)}%"></div></div>
      <strong>${fmt.format(item.weight)}%</strong>
    </div>
  `).join("");

  $("conceptTags").innerHTML = state.dashboard.distribution.concepts.slice(0, 10)
    .map((item) => `<span class="tag">${item.name} ${fmt.format(item.weight)}%</span>`)
    .join("");
}

function renderChanges() {
  $("changeList").innerHTML = state.dashboard.changes.slice(0, 12).map((item) => `
    <div class="change-item">
      <div class="change-name">
        <strong>${item.name}</strong>
        <span>${item.code} · ${item.status}</span>
      </div>
      <span>${fmt.format(item.previousWeight)}% → ${fmt.format(item.weight)}%</span>
      <strong class="${toneClass(item.change)}">${signed(item.change)}</strong>
    </div>
  `).join("");
}

function renderIndexes() {
  $("indexStrip").innerHTML = state.dashboard.indexes.map((item) => `
    <span class="index-pill">${item.name} <strong class="${toneClass(item.pct)}">${signed(item.pct)}</strong></span>
  `).join("");
}

function industryLabel(quote) {
  const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const label = escape(quote.industry || '未分类');
  let url;
  try { url = new URL(quote.industrySourceUrl); } catch { return label; }
  if (url.protocol !== 'https:' || url.hostname !== 'emweb.securities.eastmoney.com') return label;
  const title = `${quote.industrySource} | ${(quote.industryPath || []).join(' / ')} | ${quote.industryUpdatedAt || ''}${quote.industryStale ? ' | 历史缓存，更新暂不可用' : ''}`;
  return `<a class="industry-source" href="${escape(url.href)}" title="${escape(title)}" target="_blank" rel="noopener noreferrer">${label}</a>${quote.industryStale ? '<small>历史分类缓存</small>' : ''}`;
}

function renderHoldings() {
  const rows = state.dashboard.holdings.slice(0, 20);
  if (!rows.length) { $('holdingRows').innerHTML = '<tr><td colspan="8">暂无可用股票持仓或不适用</td></tr>'; return; }
  const totalContribution = rows.some(item => Number.isFinite(contribution(item))) ? rows.reduce((sum, item) => {
    const value = contribution(item);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0) : null;

  $("holdingRows").innerHTML = rows.map((item) => {
    const quote = item.quote || {};
    const contributionValue = contribution(item);
    return `
      <tr>
        <td>${item.rank}</td>
        <td>
          <strong>${item.name}</strong>
          <small>${item.code}</small>
          <a class="stock-link" href="${stockSourceUrl(item)}" target="_blank" rel="noreferrer">东方财富详情</a>
        </td>
        <td>${industryLabel(quote)}</td>
        <td>${fmt.format(item.weight)}%</td>
        <td>${quote.price ? fmt.format(quote.price) : "--"}</td>
        <td class="${toneClass(quote.pct || 0)}">${signed(quote.pct)}</td>
        <td class="${toneClass(contributionValue || 0)}">${Number.isFinite(contributionValue) ? signed(contributionValue) : "--"}</td>
        <td class="${toneClass(quote.mainNetInflow || 0)}">${money(quote.mainNetInflow)}</td>
      </tr>
    `;
  }).join("") + `
    <tr class="total-row">
      <td colspan="6"><strong>披露重仓股贡献合计</strong><small>有效涨跌幅 × 净值占比；缺失或过期行情不计入，非完整基金收益</small></td>
      <td class="${toneClass(totalContribution)}"><strong>${signed(totalContribution)}</strong></td>
      <td></td>
    </tr>
  `;
}


$("refreshBtn").addEventListener("click", () => loadDashboard(true).catch(showError));

const stanceMetric = $('stanceMetric');
function showStanceDetails(open) {
  stanceMetric.setAttribute('aria-expanded', String(open));
  $('stancePopover').setAttribute('aria-hidden', String(!open));
}
stanceMetric.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') showStanceDetails(true); });
stanceMetric.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') showStanceDetails(false); });
stanceMetric.addEventListener('focus', () => { if (stanceMetric.matches(':focus-visible')) showStanceDetails(true); });
stanceMetric.addEventListener('blur', () => showStanceDetails(false));
stanceMetric.addEventListener('click', () => {
  if (matchMedia('(hover: none), (pointer: coarse)').matches) showStanceDetails(stanceMetric.getAttribute('aria-expanded') !== 'true');
});
stanceMetric.addEventListener('keydown', event => {
  if (event.key === 'Escape') showStanceDetails(false);
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showStanceDetails(stanceMetric.getAttribute('aria-expanded') !== 'true'); }
});
document.addEventListener('pointerdown', event => { if (!stanceMetric.contains(event.target)) showStanceDetails(false); });

function showError(error) {
  console.error(error);
  $("impactLines").innerHTML = `<p>${error.message || "数据暂时不可用，请稍后刷新。"}</p>`;
}

window.selectFund = code => {
  if (!/^\d{6}$/.test(code)) return;
  try { localStorage.setItem('fund-selected-code', code); } catch {}
  const url = new URL(location.href); url.searchParams.set('fund', code); url.hash = '';
  location.assign(url.href);
};
window.fundReady = (async () => {
  const data = await getJson('/api/funds');
  const requested = new URLSearchParams(location.search).get('fund');
  let remembered;
  try { remembered = localStorage.getItem('fund-selected-code'); } catch {}
  const selected = data.funds.find(f => f.code === requested) || data.funds.find(f => f.code === remembered) || data.funds.find(f => f.code === data.defaultCode) || data.funds[0];
  if (!selected) throw new Error('暂无可选基金，请联系管理员。');
  try { localStorage.setItem('fund-selected-code', selected.code); } catch {}
  if (requested && requested !== selected.code) { const url = new URL(location.href); url.searchParams.set('fund', selected.code); history.replaceState(null, '', url.href); }
  window.currentFund = selected;
  document.title = `${selected.name} · 基金调仓观察`;
  $('fundTitle').textContent = `${selected.name}（${selected.code}）`;
  return selected;
})();
window.fundReady.then(() => loadDashboard()).catch(showError);
