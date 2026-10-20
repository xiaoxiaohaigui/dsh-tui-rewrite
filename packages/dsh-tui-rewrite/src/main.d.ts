/**
 * Types for the plugin entry point.
 *
 * @module dsh-tui-rewrite
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface';

/** Cordis plugin name (also the injection/debug label). */
export declare const name: 'dsh-tui-rewrite';

/** Required services; the plugin stays pending without `sessions`. */
export declare const inject: readonly ['sessions'];

/** Slash-command name, without the leading slash. */
export declare const COMMAND_NAME: 'rewrite';

/** Contribution id used on the host-mediated command path. */
export declare const COMMAND_CONTRIBUTION_ID: string;

/** Default entry chord for the scene. */
export declare const SHORTCUT_COMBO: string;

/** Scene id (kebab-case, per the tuiScenes grammar). */
export declare const SCENE_ID: 'dsh-tui-rewrite-scene';

/** Total late-mount budget, in milliseconds. */
export declare const SEAM_BUDGET_MS: number;

/**
 * What the last apply managed to land.
 *
 * `registered` is the projection (the load-bearing part). `applied` says an
 * apply ran at all. The three entry-point booleans are only meaningful at
 * apply time: a seam that mounts a few hundred milliseconds later still reads
 * as absent here, and the plugin reports those by its own log lines instead.
 */
export interface ProjectionStatus {
  registered: boolean;
  reason: string | undefined;
  applied: boolean;
  scene: boolean;
  command: boolean;
  shortcut: boolean;
}

/** Test seam: injectable timer functions for the late-mount polls. */
export interface PluginConfig {
  timers?: {
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
    /** Test seam: the production budget is ~10 minutes. */
    budgetMs?: number;
  };
}

/** The cordis row this package exports by default. */
export interface PluginRow {
  name: typeof name;
  inject: typeof inject;
  apply: (ctx: Context) => void;
  /**
   * This instance's own live state. Present so a caller that holds a row can
   * ask about THAT row: a process can hold several contexts, and the
   * no-argument `projectionStatus()` can only describe the newest (R-008).
   */
  state: ProjectionStatus;
}

/** Build the activation. Production uses the default export. */
export declare function createPlugin(config?: PluginConfig): PluginRow;

/**
 * Read-only probe for tests and diagnostics.
 *
 * @param plugin - the row to describe. Omit to describe the newest instance,
 * which is the single-instance production case.
 */
export declare function projectionStatus(plugin?: PluginRow): ProjectionStatus;

export { REWRITE_EVENT_TYPE, rewriteProjection } from './projection.js';
export { REWRITE_RECORD_TYPE } from './persist.js';
export { registerSeamWithRetry, whenSeamMounted } from './seam.js';
export type { RewriteEventData, RewriteSkip, RewriteSkipReason } from './projection.js';
export type { SeamContext, SeamTimers } from './seam.js';

declare const plugin: PluginRow;
export default plugin;
