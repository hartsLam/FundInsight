function queriesFrom(value) {
  return Array.isArray(value) ? [...new Set(value.filter(q => typeof q === 'string').map(q => q.trim().slice(0, 180)).filter(Boolean))].slice(0, 2) : [];
}

function answerFrom(raw, parseObject, question, history) {
  let value;
  try { value = parseObject(raw); }
  catch (error) {
    if (/^\s*(?:\{|```)/.test(raw)) throw error;
    return { answer: raw, followUps: [], searchQueries: [] };
  }
  if (typeof value.answer !== 'string' || !value.answer.trim()) throw Error('模型没有返回完整回答，请重试。');
  const asked = new Set([question, ...history.filter(turn => turn.role === 'user').map(turn => turn.content)].map(text => text.trim().replace(/[？?。\s]/g, '')));
  const followUps = Array.isArray(value.followUps) ? [...new Set(value.followUps.filter(q => typeof q === 'string').map(q => q.trim()).filter(q => q.length >= 4 && q.length <= 60 && !asked.has(q.replace(/[？?。\s]/g, ''))))].slice(0, 3) : [];
  return { answer: value.answer.trim(), followUps, searchQueries: queriesFrom(value.searchQueries) };
}

function needsMoreEvidence(answer) {
  return /信息不足|资料不足|数据不足|本轮(?:没有|缺少)|未(?:能)?(?:获取|取得|提供)|缺少.{0,18}(?:信息|数据|资料)|(?:无法|不能).{0,16}(?:判断|回答|分析|确认|核实)/.test(answer);
}

module.exports = { queriesFrom, answerFrom, needsMoreEvidence };
