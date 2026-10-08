import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatLinkPattern, chatLinkUrl } from '../extension/chat-links.ts';
test('local and web chat destinations resolve without a webpage base', () => {
  const folders = { cwd: '/tmp/lessons', home: '/home/fixture', artifactsDir: '/tmp/artifacts' };
  for (const [input, expected] of [
    ['file:///tmp/test.html', 'file:///tmp/test.html'], ['/tmp/test page.html', 'file:///tmp/test%20page.html'],
    ['test.html', 'file:///tmp/lessons/test.html'], ['../test.html', 'file:///tmp/test.html'],
    ['~/autoum/test.html', 'file:///home/fixture/autoum/test.html'], ['C:\\lessons\\test.html', 'file:///C:/lessons/test.html'],
    ['https://example.com', 'https://example.com/'], ['//example.com/page', 'https://example.com/page'],
  ]) { assert.equal(chatLinkPattern.test(input), true, input); assert.equal(chatLinkUrl(input, folders).href, expected); }
  assert.equal(chatLinkUrl('lesson.html', { artifactsDir: '/tmp/artifacts' }).href, 'file:///tmp/artifacts/lesson.html');
  for (const input of ['javascript:alert(1)', 'data:text/html,bad', 'vbscript:bad', 'blob:https://example.com/id', 'chrome://settings']) {
    assert.equal(chatLinkPattern.test(input), false, input); assert.throws(() => chatLinkUrl(input, folders));
  }
  assert.throws(() => chatLinkUrl('')); assert.throws(() => chatLinkUrl('relative.html'));
});
