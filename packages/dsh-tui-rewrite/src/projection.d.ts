/**
 * Types for the rewrite projection.
 *
 * The `declare module` block below is not documentation: it is the binding
 * contract the event-type ADR asks for.
 *
 * @module dsh-tui-rewrite/projection
 */
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface';
import type { Message } from '@deepseek-ai/dsh-session';

/** Event type owned by this plugin. */
export declare const REWRITE_EVENT_TYPE: 'dsh-tui-rewrite/message';

/**
 * Payload of a rewrite event.
 *
 * `targetSeq` names the event whose message is replaced; `content` is the text
 * the model must see instead. The log entry for `targetSeq` is never touched.
 */
export interface RewriteEventData {
  /** Seq of the event whose model-visible message this rewrite replaces. */
  targetSeq: number;
  /** Replacement text for the first `text` part of that message. */
  content: string;
}

/** Why a rewrite event was left alone. */
export type RewriteSkipReason =
  | 'bad-target'
  | 'no-target-event'
  | 'not-derivable'
  | 'bad-content';

/** One skip reason and how many times it has been seen. */
export interface RewriteSkip {
  reason: RewriteSkipReason;
  count: number;
}

/**
 * Replace the text parts of a message, leaving every non-text part by identity.
 *
 * The first `text` part receives `content`; later `text` parts of the same
 * message are dropped, because stale text next to the rewritten text is how a
 * partial rewrite leaks the original to the model.
 *
 * @param previous - the message currently on the surface.
 * @param content - the replacement text.
 * @returns an immutable copy; `previous` is not mutated.
 */
export declare function applyRewrite(previous: Message, content: string): Message;

/**
 * The projection registered with `ctx.sessions`.
 *
 * `project` never throws. Every rejectable input returns an empty Map, which is
 * the projection contract's way of saying "this event changes nothing": a throw
 * inside the surface fold would make the whole session impossible to open, and
 * dsh-session's repair channel does not cover projection events.
 */
export declare const rewriteProjection: SessionMessageProjection;

/**
 * Install where a skipped rewrite is reported. main.js points this at the
 * plugin's logger; the projection itself has no cordis context.
 *
 * @param warn - receives one already-formatted line, or `undefined` to detach.
 */
export declare function setProjectionDiagnostics(warn: ((message: string) => void) | undefined): void;

/** How many rewrite events were left alone, and why. */
export declare function rewriteSkips(): RewriteSkip[];

/** Test seam: forget the accumulated skips. */
export declare function resetRewriteSkips(): void;

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Rewrites the text the MODEL sees for one assistant message.
     *
     * @messageProjection - this event is inert without the projection this
     * package registers; a reader that does not know the type must ignore it
     * rather than fail. It is NOT surface-eligible and must never carry
     * `surfaceOp` or `sourceEventSeqs`.
     */
    'dsh-tui-rewrite/message': RewriteEventData;
  }
}
