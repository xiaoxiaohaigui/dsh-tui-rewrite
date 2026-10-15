/**
 * Types for the late-mounting seam services.
 *
 * @module dsh-tui-rewrite/seam
 */
/** Fast-phase attempts: 200 x 25 ms = 5 s. */
export declare const SEAM_FAST_ATTEMPTS: number;
/** Fast-phase cadence. */
export declare const SEAM_FAST_DELAY_MS: number;
/** Slow-phase cadence. */
export declare const SEAM_SLOW_DELAY_MS: number;
/** Total budget: ~10 minutes, then the seam is treated as absent. */
export declare const SEAM_BUDGET_MS: number;

/** Injectable timer functions; `budgetMs` is a test seam. */
export interface SeamTimers {
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  budgetMs?: number;
}

/** The slice of a cordis context the seam helpers use. */
export interface SeamContext {
  logger: Record<'info' | 'warn' | 'debug', (message: string) => void>;
  effect?: (fn: () => (() => void) | void) => void;
}

/**
 * Poll `tick` on the two-phase budget and run `onGiveUp` once at the deadline.
 * `tick` runs first at every step, including the giving-up one.
 *
 * @returns disposer; the activation's unload must not leave a tick.
 */
export declare function pollOnBudget(
  ctx: SeamContext,
  label: string,
  tick: (attempt: number) => boolean,
  giveUpMessage: string,
  timers?: SeamTimers,
): () => void;

/**
 * Run `use` on a seam service as soon as it exists.
 *
 * @returns whether `use` ran synchronously.
 */
export declare function whenSeamMounted(
  ctx: SeamContext,
  label: string,
  probe: () => unknown,
  use: (seam: unknown) => void,
  options?: { timers?: SeamTimers },
): boolean;

/**
 * Retry a seam registration that just failed, tolerating the boot liveness
 * window. Never rethrows: a throw during `apply` fails the activation.
 */
export declare function registerSeamWithRetry(
  ctx: SeamContext,
  label: string,
  register: () => () => void,
  attach: (dispose: () => void) => void,
  firstError: unknown,
  options?: { timers?: SeamTimers },
): void;
