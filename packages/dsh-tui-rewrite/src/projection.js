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

/**
 * The pure projection definition registered with `ctx.sessions`.
 * @type {import('@deepseek-ai/dsh-session/surface').SessionMessageProjection}
 */
export const rewriteProjection = {
  type: REWRITE_EVENT_TYPE,
  project(event, ctx) {
    const target = event.data.targetSeq;
    if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0) {
      throw new Error(REWRITE_EVENT_TYPE + ': targetSeq must be a non-negative safe integer');
    }
    const targetEvent = ctx.events[target - ctx.baseSeq];
    if (targetEvent === undefined) {
      throw new Error(REWRITE_EVENT_TYPE + ': no event at seq ' + target);
    }
    const previous = deriveEventMessage(targetEvent, ctx.messages);
    if (previous === null) {
      throw new Error(REWRITE_EVENT_TYPE + ': seq ' + target + ' produces no model-visible message');
    }
    return new Map([[target, applyRewrite(previous, event.data.content)]]);
  },
};
