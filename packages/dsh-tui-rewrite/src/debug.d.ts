/**
 * Types for the opt-in JSONL diagnostics.
 *
 * @module dsh-tui-rewrite/debug
 */
/** Whether the debug log is on (also mirrored into every log line). */
export declare const debugEnabled: boolean;

/** Append one JSONL record. No-ops unless the env switch is set. */
export declare function debugLog(message: string, fields?: Record<string, unknown>): void;

/** The active log path, for diagnostics output. */
export declare function debugPath(): string | undefined;
