/**
 * How a rewrite becomes a durable log event.
 *
 * TWO WRITE PATHS, ONE EVENT SHAPE.
 *
 * 1. **Official plugin record (dsh-session >= 0.2.1-rc.2).** `appendPluginRecord`
 *    writes an event whose type lives outside `SessionEventMap`, with the
 *    envelope marker `ignorable: true`. The persistence read path accepts it,
 *    fork and resume carry it, and the projection still sees it. This is the
 *    path R-019 asked for: the session stays resumable without touching the
 *    core event vocabulary.
 *
 * 2. **Guarded append (older runtimes).** `Session.append` has no way to set
 *    `ignorable`, so on dsh 0.2.0 the plugin patches the JSONL backend's
 *    per-session handle for the duration of the process: `enqueueLive` is the
 *    live routing point and `append` is the prefix/seed path (fork). Both get
 *    the marker on the PERSISTED copy for this plugin's event types only. The
 *    in-memory event stays unmarked, which is harmless: `ignorable` is a
 *    reader-side compatibility marker, and the fork prefix goes through the
 *    patched `append`.
 *
 * The guard is a deliberate, bounded private-API bridge: if either method is
 * absent (a different persistence backend), the write is REFUSED with a visible
 * error instead of producing a session that cannot be reopened. R-019 taught
 * exactly that failure mode.
 *
 * @module dsh-tui-rewrite/persist
 */
import * as dshSession from '@deepseek-ai/dsh-session';
import { REWRITE_EVENT_TYPE } from './projection.js';

/**
 * The event type for NEW rewrites: the official plugin-record namespace.
 *
 * The legacy type (`dsh-tui-rewrite/message`) stays readable through the
 * separate legacy projection, so logs written before this change still work.
 */
export const REWRITE_RECORD_TYPE = 'plugin:dsh-tui-rewrite/message';

/** Event types this plugin is allowed to mark `ignorable`. */
const OWN_TYPES = new Set([REWRITE_RECORD_TYPE, REWRITE_EVENT_TYPE]);

/**
 * The official writer, when the loaded dsh-session provides it.
 *
 * A namespace import (not a named one) is REQUIRED: on 0.2.0 the export does
 * not exist, and a named import would fail the whole module at link time.
 */
const officialAppend = typeof dshSession.appendPluginRecord === 'function'
  ? dshSession.appendPluginRecord
  : undefined;

/** Where the last write went, for diagnostics and tests. */
let status = Object.freeze({ mode: 'unavailable', reason: 'no rewrite has been appended yet' });

/** Read-only view of the last write path. */
export function rewriteWriteStatus() {
  return { ...status };
}

/** Test seam: forget the last write path. */
export function resetWriteStatus() {
  status = Object.freeze({ mode: 'unavailable', reason: 'no rewrite has been appended yet' });
}

function record(mode, reason) {
  status = Object.freeze(reason === undefined ? { mode } : { mode, reason });
}

/**
 * Whether a throw is the private-brand error of calling this module's
 * `appendPluginRecord` with a Session from a DIFFERENT installed copy of
 * dsh-session. That is not a data error and must fall back to the guard.
 *
 * @param {unknown} error
 */
function isForeignSessionError(error) {
  if (!(error instanceof TypeError)) return false;
  return /private (?:field|member|method)|#appendRecord|Cannot read private|Receiver must be an instance of class Session/u.test(error.message);
}

/** Marks a prototype this module already wrapped. */
const PATCH_MARK = Symbol.for('dsh-tui-rewrite.ignorable-write');
const patchedPrototypes = new Set();
const savedMethods = new WeakMap();

function withMarker(event) {
  if (event === null || typeof event !== 'object') return event;
  if (!OWN_TYPES.has(event.type) || event.ignorable !== undefined) return event;
  return { ...event, ignorable: true };
}

/**
 * Patch one handle prototype so this plugin's persisted events carry
 * `ignorable: true`. Idempotent; returns false when the backend does not have
 * both routing points.
 *
 * @param {unknown} proto
 */
function patchPrototype(proto) {
  if (proto === null || typeof proto !== 'object') return false;
  if (proto[PATCH_MARK] === true) return true;
  const append = proto.append;
  const enqueueLive = proto.enqueueLive;
  if (typeof append !== 'function' || typeof enqueueLive !== 'function') return false;

  const wrappedAppend = function (events, options) {
    const mapped = Array.isArray(events) ? events.map(withMarker) : events;
    return append.call(this, mapped, options);
  };
  const wrappedEnqueueLive = function (event, report) {
    return enqueueLive.call(this, withMarker(event), report);
  };
  savedMethods.set(proto, { append, enqueueLive, wrappedAppend, wrappedEnqueueLive });
  proto.append = wrappedAppend;
  proto.enqueueLive = wrappedEnqueueLive;
  try {
    Object.defineProperty(proto, PATCH_MARK, { value: true, configurable: true });
  } catch {
    proto[PATCH_MARK] = true;
  }
  patchedPrototypes.add(proto);
  return true;
}

/**
 * Install (or confirm) the write guard for one session.
 *
 * The writer handle is the same object the persistence backend routes live
 * `session/event` publications to; its prototype is shared by every handle of
 * that backend, so this also covers later sessions and fork prefixes.
 *
 * @param {unknown} persistence - `ctx.get('sessionPersistence', false)`.
 * @param {unknown} sessionId
 * @returns {boolean} whether persisted rewrites will carry `ignorable`.
 */
export function installIgnorableWriteGuard(persistence, sessionId) {
  if (persistence === null || typeof persistence !== 'object') return false;
  // The JSONL backend keeps the live writers on `tracker.writers`; a test (or a
  // future backend) may expose the same map directly. Try both shapes.
  const holders = [persistence];
  if (persistence.tracker !== null && typeof persistence.tracker === 'object') holders.push(persistence.tracker);
  for (const holder of holders) {
    const writers = holder.writers;
    if (writers === null || writers === undefined || typeof writers.get !== 'function') continue;
    const writer = writers.get(sessionId);
    if (writer === undefined || writer === null) continue;
    return patchPrototype(Object.getPrototypeOf(writer));
  }
  return false;
}

/**
 * Undo every prototype patch this module installed. Called from the plugin's
 * effect so an unloaded plugin stops rewriting other owners' persistence code.
 */
export function restoreIgnorableWriteGuard() {
  for (const proto of [...patchedPrototypes]) {
    const saved = savedMethods.get(proto);
    if (saved === undefined) continue;
    if (proto.append === saved.wrappedAppend) proto.append = saved.append;
    if (proto.enqueueLive === saved.wrappedEnqueueLive) proto.enqueueLive = saved.enqueueLive;
    try {
      delete proto[PATCH_MARK];
    } catch { /* a non-configurable marker only affects this process */ }
    patchedPrototypes.delete(proto);
  }
}

/** The persistence service, when the composition has one. */
function persistenceOf(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('sessionPersistence', false) : undefined;
  } catch {
    return undefined;
  }
}

/** The event for a committed seq, when the session can read it back. */
function eventAt(session, seq) {
  try {
    const event = session.eventAt(seq);
    if (event !== undefined) return event;
  } catch { /* fall through */ }
  return { seq };
}

/**
 * Append one rewrite.
 *
 * Uses the official plugin-record API when this runtime has it and the Session
 * belongs to that same module instance. Otherwise installs the guarded write
 * path and appends the same event type through `Session.append`.
 *
 * @param {import('@deepseek-ai/cordis').Context | undefined} ctx - plugin context (guard lookup).
 * @param {import('@deepseek-ai/dsh-session').Session} session - the live session.
 * @param {{targetSeq: number, content: string}} data
 * @returns {import('@deepseek-ai/dsh-session').SessionEvent | {seq: number}}
 * @throws when neither write path can guarantee `ignorable` on the persisted event.
 */
export function appendRewrite(ctx, session, data) {
  if (session === undefined || session === null) throw new Error('dsh-tui-rewrite: no live session to rewrite');

  if (officialAppend !== undefined) {
    try {
      const seq = officialAppend(session, REWRITE_RECORD_TYPE, data);
      record('official', undefined);
      return eventAt(session, seq);
    } catch (error) {
      if (!isForeignSessionError(error)) throw error;
      // The imported helper belongs to another module copy than the Session
      // (published installs can resolve a separate dsh-session). Fall back.
    }
  }

  const persistence = persistenceOf(ctx);
  if (!installIgnorableWriteGuard(persistence, session.id)) {
    record('unavailable', 'the persistence backend does not expose the live write handle');
    throw new Error(
      'dsh-tui-rewrite: cannot mark the rewrite "ignorable" on this runtime, so the session would become '
        + 'unresumable (R-019); refusing to append. Upgrade dsh-session to >= 0.2.1-rc.2 or use the JSONL backend.',
    );
  }

  const event = session.append(REWRITE_RECORD_TYPE, data);
  record('guard', undefined);
  return event;
}
