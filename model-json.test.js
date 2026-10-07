const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseObject } = require('../ai-service');
test('accepts JSON with fences, explanations and closed reasoning blocks', () => {
  const object = { summary: 'Text with } and "quotes"', events: [] };
  for (const text of [JSON.stringify(object), '```json\n' + JSON.stringify(object) + '\n```', 'Here is the result:\n' + JSON.stringify(object), '<think>{"not":"evidence"}</think>\n' + JSON.stringify(object)]) assert.deepEqual(parseObject(text), object);
});
test('does not fabricate truncated JSON or pick from ambiguous objects', () => {
  for (const text of ['{"summary":"unfinished', '{"one":1} {"two":2}', 'No structured data', '{"events": [}']) assert.throws(() => parseObject(text), e => e.status === 502);
});
