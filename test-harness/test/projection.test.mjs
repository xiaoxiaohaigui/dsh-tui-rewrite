/**
 * Unit tests for the projection's pure rewrite function.
 *
 * The projection's contract with the session machinery is covered by the
 * integration suite; this file pins the content rule the rewrite itself applies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRewrite, REWRITE_EVENT_TYPE, rewriteProjection } from 'dsh-tui-rewrite/projection';

test('the event type is namespaced, so it cannot shadow a core type', () => {
  assert.equal(REWRITE_EVENT_TYPE, 'dsh-tui-rewrite/message');
  assert.equal(rewriteProjection.type, REWRITE_EVENT_TYPE);
});

test('the first text part receives the new content', () => {
  const next = applyRewrite({ role: 'assistant', content: [{ type: 'text', text: 'old' }] }, 'new');
  assert.deepEqual(next.content, [{ type: 'text', text: 'new' }]);
});

test('later text parts are dropped rather than left to leak the original', () => {
  const next = applyRewrite({ role: 'assistant', content: [
    { type: 'text', text: 'old-a' },
    { type: 'tool-call', name: 'pwsh', arguments: '{}' },
    { type: 'text', text: 'old-b' },
  ] }, 'new');
  assert.deepEqual(next.content, [
    { type: 'text', text: 'new' },
    { type: 'tool-call', name: 'pwsh', arguments: '{}' },
  ]);
});

test('non-text parts survive by value', () => {
  const next = applyRewrite({ role: 'assistant', content: [
    { type: 'thinking', text: 'reasoning' },
    { type: 'text', text: 'old' },
  ] }, 'new');
  assert.deepEqual(next.content[0], { type: 'thinking', text: 'reasoning' });
  assert.deepEqual(next.content[1], { type: 'text', text: 'new' });
});

test('a message with no text part gains one at the front', () => {
  const next = applyRewrite({ role: 'assistant', content: [{ type: 'tool-call', name: 'pwsh' }] }, 'new');
  assert.deepEqual(next.content[0], { type: 'text', text: 'new' });
});

test('the input message is never mutated', () => {
  const original = { role: 'assistant', content: [{ type: 'text', text: 'old' }] };
  const snapshot = JSON.stringify(original);
  applyRewrite(original, 'new');
  assert.equal(JSON.stringify(original), snapshot);
});

test('the rewrite itself never leaks the original text', () => {
  const original = { role: 'assistant', content: [{ type: 'text', text: 'SECRET-TOKEN' }] };
  const next = applyRewrite(original, 'redacted');
  assert.ok(!JSON.stringify(next).includes('SECRET-TOKEN'));
});
