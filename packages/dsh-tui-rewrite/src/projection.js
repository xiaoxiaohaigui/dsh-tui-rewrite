/**
 * The rewrite projection: one log-only event rewrites the text the MODEL sees
 * for one assistant message, while the append-only log keeps the original.
 *
 * Contract notes (verified against dsh 0.2.0-rc.2, see docs/tasks runtime notes):
 *
 * - The event type is NOT surface-eligible, so it must never carry `surfaceOp`.
 * - `ctx.messages` holds only messages ALREADY changed by projections, so it is
 *   empty on the first projection. Rebuild the previous value from `ctx.events`
 *   through `deriveEventMessage`, exactly as the framework documents.
 * - Projections compose: the orchestrator hands the accumulated projected map to
 *   every later projection, so a second rewrite of the same seq sees the first
 *   one's result and wins. Undo is therefore "append another rewrite".
 * - Return an immutable copy. The input message may be a frozen shared value.
 *
 * - A projection MUST NOT throw: it runs inside the surface fold, which a session
 *   also runs while validating its seed. An exception there is not a degraded
 *   rewrite, it is a session that cannot be opened at all - and dsh-session's
 *   repair channel covers tool results and open turns, NOT projection events, so
 *   one bad event would strand that session permanently. Every rejectable input
 *   therefore degrades to "leave this event alone": the original text survives.
 *
 * @module dsh-tui-rewrite/projection
 */
import { deriveEventMessage } from '@deepseek-ai/dsh-session';

/** Event type owned by this plugin. */
export const REWRITE_EVENT_TYPE = 'dsh-tui-rewrite/message';

/**
 * Replace the text parts of the message produced by `targetSeq`.
 *
 * The first `text` part receives `content`; any further `text` parts of the same
 * message are dropped, because carrying stale text next to the rewritten text is
 * how a partial rewrite leaks the original to the model. Non-text parts (tool
 * calls, images, thinking) are preserved by identity.
 *
 * @param {import('@deepseek-ai/dsh-session').Message} previous - message currently on the surface.
 * @param {string} content - replacement text.
 * @returns {import('@deepseek-ai/dsh-session').Message} immutable copy.
 */
export function applyRewrite(previous, content) {
  const next = structuredClone(previous);
  const parts = Array.isArray(next.content) ? next.content : [];
  let placed = false;
  const rebuilt = [];
  for (const part of parts) {
    if (part !== null && typeof part === 'object' && part.type === 'text') {
      if (!placed) {
        rebuilt.push({ ...part, text: content });
        placed = true;
      }
      continue; // drop later text parts of the same message
    }
    rebuilt.push(part);
  }
  if (!placed) rebuilt.unshift({ type: 'text', text: content });
  next.content = rebuilt;
  return next;
}

/** Reasons a rewrite event is left alone, with the detail each one reports. */
const SKIP_REASONS = {
  'bad-target': detail => REWRITE_EVENT_TYPE + ': targetSeq must be a non-negative safe integer, got '
    + JSON.stringify(detail.target) + ' - event left alone',
  'no-target-event': detail => REWRITE_EVENT_TYPE + ': no event at seq ' + detail.target
    + ' (the fold starts at ' + detail.baseSeq + '), so the rewrite cannot resolve - event left alone',
  'not-derivable': detail => REWRITE_EVENT_TYPE + ': seq ' + detail.target
    + ' produces no model-visible message - event left alone',
  'bad-content': detail => REWRITE_EVENT_TYPE + ': content must be a string, got '
    + typeof detail.content + ' - event left alone',
};

/**
 * Skips seen so far, per reason. Skipping a rewrite is the ONE failure this
 * plugin can suffer without the user noticing - the original text simply stays
 * - so the count is kept for the diagnostics line rather than logged per fold
 * (a projection runs on every derivation, and a per-fold log would be a flood).
 *
 * @type {Map<string, number>}
 */
const skipped = new Map();

/** Diagnostics sink: `undefined` until main.js wires the plugin's logger. */
let diagnostics;

/**
 * Publish how a skipped rewrite should be reported. main.js installs the
 * plugin's logger; the projection itself has no cordis context to log through.
 *
 * @param {((message: string) => void) | undefined} warn
 */
export function setProjectionDiagnostics(warn) {
  diagnostics = warn;
}

/**
 * Report one skip: a counter and a FIRST-occurrence warning.
 *
 * Not once per call: a fold that hits a bad event hits it on every derivation.
 *
 * @param {keyof typeof SKIP_REASONS} reason
 * @param {Record<string, unknown>} detail
 */
function reportSkip(reason, detail) {
  const seen = (skipped.get(reason) ?? 0) + 1;
  skipped.set(reason, seen);
  if (seen !== 1) return;
  if (diagnostics === undefined) return;
  try {
    diagnostics(SKIP_REASONS[reason](detail));
  } catch { /* diagnostics must never be load-bearing */ }
}

/**
 * How many rewrite events were left alone, and why. Read by the plugin's
 * self-check line and available to tests.
 *
 * @returns {{reason: string, count: number}[]}
 */
export function rewriteSkips() {
  return [...skipped].map(([reason, count]) => ({ reason, count }));
}

/** Test seam: forget the accumulated skips. */
export function resetRewriteSkips() {
  skipped.clear();
}

/**
 * The pure projection definition registered with `ctx.sessions`.
 *
 * Every rejection returns an empty Map - the projection contract's way of
 * saying "this event changes nothing" - instead of throwing. See the module
 * header for why a throw here is a session-opening failure.
 *
 * @type {import('@deepseek-ai/dsh-session/surface').SessionMessageProjection}
 */
export const rewriteProjection = {
  type: REWRITE_EVENT_TYPE,
  project(event, ctx) {
    const target = event.data?.targetSeq;
    if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) {
      reportSkip('bad-target', { target });
      return new Map();
    }
    const targetEvent = ctx.events[target - ctx.baseSeq];
    if (targetEvent === undefined) {
      reportSkip('no-target-event', { target, baseSeq: ctx.baseSeq });
      return new Map();
    }
    const content = event.data.content;
    if (typeof content !== 'string') {
      reportSkip('bad-content', { content });
      return new Map();
    }
    const previous = deriveEventMessage(targetEvent, ctx.messages);
    if (previous === null || previous === undefined) {
      reportSkip('not-derivable', { target });
      return new Map();
    }
    return new Map([[target, applyRewrite(previous, content)]]);
  },
};
