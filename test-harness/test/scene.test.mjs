/**
 * Unit tests for the scene's pure helpers.
 *
 * The scene component itself needs the host React reconciler and a terminal, so
 * its logic is factored into pure functions that CAN be verified headlessly.
 * The interactive shell (hooks, mouse, key routing) is exercised on-device.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellWidth, clipCells, messageText, previewOf, units,
  lineStartOf, rowOf, wheelRows, collectTargets,
} from 'dsh-tui-rewrite/scene';

test('units splits by code point so astral characters edit as one', () => {
  assert.equal(units('a\nb').length, 3);
  assert.equal(units('👍!').length, 2);
});

test('cellWidth gives CJK and emoji two cells', () => {
  assert.equal(cellWidth('a'.codePointAt(0)), 1);
  assert.equal(cellWidth('你'.codePointAt(0)), 2);
  assert.equal(cellWidth('（'.codePointAt(0)), 2);
  assert.equal(cellWidth('👍'.codePointAt(0)), 2);
});

test('clipCells budgets in cells, not characters, and marks the cut', () => {
  assert.equal(clipCells('abcdef', 3), 'abc…');
  assert.equal(clipCells('abc', 3), 'abc');
  // two CJK chars fill a 4-cell budget exactly, so nothing is clipped
  assert.equal(clipCells('你好', 4), '你好');
  // a third one does not fit and the ellipsis replaces it
  assert.equal(clipCells('你好吗', 4), '你好…');
});

test('messageText keeps the message text verbatim and skips non-text parts', () => {
  const message = { role: 'assistant', content: [
    { type: 'text', text: 'first' },
    { type: 'tool-call', id: 'x', name: 'pwsh', arguments: '{}' },
    { type: 'text', text: 'second' },
  ] };
  assert.equal(messageText(message), 'first\nsecond');
  assert.equal(messageText(undefined), '');
});

test('previewOf flattens whitespace and clips to the preview budget', () => {
  assert.equal(previewOf('  a\n\n  b  '), 'a b');
  assert.equal(previewOf('   \n '), '(no text)');
  assert.ok(previewOf('x'.repeat(500)).endsWith('…'));
  assert.ok(previewOf('x'.repeat(500)).length <= 65);
});

test('lineStartOf finds the first unit of the caret line', () => {
  const chars = units('ab\ncd\nef');
  assert.equal(lineStartOf(chars, 0), 0);
  assert.equal(lineStartOf(chars, 2), 0);
  assert.equal(lineStartOf(chars, 3), 3);
  assert.equal(lineStartOf(chars, 6), 6);
});

test('rowOf counts newlines before the caret', () => {
  const chars = units('ab\ncd\nef');
  assert.equal(rowOf(chars, 0), 0);
  assert.equal(rowOf(chars, 3), 1);
  assert.equal(rowOf(chars, 6), 2);
});

test('wheelRows normalizes a notch and refuses horizontal-only events', () => {
  assert.equal(wheelRows(3, 0), 3);
  assert.equal(wheelRows(-3, 0), -3);
  assert.equal(wheelRows(0.4, 0), 1);
  assert.equal(wheelRows(0, 5), 0);
  assert.equal(wheelRows(Number.NaN, 0), 0);
});

test('collectTargets enumerates only assistant messages that carry text', async () => {
  // Real session + real store: the enumeration pairs each surface node with its
  // own event, so this is the only honest way to test it.
  const { Context } = await import('@deepseek-ai/cordis');
  const { SessionStore } = await import('@deepseek-ai/dsh-session');
  const { loadSampleSession } = await import('../tools.mjs');
  const { header, events } = loadSampleSession();
  const root = new Context();
  root.plugin(SessionStore);
  await new Promise(resolve => setTimeout(resolve, 30));
  const session = root.sessions.create('scene-probe', { seed: events, meta: { cwd: header.cwd } });

  const targets = collectTargets(session);
  assert.ok(targets.length > 0, 'expected at least one assistant reply');

  // every target pairs a surface node with a real assistant message
  for (const target of targets) {
    assert.equal(typeof target.seq, 'number');
    const message = session.deriveEventMessage(session.eventAt(target.seq));
    assert.equal(message.role, 'assistant');
    assert.equal(messageText(message), target.original);
    assert.ok(target.original.length > 0);
  }
  // seqs are unique and in model order
  const seqs = targets.map(target => target.seq);
  assert.deepEqual(seqs, [...new Set(seqs)]);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

  // and the enumeration is stable across the projection-free session
  assert.deepEqual(collectTargets(session).map(t => t.seq), seqs);
});

test('collectTargets sees the PROJECTED text, not the log original', async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { SessionStore } = await import('@deepseek-ai/dsh-session');
  const { default: plugin } = await import('dsh-tui-rewrite');
  const { REWRITE_EVENT_TYPE } = await import('dsh-tui-rewrite/projection');
  const { loadSampleSession } = await import('../tools.mjs');
  const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

  const { header, events } = loadSampleSession();
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const host = root.plugin(plugin);
  await settle();
  const session = root.sessions.create('scene-projected', { seed: events, meta: { cwd: header.cwd } });

  const first = collectTargets(session)[0];
  session.append(REWRITE_EVENT_TYPE, { targetSeq: first.seq, content: 'PROJECTED-VIEW' });
  const after = collectTargets(session).find(target => target.seq === first.seq);
  assert.equal(after.original, 'PROJECTED-VIEW');
  // the log is untouched - what the editor shows is what the model sees
  const logged = session.eventAt(first.seq);
  assert.notEqual(JSON.stringify(logged.data.message).includes('PROJECTED-VIEW'), true);
  await host.dispose();
});

test('collectTargets degrades on a session shape from another kernel', () => {
  assert.deepEqual(collectTargets({ surface: {} }), []);
  assert.deepEqual(collectTargets({}), []);
  assert.deepEqual(collectTargets(undefined), []);
});

test('collectTargets skips a node whose derivation throws', () => {
  const session = {
    surface: { nodes: [1, 2] },
    eventAt: seq => ({ seq }),
    deriveEventMessage: event => {
      if (event.seq === 1) throw new Error('projection missing');
      return { role: 'assistant', content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const targets = collectTargets(session);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].seq, 2);
});