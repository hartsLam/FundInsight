(() => {
  const $ = (id) => document.getElementById(id);
  const history = [];
  let fund;
  let busy = false;
  let enabled = false;
  let openState = true;
  let closeTimer;
  let unreadEntry = null;
  let nextQuestions = [];
  function readFromStart(entry) {
    if (!openState) { unreadEntry = entry; return; }
    requestAnimationFrame(() => {
      const scroller = $('chatHistory');
      scroller.scrollTop = entry.offsetTop - 20;
    });
  }
  function setOpen(open, focus = false) {
    openState = open;
    clearTimeout(closeTimer);
    const window = $('chatWindow');
    window.inert = !open;
    if (open) {
      window.hidden = false;
      window.classList.remove('chat-closing');
      window.classList.add('chat-opening');
    } else {
      window.classList.remove('chat-opening');
      window.classList.add('chat-closing');
      closeTimer = setTimeout(() => { if (!openState) window.hidden = true; }, 220);
    }
    $('chatLauncher').hidden = open;
    $('chatLauncher').setAttribute('aria-expanded', String(open));
    if (open) $('chatUnread').hidden = true;
    if (open && unreadEntry) { readFromStart(unreadEntry); unreadEntry = null; }
    try { sessionStorage.setItem('fund-chat-minimized', String(!open)); } catch {}
    if (focus) (open ? $('question') : $('chatLauncher')).focus();
  }
  $('minimizeChat').addEventListener('click', () => setOpen(false, true));
  $('chatLauncher').addEventListener('click', () => setOpen(true, true));
  $('chatWindow').addEventListener('keydown', event => { if (event.key === 'Escape') setOpen(false, true); });
  let initialOpen = !matchMedia('(max-width: 720px)').matches;
  try { initialOpen = initialOpen && sessionStorage.getItem('fund-chat-minimized') !== 'true'; } catch {}
  setOpen(initialOpen);
  const time = (date) => date ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '未知';
  async function call(url, payload) {
    const response = await fetch(url, { method: payload ? 'POST' : 'GET', cache: 'no-store',
      headers: payload ? { 'Content-Type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
    if (response.status === 401) { location.href = '/login.html'; throw new Error('请先登录。'); }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI 服务暂时不可用。');
    return data;
  }
  function node(tag, text, className) {
    const result = document.createElement(tag); result.textContent = text; if (className) result.className = className; return result;
  }
  function source(parent, item) {
    let url; try { url = new URL(item.url); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const a = node('a', `[${item.id}] ${item.title}`, 'ai-source'); a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a);
  }
  function brief(value, limit = 140) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    const excerpt = text.slice(0, limit - 1);
    const end = Math.max(excerpt.lastIndexOf('。'), excerpt.lastIndexOf('！'), excerpt.lastIndexOf('？'));
    return end >= limit / 2 ? excerpt.slice(0, end + 1) : `${excerpt}…`;
  }
  async function research() {
    if ($('researchButton').getAttribute('aria-busy') === 'true') return;
    $('researchButton').setAttribute('aria-busy', 'true');
    $('researchButton').textContent = '解读中…';
    $('researchButton').disabled = true; $('researchStatus').textContent = '正在读取新闻与解读…';
    try {
      const report = await call('/api/ai/research', { fund: fund.code });
      const overview = node('div', '', 'ai-editor-note');
      overview.append(node('strong', 'AI 市场综述', 'ai-editor-label'), node('p', brief(report.summary, 180), 'ai-copy'));
      $('researchContent').replaceChildren(overview);
      const sources = new Map(report.sources.map((s) => [s.id, s]));
      for (const event of report.events) {
        const article = node('article', '', 'ai-event news-with-analysis');
        article.append(node('h3', event.title));
        for (const id of event.sourceIds) {
          const item = sources.get(id);
          if (!item) continue;
          const evidence = node('div', '', 'news-evidence');
          source(evidence, item);
          if (item.summary) evidence.append(node('p', brief(item.summary), 'news-excerpt'));
          evidence.append(node('small', `${item.source || '新闻来源'} · ${item.time || '发布时间未提供'}`, 'ai-meta'));
          article.append(evidence);
        }
        const analysis = node('div', '', 'ai-editor-note');
        analysis.append(node('strong', 'AI 助手解读 · 可能影响', 'ai-editor-label'), node('p', brief(event.impact, 220), 'ai-copy'));
        article.append(analysis);
        $('researchContent').append(article);
      }
      if (!report.events.length) $('researchContent').append(node('p', '本轮未识别到证据充分的相关事件。', 'ai-meta'));
      if (report.holdingsNote) $('researchContent').append(node('p', report.holdingsNote, 'ai-meta'));
      $('researchStatus').textContent = `${report.mode} · ${report.cached ? '已复用缓存' : '本轮生成'}\n新闻获取：${time(report.newsAt)} · 解读：${time(report.interpretedAt)}\n市场数据：${time(report.contextAt)} · 缓存到期：${time(report.expiresAt)}`;
    } catch (error) { $('researchStatus').textContent = error.message; }
    finally {
      $('researchButton').disabled = false;
      $('researchButton').setAttribute('aria-busy', 'false');
      $('researchButton').textContent = '更新解读';
    }
  }
  $('researchButton').addEventListener('click', research);
  function bubble(role, text) {
    const entry = node('div', '', `chat-entry chat-${role}`);
    entry.append(node('p', text, 'ai-copy'));
    $('chatHistory').append(entry);
    return entry;
  }
  function scrollChat() { $('chatHistory').scrollTop = $('chatHistory').scrollHeight; }
  function suggestions(choices = []) {
    $('chatSuggestions')?.remove();
    const asked = new Set(history.filter(turn => turn.role === 'user').map(turn => turn.content.trim()));
    choices = Array.isArray(choices) ? [...new Set(choices.filter(text => typeof text === 'string' && text.trim().length >= 4 && text.length <= 60 && !asked.has(text.trim())))].slice(0, 3) : [];
    if (!choices.length) return;
    const group = node('div', '', 'chat-suggestions'); group.id = 'chatSuggestions';
    group.setAttribute('aria-label', '你可能想问');
    for (const text of choices) {
      const button = node('button', text); button.type = 'button'; button.disabled = busy || !enabled;
      button.addEventListener('click', () => {
        if (busy || !enabled) return;
        $('question').value = text;
        $('questionForm').requestSubmit();
      });
      group.append(button);
    }
    $('chatHistory').append(group);
  }
  function answerEvidence(parent, result) {
    const entries = Array.isArray(result.evidence) ? result.evidence : [];
    if (!entries.length && !result.warnings?.length) return;
    const details = node('details', '', 'chat-evidence');
    details.append(node('summary', '分析依据'));
    const number = value => Number.isFinite(value) ? String(value) : '样本不足';
    for (const item of entries) {
      if (item.kind === 'kline') {
        details.append(node('p', `${item.name} (${item.code}) · ${item.period} · ${item.adjustment === 'qfq' ? '前复权' : '未复权或未确认'}\n截至 ${item.asOf} · ${item.bars} 根 · ${item.source}`, 'ai-meta'));
        details.append(node('p', `MA5 ${number(item.ma?.[5])} / MA20 ${number(item.ma?.[20])} / MA60 ${number(item.ma?.[60])}\nRSI14 ${number(item.rsi14)} · DIF ${number(item.macd?.dif)} · DEA ${number(item.macd?.dea)}`, 'ai-meta'));
        } else if (item.kind === 'fund-series') {
          details.append(node('p', `${item.title} · ${item.count} 个数据点\n数据日期：${item.asOf || '未确认'} · ${item.source || ''}${item.stale ? '（历史缓存）' : ''}`, 'ai-meta'));
          if (item.indicators) {
            const i = item.indicators;
            details.append(node('p', `日频单位净值指标 · 截至 ${i.asOf} · ${i.samples} 个完整样本\nMA5 ${number(i.ma[5])} / MA20 ${number(i.ma[20])} / MA60 ${number(i.ma[60])}\nRSI14 ${number(i.rsi14)} · DIF ${number(i.macd?.dif)} · DEA ${number(i.macd?.dea)}\n布林带 ${number(i.boll20?.lower)} / ${number(i.boll20?.middle)} / ${number(i.boll20?.upper)}`, 'ai-meta'));
          }
        } else if (item.kind === 'web') {
          details.append(node('p', `联网检索：${time(item.asOf)} · ${item.cached ? '复用缓存' : '本轮获取'}`, 'ai-meta'));
        } else if (item.kind === 'holdings') {
        details.append(node('p', `持仓披露：${item.reportDate || '未知'}\n看板更新：${time(item.asOf)}${item.stale ? '（历史缓存）' : ''}`, 'ai-meta'));
      } else if (item.kind === 'news') details.append(node('p', `新闻：${time(item.asOf)} · ${item.cached ? '复用缓存' : '本轮获取'}`, 'ai-meta'));
    }
    for (const warning of result.warnings || []) details.append(node('p', warning, 'ai-meta'));
    for (const item of result.sources || []) if (item.id?.startsWith('K')) source(details, item);
    parent.append(details);
  }
  let composing = false;
  async function askStream(payload, onEvent) {
    const response = await fetch('/api/ai/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(payload)
    });
    if (response.status === 401) { location.href = '/login.html'; throw Error('请先登录。'); }
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
      const result = await response.json();
      if (!response.ok) throw Error(result.error || '问答服务暂不可用。');
      return result;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', result;
    function consume(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw Error(event.error);
      if (event.type === 'done') result = event.result;
      else onEvent(event);
    }
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      if (!result) throw Error('连接中断，回答未完成，请重试。');
      return result;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  $('question').addEventListener('compositionstart', () => { composing = true; });
  $('question').addEventListener('compositionend', () => { composing = false; });
  $('question').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
    event.preventDefault();
    if (!busy && enabled && $('question').value.trim()) $('questionForm').requestSubmit();
  });
  $('questionForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const question = $('question').value.trim(); if (!question || busy || !enabled) return;
    busy = true;
    nextQuestions = [];
    try { sessionStorage.removeItem(`fund-chat-suggestions:${fund.code}`); } catch {}
    $('askButton').disabled = true; $('chatStatus').textContent = '';
    $('chatSuggestions')?.remove();
    bubble('user', question);
    $('question').value = '';
    const pending = bubble('assistant', '正在思考中');
    pending.classList.add('chat-thinking');
    const dots = node('span', '', 'thinking-dots');
    for (let i = 0; i < 3; i++) dots.append(node('i', '.'));
    pending.querySelector('p').append(dots);
    scrollChat();
    try {
      let firstText = true;
      const result = await askStream({ question, history, fund: fund.code, chartContext: window.getFundChartContext?.() || null }, event => {
        if (event.type === 'status') {
          $('chatStatus').textContent = event.text;
          if (firstText) pending.querySelector('p').firstChild.textContent = event.text;
        }
        if (event.type === 'answer') {
          pending.classList.remove('chat-thinking');
          pending.replaceChildren(node('p', event.text || '正在重新生成完整回答…', 'ai-copy'));
          $('chatStatus').textContent = '正在生成，完成后将核对引用…';
          if (firstText && event.text) { readFromStart(pending); firstText = false; }
        }
      });
      $('chatStatus').textContent = '';
      pending.classList.remove('chat-thinking');
      pending.replaceChildren(node('p', result.answer, 'ai-copy'));
      if (result.dataAt) pending.append(node('small', `看板更新：${time(result.dataAt)}`, 'ai-meta'));
      answerEvidence(pending, result);
      for (const s of result.sources || []) if (!s.id?.startsWith('K') && result.answer.includes(`[${s.id}]`)) source(pending, s);
      history.push({ role: 'user', content: question }, { role: 'assistant', content: result.answer });
      nextQuestions = Array.isArray(result.followUps) ? result.followUps : [];
      history.splice(0, Math.max(0, history.length - 6));
      try {
        sessionStorage.setItem(`fund-chat:${fund.code}`, JSON.stringify(history));
        sessionStorage.setItem(`fund-chat-suggestions:${fund.code}`, JSON.stringify(nextQuestions));
      } catch {}
      readFromStart(pending);
      if (!openState) $('chatUnread').hidden = false;
    } catch (error) {
      $('chatStatus').textContent = '';
      pending.classList.remove('chat-thinking');
      pending.classList.add('chat-error');
      pending.replaceChildren(node('p', error.message, 'ai-copy'));
      const retry = node('button', '重新编辑'); retry.type = 'button';
      retry.addEventListener('click', () => { if (!$('question').value) $('question').value = question; $('question').focus(); });
      pending.append(retry); readFromStart(pending);
      if (!openState) $('chatUnread').hidden = false;
    }
    finally { busy = false; $('askButton').disabled = !enabled; suggestions(nextQuestions); }
  });
  $('askButton').disabled = true;
  $('researchButton').disabled = true;
  window.fundReady.then(async selected => {
    fund = selected;
    $('chatFundLabel').textContent = `${fund.name}（${fund.code}）`;
    try {
      const saved = JSON.parse(sessionStorage.getItem(`fund-chat:${fund.code}`) || '[]');
      if (Array.isArray(saved)) for (const turn of saved.slice(-6)) {
        if (['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string') { history.push(turn); $('chatEmpty')?.remove(); bubble(turn.role, turn.content); }
      }
    } catch {}
    if (!history.length) {
      const welcome = bubble('assistant', `你好，我是你的基金助手。正在关注${fund.name}，想先了解走势、持仓，还是最近的消息？`);
      welcome.classList.add('chat-welcome');
    }
    if (!history.length) nextQuestions = ['这只基金最近走势怎么样？', '主要持仓有哪些风险？', '最近有什么值得关注的新闻？'];
    else try { nextQuestions = JSON.parse(sessionStorage.getItem(`fund-chat-suggestions:${fund.code}`) || '[]'); } catch {}
    suggestions(nextQuestions);
    return call('/api/ai/status');
  }).then((status) => {
    enabled = status.enabled;
    $('researchButton').disabled = !enabled;
    $('askButton').disabled = !enabled;
    document.querySelectorAll('#chatSuggestions button').forEach(button => { button.disabled = !enabled; });
    if (status.enabled) research();
    else { $('researchStatus').textContent = 'AI 服务未启用。'; $('chatStatus').textContent = 'AI 服务未启用，请联系管理员。'; $('researchButton').disabled = true; $('askButton').disabled = true; }
  }).catch((error) => { $('researchStatus').textContent = error.message; });
})();
