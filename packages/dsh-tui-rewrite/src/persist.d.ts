/**
 * Types for the durable write path (R-019).
 *
 * The `declare module` block is the official plugin-record catalog entry: the
 * event type lives outside `SessionEventMap` on purpose, so it is declared in
 * `PluginRecordMap` and read back with `pluginRecordOf`.
 *
 * @module dsh-tui-rewrite/persist
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { RewriteEventData } from './projection.js';

/** Event type for new rewrites: the official `plugin:` record namespace. */
export declare const REWRITE_RECORD_TYPE: 'plugin:dsh-tui-rewrite/message';

/** Which write path the last append used. */
export declare type RewriteWriteMode = 'official' | 'guard' | 'unavailable';

/** Diagnostics for the last rewrite write. */
export declare interface RewriteWriteStatus {
  /** `official` = appendPluginRecord; `guard` = patched JSONL handle; else unavailable. */
  mode: RewriteWriteMode;
  /** Why the write was refused or fell back, when there is a reason. */
  reason: string | undefined;
}

/** The appended event, or at least its sequence number. */
export declare type RewriteWriteResult = SessionEvent | { seq: number };

/**
 * Append one rewrite through the best available path.
 *
 * @throws when neither path can guarantee `ignorable` on the persisted event.
 */
export declare function appendRewrite(
  ctx: Context | undefined,
  session: Session,
  data: RewriteEventData,
): RewriteWriteResult;

/**
 * Install (or confirm) the persistence write guard for one live session.
 * Returns whether persisted rewrites will carry `ignorable`.
 */
export declare function installIgnorableWriteGuard(persistence: unknown, sessionId: unknown): boolean;

/** Undo every prototype patch this module installed. */
export declare function restoreIgnorableWriteGuard(): void;

/** Which path the last append used, and why. */
export declare function rewriteWriteStatus(): RewriteWriteStatus;

/** Test seam: forget the last write path. */
export declare function resetWriteStatus(): void;

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** Rewrites the text the MODEL sees for one assistant message. */
    'plugin:dsh-tui-rewrite/message': RewriteEventData;
  }
}
