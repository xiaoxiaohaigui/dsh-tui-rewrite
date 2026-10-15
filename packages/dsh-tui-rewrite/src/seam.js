/**
 * Late-mounting seam services.
 *
 * A plugin row can activate BEFORE a TUI runtime service exists, and the bare
 * soft-probe (`ctx.get('tuiScenes', false)`) then reports "absent" for the rest
 * of the session: the scene never registers and every `/rewrite` fails to open
 * while the boot itself looks healthy. The reference implementation hit exactly
 * this on a real boot and replaced the soft-probe with a bounded poll; this is
 * the same mechanism, scaled to this plugin.
 *
 * Two distinct failures are handled, because they need different postures:
 *
 * - the seam is not up yet -> poll until it appears (the composition is healthy,
 *   it is just early);
 * - the seam is up but REFUSES the registration (the host's liveness gate can
 *   reject listeners installed between this fiber's LOADING transition and its
 *   apply) -> retry the registration on a timer, because a throw during `apply`
 *   would fail the whole activation.
 *
 * Deliberately NOT `ctx.inject`: cordis binds a service proxy's caller to the
 * context `.get()` ran on, so a registration made inside an inject callback is
 * owned by a foreign activation and every later `open()` from this plugin would
 * be refused. A plain timer created during `apply` carries this activation's own
 * token instead.
 *
 * @module dsh-tui-rewrite/seam
 */

/** Fast-phase attempts: 200 x 25 ms = 5 s, ~100 ms is the observed real need. */
export const SEAM_FAST_ATTEMPTS = 200;
/** Fast-phase cadence. */
export const SEAM_FAST_DELAY_MS = 25;
/** Slow-phase cadence: a host that mounts its runtimes minutes late still wins. */
export const SEAM_SLOW_DELAY_MS = 5000;
/** Total budget: 5 s fast + 119 x 5 s slow ~ 10 minutes, then it is absent. */
export const SEAM_BUDGET_MS = 10 * 60 * 1000;

/**
 * Poll `tick` on the two-phase budget and run `onGiveUp` once at the deadline.
 * `tick` runs first at every step, including the giving-up one, so a seam that
 * arrives exactly on the last tick still lands. `tick` returns true when the
 * work is done and polling should stop.
 *
 * The timer functions are injectable so tests never wait in real time.
 *
 * @param {object} ctx - plugin context (`logger`, `effect`).
 * @param {string} label - seam label for the log lines.
 * @param {(attempt: number) => boolean} tick - one attempt; true = done.
 * @param {string} giveUpMessage - already formatted give-up line.
 * @param {{schedule?: (fn: () => void, ms: number) => unknown, cancel?: (handle: unknown) => void, budgetMs?: number}} [timers]
 *   `budgetMs` is a TEST SEAM: a test asserting the give-up path must not wait
 *   out the production budget.
 * @returns {() => void} disposer; the activation's unload must not leave a tick.
 */
export function pollOnBudget(ctx, label, tick, giveUpMessage, timers = {}) {
  const schedule = timers.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = timers.cancel ?? (handle => clearTimeout(handle));
  const budgetMs = timers.budgetMs ?? SEAM_BUDGET_MS;
  // The first tick is already scheduled below, so it counts as attempt 1.
  let elapsed = 0;
  let attempts = 1;
  let handle;
  let stopped = false;

  const step = () => {
    handle = undefined;
    if (stopped) return;
    const delay = attempts < SEAM_FAST_ATTEMPTS ? SEAM_FAST_DELAY_MS : SEAM_SLOW_DELAY_MS;
    elapsed += delay;
    attempts += 1;
    let done = false;
    try {
      done = tick(attempts) === true;
    } catch (error) {
      // A throw from a timer callback would be an uncaughtException.
      log(ctx, 'warn', label + ': retry attempt threw (' + describe(error) + ')');
    }
    if (done) return;
    if (elapsed >= budgetMs) {
      log(ctx, 'warn', giveUpMessage);
      return;
    }
    handle = schedule(step, delay);
  };

  const stop = () => {
    stopped = true;
    if (handle !== undefined) cancel(handle);
    handle = undefined;
  };
  // Register the disposer BEFORE scheduling anything: cordis runs the effect
  // body immediately and keeps what it RETURNS, so a poll armed after its
  // activation is already gone would leave a timer nothing owns.
  try {
    ctx.effect(() => stop);
  } catch {
    // A context without an effect scope still gets a working poll.
  }
  if (stopped) return stop;
  handle = schedule(step, SEAM_FAST_DELAY_MS);
  return stop;
}

/**
 * Run `use` on a seam service as soon as it exists.
 *
 * The synchronous probe runs first, so a normally-ordered boot pays nothing. A
 * composition that genuinely lacks the seam (Claude / Codex kernels, headless
 * embedders) takes the designed no-op posture after the budget expires, with an
 * info line rather than a warning.
 *
 * @param {object} ctx - plugin context.
 * @param {string} label - seam label for the log lines.
 * @param {() => unknown} probe - resolves the seam through the plugin's own ctx.
 * @param {(seam: any) => void} use - the registration, guarded by the caller.
 * @param {{timers?: object}} [options]
 * @returns {boolean} whether `use` ran synchronously.
 */
export function whenSeamMounted(ctx, label, probe, use, options = {}) {
  /**
   * 'ready'  - the seam was there and `use` completed
   * 'retry'  - the seam was there but `use` threw; the CALLER owns the retry
   *            (registerSeamWithRetry), so polling here must stop or the same
   *            registration would be attempted from two loops at once
   * 'wait'   - the seam is not up yet
   */
  const attempt = () => {
    let seam;
    try {
      seam = probe();
    } catch (error) {
      log(ctx, 'warn', label + ': probing the seam threw (' + describe(error) + ')');
      return 'wait';
    }
    if (seam === undefined || seam === null) return 'wait';
    try {
      use(seam);
      return 'ready';
    } catch (error) {
      log(ctx, 'warn', label + ': setup failed (' + describe(error) + ')');
      return 'retry';
    }
  };
  const first = attempt();
  if (first !== 'wait') return true;
  pollOnBudget(
    ctx,
    label,
    () => attempt() !== 'wait',
    'dsh-tui-rewrite: ' + label + ' never mounted within the '
      + Math.round((options.timers?.budgetMs ?? SEAM_BUDGET_MS) / 1000) + ' s budget; the feature stays unavailable this session',
    options.timers,
  );
  return false;
}

/**
 * Retry a seam registration that just failed, tolerating the boot liveness
 * window. Used when the seam EXISTS but the host's gate rejects the call: the
 * caller must not rethrow, because a throw during `apply` fails the activation.
 *
 * @param {object} ctx - plugin context.
 * @param {string} label - seam label for the log lines.
 * @param {() => () => void} register - the registration to retry; returns a disposer.
 * @param {(dispose: () => void) => void} attach - scopes the disposer to the activation.
 * @param {unknown} firstError - what the caller's synchronous attempt threw.
 * @param {{timers?: object}} [options]
 * @returns {void}
 */
export function registerSeamWithRetry(ctx, label, register, attach, firstError, options = {}) {
  let lastMessage = describe(firstError);
  log(ctx, 'warn', label + ': registration was refused (' + lastMessage + '); retrying within the boot budget');
  pollOnBudget(
    ctx,
    label,
    attempt => {
      try {
        const dispose = register();
        try {
          attach(dispose);
        } catch (error) {
          log(ctx, 'warn', label + ': registered but could not be scoped to the activation (' + describe(error) + ')');
        }
        log(ctx, 'warn', label + ': registered on retry #' + attempt + ' (boot race: ' + lastMessage + ')');
        return true;
      } catch (error) {
        lastMessage = describe(error);
        return false;
      }
    },
    'dsh-tui-rewrite: ' + label + ' registration failed within the '
      + Math.round((options.timers?.budgetMs ?? SEAM_BUDGET_MS) / 1000) + ' s budget (' + lastMessage + '); the feature stays unavailable until the plugin reloads',
    options.timers,
  );
}

/** Never let a logger that throws break a poll. */
function log(ctx, level, message) {
  try {
    ctx.logger[level](message);
  } catch {
    // Observability is never load-bearing.
  }
}

/** Collapse an unknown thrown value into one readable line. */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
