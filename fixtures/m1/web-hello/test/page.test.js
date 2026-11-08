const { test } = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/page.js');

test('page renders one non-empty, escaped h1 and a title', () => {
  const html = render();
  const headings = html.match(/<h1>([^<]*)<\/h1>/g) ?? [];
  assert.equal(headings.length, 1);
  assert.notEqual(headings[0], '<h1></h1>');
  assert.match(html, /<title>[^<]+<\/title>/);
});
