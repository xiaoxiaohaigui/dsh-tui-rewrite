/**
 * R-019 regression + D5: a rewrite must survive a REAL disk round trip.
 *
 * The seed path (`SessionStore.create({seed})`) never exercises the persistence
 * reader's vocabulary gate, which is exactly why 91 in-memory tests missed
 * R-019. This test writes through the real JSONL backend, closes the handle,
 * opens a fresh backend instance over the same directory, and asserts:
 *
 * - the stored event is `plugin:dsh-tui-rewrite/message` with `ignorable: true`;
 * - the log still opens (the failure R-019 described);
 * - the projection still rewrites the model-visible text;
 * - a fork-like prefix append (the in-memory seed path) carries the marker too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as dshSession from '@deepseek-ai/dsh-session';
import { SessionStore, foldSurface } from '@deepseek-ai/dsh-session';
import { appendRewrite, restoreIgnorableWriteGuard, rewriteWriteStatus, REWRITE_RECORD_TYPE } from 'dsh-tui-rewrite/persist';
import { rewriteProjection } from 'dsh-tui-rewrite/projection';
import { CORE_DIR, loadSampleSession } from '../tools.mjs';

const settle = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
const textOf = message => (message?.content ?? [])
  .filter(part => part.type === 'text')
  .map(part => part.text)
  .join('');

// The backend is resolved from the SAME @deepseek-ai copy the fixture links, so
// the Session class used by ctx.sessions and the backend's own reader agree.
const backendModule = await import(pathToFileURL(join(CORE_DIR, 'dsh-session-persistence-jsonl', 'lib', 'index.js')).href);
const Backend = typeof backendModule.default === 'function' ? backendModule.default : backendModule;

async function backendAt(root) {
  const ctx = new Context();
  ctx.plugin(SessionStore);
  ctx.plugin(Backend, { root });
  await settle();
  return ctx;
}

test('a rewrite survives the real JSONL round trip and still resumes', async () => {
  const { header, events } = loadSampleSession();
  const target = events.find(event => event.type === 'assistant/message'
    && Array.isArray(event.data?.message?.content)
    && event.data.message.content.some(part => part.type === 'text'));
  const prefix = events.slice(0, target.seq + 1);
  const content = '<<DISK ROUND TRIP>>';
  const id = 'round-trip';
  const root = mkdtempSync(join(tmpdir(), 'dsh-rewrite-disk-'));

  // Write: a real store session bound to a real write handle, the same shape
  // the agent loop uses (stored prefix first, then live events).
  const writeCtx = await backendAt(root);
  const persistence = writeCtx.get('sessionPersistence');
  const handle = await persistence.create({ version: 4, id, createdAt: Date.now(), isSeeded: false }, {});
  const live = writeCtx.sessions.create(id, { seed: prefix, meta: { cwd: header.cwd } });
  const stored = live.snapshotEvents();
  await handle.append(stored);

  const written = appendRewrite(writeCtx, live, { targetSeq: target.seq, content });
  assert.equal(written.type, REWRITE_RECORD_TYPE);
  // The suite runs against whatever dsh-session the fixture links: the official
  // record API on >= 0.2.1-rc.2, the guarded append on 0.2.0. Both must land the
  // same event, and this assertion proves WHICH path the run exercised.
  const officialAvailable = typeof dshSession.appendPluginRecord === 'function';
  assert.equal(rewriteWriteStatus().mode, officialAvailable ? 'official' : 'guard');
  await persistence.flush();
  await handle.close();

  // Read: a FRESH backend instance over the same directory. This is the call
  // that failed with "not marked ignorable" before the fix.
  const readCtx = await backendAt(root);
  const reader = await readCtx.get('sessionPersistence').open(id, 'read');
  const read = await reader.read();
  await reader.close();

  assert.equal(read.events.length, stored.length + 1);
  const record = read.events.at(-1);
  assert.equal(record.type, REWRITE_RECORD_TYPE);
  assert.equal(record.ignorable, true, 'the persistence reader accepts this event');
  assert.equal(record.surfaceOp, undefined, 'a non-surface event must not carry surfaceOp');
  assert.equal(textOf(read.events[target.seq].data.message).includes(content), false, 'the log keeps the original');

  const fold = foldSurface(read.events, [{ type: REWRITE_RECORD_TYPE, project: rewriteProjection.project }]);
  assert.equal(textOf(fold.projectedMessages.get(target.seq)), content, 'the model sees the rewrite');
  assert.equal(fold.nodes.length, live.surface.nodes.length, 'the surface is unchanged');

  // Fork-like: the child prefix is written from the parent's IN-MEMORY events.
  // On 0.2.0 those lack the marker; the guarded append must add it.
  const childId = 'round-trip-child';
  const child = await readCtx.get('sessionPersistence').create(
    { version: 4, id: childId, createdAt: Date.now(), isSeeded: false },
    {},
  );
  await child.append(live.snapshotEvents());
  await readCtx.get('sessionPersistence').flush();
  await child.close();

  const childReader = await (await backendAt(root)).get('sessionPersistence').open(childId, 'read');
  const childRead = await childReader.read();
  await childReader.close();
  assert.equal(childRead.events.at(-1).ignorable, true, 'a fork-like prefix carries the marker');
  assert.equal(childRead.events.at(-1).type, REWRITE_RECORD_TYPE);

  restoreIgnorableWriteGuard();
});
