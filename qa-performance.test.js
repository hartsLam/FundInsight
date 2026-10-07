const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { simpleKnowledge, mapLimit, answerPrefix, readModelStream } = require('../qa-performance');
const { createAIService } = require('../ai-service');

test('fast lane excludes contextual, current, ambiguous and advisory questions', () => {
  for (const q of ['什么是基金单位净值？', '基金定投是什么', '请解释基金管理费', '请用两句话解释基金单位净值是什么，不需要查询行情或新闻。']) assert.equal(simpleKnowledge(q, []), true, q);
  for (const q of ['今天基金净值是多少', '单位净值低可以买入吗', '介绍162201', '基金定投是什么，最近适合吗']) assert.equal(simpleKnowledge(q, []), false, q);
  assert.equal(simpleKnowledge('什么是基金单位净值', [{ role: 'user', content: '上一问' }]), false);
});

test('parallel map preserves order and limits active jobs', async () => {
  let active = 0, peak = 0;
  const result = await mapLimit([30, 2, 1], 2, async ms => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, ms)); active--; return ms;
  });
  assert.deepEqual(result, [30, 2, 1]); assert.equal(peak, 2);
});

test('answer preview handles escaped quotes and Unicode without exposing other fields', () => {
  assert.equal(answerPrefix('{"answer":"你好\\n\\"净值\\"\\u4e2d\\u'), '你好\n"净值"中');
  assert.equal(answerPrefix('{"answer":"好","searchQueries":["secret"]}'), '好');
  assert.equal(answerPrefix('<think>private</think>{"answer":"好"}'), '');
  assert.equal(answerPrefix('{"searchQueries":["x"],"answer":"好"}'), '');
});

function streamResponse(parts, complete = true) {
  const events = parts.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`).join('') +
    (complete ? 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(events);
  return new Response(new ReadableStream({ start(controller) {
    // Split inside multibyte characters, JSON escapes and SSE delimiters.
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('SSE parser emits answer progressively and refuses interrupted output', async () => {
  const updates = [];
  const result = await readModelStream(streamResponse(['{"answer":"你', '好","followUps":[],"searchQueries":[]}']), text => updates.push(text));
  assert.deepEqual(updates, ['你', '你好']); assert.equal(result.choices[0].finish_reason, 'stop');
  await assert.rejects(readModelStream(streamResponse(['{"answer":"unfinished'], false), () => {}), /未完成/);
});

function service(t, request) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-qa-speed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'admin-password.txt'), 'test-only');
  fs.writeFileSync(path.join(dir, 'admin-settings.json'), JSON.stringify({ enabled: true, endpoint: 'https://8.8.8.8/v1', apiKey: 'test-only', model: 'mock' }));
  return createAIService({ dataDir: dir, getDashboard: async () => { throw Error('Fast lane must not fetch dashboard'); }, getNews: async () => { throw Error('Must not fetch news'); }, request });
}

test('knowledge fast lane makes one model call and emits text before final result', async t => {
  let calls = 0; const updates = [];
  const s = service(t, async (_, options) => {
    calls++; assert.equal(JSON.parse(options.body).stream, true);
    return streamResponse(['{"answer":"基金净值', '是每份基金的价值。","followUps":[],"searchQueries":[]}']);
  });
  const result = await s.ask('什么是基金单位净值？', [], '162201', null, null, event => updates.push(event));
  assert.equal(calls, 1); assert.equal(result.intent, 'knowledge');
  assert(updates.some(event => event.type === 'answer' && event.text === '基金净值'));
  assert.deepEqual(result.timings.stages.map(s => s.stage), ['answer']);
});

test('unsupported streaming falls back once without requiring server changes', async t => {
  let calls = 0;
  const s = service(t, async (_, options) => {
    calls++; const body = JSON.parse(options.body);
    if (body.stream) return new Response('', { status: 400 });
    return Response.json({ choices: [{ message: { content: '{"answer":"基金净值是每份基金的价值。","followUps":[],"searchQueries":[]}' }, finish_reason: 'stop' }] });
  });
  assert.equal((await s.ask('什么是基金单位净值？')).intent, 'knowledge'); assert.equal(calls, 2);
});

test('HTTP stream includes progress and final result, while auth remains enforced', async t => {
  const s = service(t, async () => streamResponse(['{"answer":"净值是每份基金的价值。","followUps":[],"searchQueries":[]}']));
  const server = http.createServer((req, res) => {
    s.handle(req, res, new URL(req.url, 'http://localhost'), req.headers.authorization === 'test', (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/ai/ask`;
  const options = { method: 'POST', headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '什么是基金单位净值？' }) };
  assert.equal((await fetch(url, options)).status, 401);
  const response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: 'test' } });
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert(events.some(e => e.type === 'status')); assert(events.some(e => e.type === 'answer'));
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).result.intent, 'knowledge');
});
