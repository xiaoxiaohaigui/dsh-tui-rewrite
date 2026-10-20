/**
 * The durable write path (R-019).
 *
 * These tests use a hand-built handle/session pair: the point is not the real
 * backend (persistence.test.mjs covers that) but the exact contract of the
 * guard - only this plugin's event types gain `ignorable`, the mapping is
 * idempotent, and a session without a patchable backend is REFUSED instead of
 * being written unresumable.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRewrite, installIgnorableWriteGuard, restoreIgnorableWriteGuard,
  rewriteWriteStatus, resetWriteStatus, REWRITE_RECORD_TYPE,
} from 'dsh-tui-rewrite/persist';
import { REWRITE_EVENT_TYPE } from 'dsh-tui-rewrite/projection';

after(() => restoreIgnorableWriteGuard());

class FakeHandle {
  appended = [];
  live = [];
  append(events) { this.appended.push(...events); }
  enqueueLive(event) { this.live.push(event); }
}

function fixture({ withWriter = true } = {}) {
  const handle = new FakeHandle();
  const writers = new Map();
  if (withWriter) writers.set('s1', handle);
  const persistence = { writers };
  const ctx = { get: (name, fallback) => (name === 'sessionPersistence' ? persistence : fallback) };
  let seq = 0;
  const session = {
    id: 's1',
    append(type, data) {
      const event = { type, seq: seq++, time: 1, data };
      handle.enqueueLive(event);
      return event;
    },
    eventAt(wanted) { return this.log?.find(event => event.seq === wanted); },
  };
  return { ctx, handle, persistence, session };
}

test('the guard marks this plugin\'s persisted events, and nothing else', () => {
  const { handle, persistence } = fixture();
  assert.equal(installIgnorableWriteGuard(persistence, 's1'), true);

  handle.append([
    { type: REWRITE_RECORD_TYPE, seq: 0, time: 1, data: {} },
    { type: REWRITE_EVENT_TYPE, seq: 1, time: 2, data: {} },
    { type: 'assistant/message', seq: 2, time: 3, data: {} },
  ]);
  handle.enqueueLive({ type: REWRITE_RECORD_TYPE, seq: 3, time: 4, data: {} });

  assert.equal(handle.appended[0].ignorable, true);
  assert.equal(handle.appended[1].ignorable, true, 'legacy events are still repaired when they pass through');
  assert.equal('ignorable' in handle.appended[2], false, 'unrelated events are untouched');
  assert.equal(handle.live[0].ignorable, true, 'the live routing point carries the marker');
});

test('the guard is idempotent and survives a second install', () => {
  const { handle, persistence } = fixture();
  assert.equal(installIgnorableWriteGuard(persistence, 's1'), true);
  assert.equal(installIgnorableWriteGuard(persistence, 's1'), true);
  handle.append([{ type: REWRITE_RECORD_TYPE, seq: 0, time: 1, data: {} }]);
  assert.equal(handle.appended[0].ignorable, true);
});

test('restoring the guard puts the backend methods back', () => {
  const { handle, persistence } = fixture();
  const before = Object.getPrototypeOf(handle);
  assert.equal(installIgnorableWriteGuard(persistence, 's1'), true);
  restoreIgnorableWriteGuard();

  handle.append([{ type: REWRITE_RECORD_TYPE, seq: 0, time: 1, data: {} }]);
  handle.enqueueLive({ type: REWRITE_RECORD_TYPE, seq: 1, time: 2, data: {} });
  assert.equal('ignorable' in handle.appended[0], false);
  assert.equal('ignorable' in handle.live[0], false);
  assert.equal(Object.getPrototypeOf(handle), before);
});

test('appendRewrite falls back to the guard when the official helper is foreign or absent', () => {
  resetWriteStatus();
  const { ctx, handle, session } = fixture();
  const event = appendRewrite(ctx, session, { targetSeq: 0, content: 'TEXT' });

  assert.equal(event.type, REWRITE_RECORD_TYPE);
  assert.equal(rewriteWriteStatus().mode, 'guard');
  assert.equal(handle.live[0].type, REWRITE_RECORD_TYPE);
  assert.equal(handle.live[0].ignorable, true, 'the persisted copy carries the marker');
});

test('appendRewrite refuses instead of writing an unresumable event', () => {
  resetWriteStatus();
  const { ctx, session } = fixture({ withWriter: false });
  assert.throws(
    () => appendRewrite(ctx, session, { targetSeq: 0, content: 'TEXT' }),
    /refusing to append/u,
  );
  assert.equal(rewriteWriteStatus().mode, 'unavailable');
  assert.match(rewriteWriteStatus().reason, /write handle/u);
});
