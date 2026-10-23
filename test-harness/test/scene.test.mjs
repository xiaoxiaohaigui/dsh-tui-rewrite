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
  cellWidth, clusterWidth, textWidth, clipCells, messageText, previewOf, units,
  lineStartOf, lineEndOf, rowOf, wheelRows, collectTargets,
  isWordBoundary, wordRangeAt,
} from 'dsh-tui-rewrite/scene';

test('units splits by grapheme cluster, so one glyph edits as one unit', () => {
  assert.equal(units('a\nb').length, 3);
  assert.equal(units('👍!').length, 2);
  // R-020: code points would split every one of these into several units.
  assert.equal(units('👍🏽').length, 1, 'skin-tone modifier stays with its emoji');
  assert.equal(units('👨‍👩‍👧‍👦').length, 1, 'ZWJ family is one glyph');
  assert.equal(units('e\u0301').length, 1, 'combining accent is one glyph');
  assert.equal(units('1️⃣').length, 1, 'keycap sequence is one glyph');
  assert.equal(units('🇨🇳').length, 1, 'flag pair is one glyph');
  // Newlines stay their own unit even for CRLF input.
  assert.deepEqual(units('a\r\nb'), ['a', '\r', '\n', 'b']);
  assert.deepEqual(units(''), []);
});

test('cellWidth gives CJK and emoji two cells', () => {
  assert.equal(cellWidth('a'.codePointAt(0)), 1);
  assert.equal(cellWidth('你'.codePointAt(0)), 2);
  assert.equal(cellWidth('（'.codePointAt(0)), 2);
  assert.equal(cellWidth('👍'.codePointAt(0)), 2);
  // R-020: these are Emoji_Presentation symbols even though a caseless range
  // check used to call them narrow.
  assert.equal(cellWidth('✅'.codePointAt(0)), 2);
  assert.equal(cellWidth('⚡'.codePointAt(0)), 2);
  assert.equal(cellWidth('⏰'.codePointAt(0)), 2);
  assert.equal(cellWidth('⌛'.codePointAt(0)), 2);
  // A text-default symbol without VS16 renders narrow (the host's rule).
  assert.equal(cellWidth('⚠'.codePointAt(0)), 1);
  assert.equal(cellWidth('❤'.codePointAt(0)), 1);
});

test('textWidth measures grapheme clusters, not code points', () => {
  assert.equal(clusterWidth('👍🏽'), 2, 'skin tone adds no cells');
  assert.equal(textWidth('👍🏽👍🏽'), 4);
  assert.equal(clusterWidth('👨‍👩‍👧‍👦'), 2, 'a ZWJ family is one two-cell glyph');
  assert.equal(textWidth('👨‍👩‍👧‍👦x'), 3);
  assert.equal(textWidth('🇨🇳'), 2);
  assert.equal(textWidth('🇨'), 1, 'a lone regional indicator is narrow');
  assert.equal(textWidth('1️⃣'), 2, 'keycap sequence');
  assert.equal(textWidth('1️'), 1, 'digit + VS16 without U+20E3 is incomplete');
  assert.equal(textWidth('e\u0301'), 1, 'combining mark adds no cells');
  assert.equal(textWidth('❤'), 1);
  assert.equal(textWidth('❤️'), 2, 'VS16 forces emoji presentation');
  assert.equal(textWidth('中文 a'), 6);
  // A Devanagari virama+ZWJ conjunct uses the same U+200D but is not an emoji
  // sequence: it renders as one narrow glyph.
  assert.equal(clusterWidth('\u0915\u094d\u200d\u0937'), 1);
  assert.equal(textWidth(''), 0);
});

test('clipCells never splits a grapheme cluster', () => {
  // "a" + one 2-cell emoji exactly fills 3 cells; the remaining b is what
  // triggers the ellipsis, not a split glyph.
  assert.equal(clipCells('a👍🏽b', 3), 'a👍🏽…');
  assert.equal(clipCells('a👍🏽', 3), 'a👍🏽');
  // One cell short: the emoji does not fit, so it is replaced by the ellipsis
  // rather than being cut in half.
  assert.equal(clipCells('a👍🏽b', 2), 'a…');
  assert.equal(clipCells('👨‍👩‍👧‍👦', 2), '👨‍👩‍👧‍👦');
  assert.equal(clipCells('👨‍👩‍👧‍👦x', 2), '👨‍👩‍👧‍👦…');
});

test('word seams follow ICU words, including CJK', () => {
  // Latin: inside a word vs after it.
  assert.equal(isWordBoundary('hello', 2), false);
  assert.equal(isWordBoundary('hello world', 5), true, 'a space is a boundary');
  // CJK: 你好 is one ICU word, 世界 another - so typing folds per word instead
  // of per character (R-023).
  assert.equal(isWordBoundary('你好世界', 1), false);
  assert.equal(isWordBoundary('你好世界', 2), true);
  assert.equal(isWordBoundary('', 0), true);
  assert.equal(isWordBoundary('abc', 3), true);

  assert.deepEqual(wordRangeAt('hello world', 6), { start: 6, end: 11 });
  assert.deepEqual(wordRangeAt('hello world', 5), { start: 5, end: 6 }, 'the space is its own interval');
  assert.deepEqual(wordRangeAt('你好世界', 1), { start: 0, end: 2 }, 'the ICU segment 你好');
  assert.deepEqual(wordRangeAt('👍🏽x', 0), { start: 0, end: 1 }, 'non-word-like cluster');
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

test('lineEndOf finds the line terminator, and clamps a stale caret', () => {
  const chars = units('ab\ncd\nef');
  assert.equal(lineEndOf(chars, 0), 2, 'the terminator itself, which is the line\'s end column');
  assert.equal(lineEndOf(chars, 2), 2, 'ending exactly on the newline stays there');
  assert.equal(lineEndOf(chars, 4), 5);
  assert.equal(lineEndOf(chars, 5), 5);
  // the last line has no terminator: the buffer end is its end
  assert.equal(lineEndOf(chars, 6), 8);
  assert.equal(lineEndOf(chars, 8), 8);
  // a caret past the end (a shorter draft after a deletion) must not run away
  assert.equal(lineEndOf(chars, 99), 8);
  // a trailing newline is a real empty last line, not a clamp to the end
  assert.equal(lineEndOf(units('ab\n'), 0), 2);
  assert.equal(lineEndOf(units('ab\n'), 3), 3);
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