// Deliberately narrow: ambiguous, contextual or current-market questions still use planning.
function simpleKnowledge(question, history) {
  if (history.length) return false;
  const text = question.trim().replace(/[？?。！!]/g, '')
    .replace(/[,，]不需要查询行情或新闻$/, '')
    .replace(/^(?:请)?(?:(?:用(?:两句|一句)话|用通俗语言|用简单语言|简单|简要))?(?:解释(?:一下)?|介绍(?:一下)?)/, '');
  return /^(?:什么是)?(?:基金单位净值|单位净值|累计净值|基金净值|基金申购|基金赎回|基金定投|基金管理费|基金托管费|指数基金|混合基金|股票型基金)(?:(?:是)?什么(?:意思)?|的含义)?$/.test(text);
}

async function mapLimit(items, limit, job) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await job(items[i], i); }
  }));
  return results;
}

// Only expose a leading answer field, never reasoning, tool queries or incomplete escapes.
function answerPrefix(raw) {
  const match = /^\s*\{\s*"answer"\s*:\s*"((?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*)/.exec(raw);
  if (!match) return '';
  try { return JSON.parse(`"${match[1]}"`).replace(/[\uD800-\uDBFF]$/, ''); } catch { return ''; }
}

async function readModelStream(response, onText) {
  if (!response.headers?.get('content-type')?.includes('text/event-stream')) return response.json();
  const decoder = new TextDecoder();
  let buffer = '', content = '', finish = null, done = false, last = '';
  function line(raw) {
    if (!raw.startsWith('data:')) return;
    const payload = raw.slice(5).trim();
    if (payload === '[DONE]') { done = true; return; }
    const event = JSON.parse(payload);
    if (event.error) throw new Error('模型流式响应失败。');
    const choice = event.choices?.[0];
    if (!choice) return;
    if (typeof choice.delta?.content === 'string') content += choice.delta.content;
    if (content.length > 200000) throw new Error('模型输出超过长度限制。');
    if (choice.finish_reason) finish = choice.finish_reason;
    const answer = answerPrefix(content);
    if (answer && answer !== last) { last = answer; onText(answer); }
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1); }
    if (buffer.length > 200000) throw new Error('模型响应格式异常。');
  }
  buffer += decoder.decode();
  if (buffer.trim()) line(buffer.trim());
  if (!done || !finish) throw new Error('模型连接中断，回答未完成，请重试。');
  return { choices: [{ finish_reason: finish, message: { content } }] };
}

module.exports = { simpleKnowledge, mapLimit, answerPrefix, readModelStream };
