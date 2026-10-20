/**
 * dsh-tui-rewrite — user-driven rewriting of assistant replies on the
 * model-visible session surface. The append-only log keeps the original text.
 *
 * Three registrations, each optional and independently guarded:
 *
 * 1. `ctx.sessions.registerMessageProjection` — the core seam; without it the
 *    rewrite events do nothing (this is the load-bearing one).
 * 2. `ctx.tuiScenes` + a command + a shortcut — the phase 1a entry points; a
 *    composition without the TUI seam still gets the projection and simply has
 *    no UI (the Claude / Codex kernels keep the plugin pending on `sessions`).
 * 3. `setSessionResolver` — the host gives a scene React, ui, channel and close
 *    and NOTHING else, so the scene resolves `channel.sessionId` through this
 *    closure to reach the live Session. Without it the scene can render but has
 *    no data.
 *
 * The TUI seams are reached through src/seam.js: a row can activate before its
 * runtime service exists, and a bare soft-probe would then leave `/rewrite`
 * permanently unopenable while the boot looks healthy. See that module.
 *
 * BOOT-SAFETY CONTRACT (learned the hard way — see docs/explore/phase0-results.md):
 * cordis ABORTS the rest of `apply` when an effect body throws, and a plugin
 * that throws during composition can take a whole boot down. Every step here is
 * individually guarded, so this module is incapable of breaking a boot whatever
 * the host composition looks like. Failures degrade to a logged, self-reported
 * "loaded but inert" state instead.
 *
 * @module dsh-tui-rewrite
 */
import { REWRITE_EVENT_TYPE, rewriteProjection, setProjectionDiagnostics, rewriteSkips } from './projection.js';
import { REWRITE_RECORD_TYPE, appendRewrite, restoreIgnorableWriteGuard, rewriteWriteStatus } from './persist.js';
import { SCENE_ID, RewriteScene, setSessionResolver, setRewriteSubmitter } from './scene.js';
import { registerSeamWithRetry, whenSeamMounted } from './seam.js';
import { debugLog, debugEnabled } from './debug.js';

/** Cordis plugin name (also the injection/debug label). */
export const name = 'dsh-tui-rewrite';

/**
 * Required services. `sessions` is the DSH core service the projection hangs
 * off, so on a lightweight kernel (Claude / Codex) the plugin stays pending
 * instead of applying into a half-working state.
 */
export const inject = ['sessions'];

/** Slash-command name, without the leading slash. */
export const COMMAND_NAME = 'rewrite';
/** Contribution id used on the host-mediated command path. */
export const COMMAND_CONTRIBUTION_ID = 'dsh-tui-rewrite.rewrite';
/** Default entry chord for the scene. */
export const SHORTCUT_COMBO = 'alt+r';

export { REWRITE_EVENT_TYPE, REWRITE_RECORD_TYPE, rewriteProjection, SCENE_ID };
export { whenSeamMounted, registerSeamWithRetry, SEAM_BUDGET_MS } from './seam.js';

/**
 * Live state, so observability code can tell "never applied" from "inert".
 *
 * ONE PER PLUGIN INSTANCE, not one per module: a process can hold several
 * cordis contexts (a test suite, two mounts in one host, a reload), and shared
 * module state would let any of them reset or overwrite another's status - the
 * diagnostic reading would then describe whichever instance applied last.
 *
 * @returns {{ok: boolean, reason: string | undefined, applied: boolean, scene: boolean, command: boolean, shortcut: boolean}}
 */
function makeState() {
  return { ok: false, reason: undefined, applied: false, scene: false, command: false, shortcut: false };
}

/**
 * The most recently created instance, so the no-argument `projectionStatus()`
 * keeps working for a caller that has no handle (and for the single-instance
 * production case, where they are the same thing).
 */
let latest;

/** Read-only probe for tests and diagnostics. */
export function projectionStatus(plugin) {
  const state = plugin?.state ?? latest?.state;
  if (state === undefined) return { registered: false, reason: 'no plugin instance created yet', applied: false, scene: false, command: false, shortcut: false };
  return { registered: state.ok, reason: state.reason, applied: state.applied, scene: state.scene, command: state.command, shortcut: state.shortcut };
}

/** Never let a logger that throws break the boot or a session. */
function logSafely(ctx, level, message) {
  try {
    ctx.logger[level](message);
  } catch { /* observability must never be load-bearing */ }
}

/**
 * Register the projection inside the plugin fiber.
 *
 * The effect body must NOT throw: cordis aborts the remainder of `apply` when
 * it does, which would silently take the command, the shortcut and the watcher
 * down with it — exactly the silent-degradation mode this plugin exists to make
 * visible. A refusal is caught, recorded, and reported per session.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function registerProjection(ctx, state) {
  // A skipped rewrite is invisible to the user (the original text just stays),
  // so the projection reports it through here. Installed even when registration
  // is refused: the two failures are independent.
  setProjectionDiagnostics(message => {
    logSafely(ctx, 'warn', name + ': ' + message);
    debugLog('rewrite skipped', { reason: message });
  });
  // Two event types, one body: the official `plugin:` record type for new
  // writes, and the legacy type so sessions written before R-019 was fixed
  // still get their rewrite. The record registration is the load-bearing one;
  // a refused legacy registration only turns off reading old logs here.
  for (const definition of [
    { type: REWRITE_RECORD_TYPE, primary: true },
    { type: REWRITE_EVENT_TYPE, primary: false },
  ]) {
    ctx.effect(() => {
      let dispose;
      try {
        dispose = ctx.sessions.registerMessageProjection({
          type: definition.type,
          project: rewriteProjection.project,
        });
        if (definition.primary) {
          state.ok = true;
          state.reason = undefined;
        }
        logSafely(ctx, 'info', name + ': projection "' + definition.type + '" registered');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (definition.primary) {
          state.ok = false;
          state.reason = detail;
        }
        logSafely(ctx, 'warn',
          name + ': projection "' + definition.type + '" was REFUSED (' + detail + ')'
            + (definition.primary ? '; every rewrite is inert until that is resolved' : '; legacy rewrite logs will not apply'));
        return () => { if (definition.primary) state.ok = false; };
      }
      return async () => {
        // Clear first: sessions may still be derived while the fiber unwinds.
        if (definition.primary) state.ok = false;
        try {
          await dispose();
        } catch { /* teardown is best-effort by contract */ }
      };
    });
  }
}

/**
 * Register the full-screen scene. The host renders it in place of the chat tree.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function registerScene(ctx, config, state) {
  // Published even without a scenes seam: the resolver is scene plumbing, and a
  // composition that gains the seam later must not need a second apply.
  setSessionResolver(id => ctx.sessions.get(id));
  whenSeamMounted(ctx, 'tuiScenes', () => ctx.get('tuiScenes', false), scenes => {
    const descriptor = { id: SCENE_ID, title: 'rewrite', component: RewriteScene };
    try {
      const dispose = scenes.register(descriptor, ctx);
      ctx.effect(() => dispose);
      state.scene = true;
      debugLog('scene registered', { scene: SCENE_ID });
    } catch (error) {
      // The host's liveness gate can refuse a registration made during the
      // cold-boot window; a throw here would fail the whole activation, so
      // retry on a timer instead (see src/seam.js).
      registerSeamWithRetry(ctx, 'scene', () => scenes.register(descriptor, ctx), dispose => ctx.effect(() => dispose), error, config);
    }
  }, config);
}

/** Open the scene, or report why it cannot open. */
function openScene(ctx) {
  const scenes = ctx.get('tuiScenes', false);
  if (scenes === undefined) return { kind: 'error', text: name + ': the TUI scenes seam is unavailable' };
  const opened = scenes.open(SCENE_ID);
  // A mistyped or unregistered id would otherwise fail invisibly in the UI.
  if (!opened) return { kind: 'error', text: name + ': scene "' + SCENE_ID + '" is not registered' };
  debugLog('scene opened', { scene: SCENE_ID });
  return { kind: 'success' };
}

/**
 * Register the `/rewrite` command on both host paths.
 *
 * The host-mediated registration is preferred (it stamps a verified component
 * identity for per-owner authorization) but currently refuses every community
 * plugin with COMPONENT_NOT_ADMITTED, so the documented direct registration is
 * the normal path, not an error path. Same shape as the reference plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function registerCommand(ctx, state) {
  const definition = {
    name: COMMAND_NAME,
    description: 'Rewrite the text of an assistant reply on the model-visible surface',
    input: { hint: '[no arguments — the scene picks the reply]' },
    // Opening a scene is UI state, not conversation content.
    recordInput: false,
    handler: () => openScene(ctx),
  };
  const host = ctx.get('tuiPluginHost', false);
  if (host !== undefined) {
    try {
      const dispose = host.registerCommand(ctx, COMMAND_CONTRIBUTION_ID, definition);
      ctx.effect(() => dispose);
      state.command = true;
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logSafely(ctx, 'info', name + ': mediated command registration unavailable (' + detail + '); using direct registration');
      debugLog('mediated command registration refused', { error: detail });
    }
  }
  const commands = ctx.get('commands', false);
  if (commands === undefined) {
    logSafely(ctx, 'warn', name + ': no commands service; /' + COMMAND_NAME + ' is unavailable');
    return;
  }
  try {
    const dispose = commands.register(definition);
    ctx.effect(() => dispose);
    state.command = true;
    debugLog('command registered', { command: COMMAND_NAME });
  } catch (error) {
    logSafely(ctx, 'warn', name + ': /' + COMMAND_NAME + ' registration failed (' + (error instanceof Error ? error.message : String(error)) + ')');
  }
}

/**
 * Bind the global entry chord.
 *
 * Shortcuts match in the plain chat state only — an open overlay owns the
 * keyboard — so this is an entry point, never an in-scene control.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function registerShortcut(ctx, config, state) {
  const bind = shortcuts => {
    try {
      const dispose = shortcuts.register(SHORTCUT_COMBO, {
        description: 'Rewrite an assistant reply',
        handler: () => { openScene(ctx); },
      }, ctx);
      ctx.effect(() => dispose);
      state.shortcut = true;
      debugLog('shortcut bound', { combo: SHORTCUT_COMBO });
    } catch (error) {
      // Reserved / modifier-less / duplicate combos are refused with a warning
      // by the registry itself; a bad binding must not fail the plugin's boot,
      // and retrying a refused combo is pointless - it is refused by policy.
      logSafely(ctx, 'warn', name + ': shortcut ' + SHORTCUT_COMBO + ' not bound (' + (error instanceof Error ? error.message : String(error)) + ')');
    }
  };
  whenSeamMounted(ctx, 'tuiShortcuts', () => ctx.get('tuiShortcuts', false), bind, config);
}

/**
 * Record the VERIFIED post-late-mount state.
 *
 * The `applied` line is written during apply, when a seam that mounts 400 ms
 * later still reads as absent (observed on a real boot: `scene:false` at apply,
 * `scene registered` 439 ms afterwards). This line is therefore the one that
 * answers "did all three entry points actually land", and it exists because the
 * on-device log is the only evidence channel a full-screen TUI leaves.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function reportLateMountState(ctx, state) {
  const seen = { scene: false, command: false, shortcut: false };
  let timer;
  let giveUp;

  const stop = () => {
    clearInterval(timer);
    clearTimeout(giveUp);
    timer = undefined;
    giveUp = undefined;
  };

  const start = () => {
    timer = setInterval(() => {
      if (state.scene) seen.scene = true;
      if (state.command) seen.command = true;
      if (state.shortcut) seen.shortcut = true;
      if (seen.scene && seen.command && seen.shortcut) {
        stop();
        debugLog('entry points verified', { ...seen, rewritesSkipped: rewriteSkips(), write: rewriteWriteStatus() });
      }
    }, 250);
    // Bounded: an entry point that never lands is a real failure and must not
    // keep probing (or keep a process alive) forever.
    giveUp = setTimeout(() => {
      stop();
      debugLog('entry points incomplete', { ...seen, ...state });
      logSafely(ctx, 'warn', name + ': entry points incomplete after 60 s ('
        + JSON.stringify({ ...seen, ...state }) + ')');
    }, 60_000);
    if (typeof timer.unref === 'function') timer.unref();
    if (typeof giveUp.unref === 'function') giveUp.unref();
  };

  // Owned by the activation: a self-check that keeps writing after its plugin
  // is gone is a side effect with no owner, which is what the rest of this
  // plugin refuses to be. Same posture as the seam polls (see src/seam.js).
  try {
    ctx.effect(() => stop);
    start();
  } catch (error) {
    logSafely(ctx, 'warn', name + ': could not scope the late-mount self-check ('
      + (error instanceof Error ? error.message : String(error)) + '); it will not run');
  }
}

/**
 * Report per session when this plugin is loaded but inert.
 *
 * The framework's own refusal is a logger error at mount time, which a
 * full-screen TUI never shows. This is the cheap signal that reaches the user.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function watchForInertSessions(ctx, state) {
  ctx.on('session/created', (session) => {
    if (state.ok) return;
    logSafely(ctx, 'warn',
      name + ': session "' + String(session?.id) + '" was created while the rewrite projection is '
        + (state.reason === undefined ? 'not registered' : 'refused: ' + state.reason)
        + ' — rewrites in this session do nothing.');
  });
}

/**
 * Build the activation.
 *
 * `config.timers` is a TEST SEAM: it injects the timer functions the late-mount
 * polls use, so a suite can drive the retry budgets deterministically instead of
 * sleeping through them. Production never passes it.
 *
 * The returned `apply` MUST stay synchronous: a row activated after the first
 * TUI frame cannot await anything in `apply` without stalling the composition,
 * and the projection has to exist before the first session is derived. Timers
 * and retries are therefore scheduled, never awaited.
 *
 * @param {{timers?: {schedule?: Function, cancel?: Function}}} [config]
 */
export function createPlugin(config = {}) {
  // One state object per instance: two rows in one process must not be able to
  // reset or overwrite each other's status (see makeState).
  const state = makeState();
  const plugin = { name, inject, state, apply: undefined };
  // Newest instance wins the no-argument projectionStatus() reading, which is
  // exactly the single-instance production case.
  latest = plugin;
  const apply = ctx => {
    try {
      registerProjection(ctx, state);
    } catch (error) {
      state.ok = false;
      state.reason = 'registerProjection: ' + (error instanceof Error ? error.message : String(error));
    }
    try {
      // The scene owns no cordis context; hand it the write path that can put
      // `ignorable` on the persisted event (official record API, or the guard).
      setRewriteSubmitter((session, data) => appendRewrite(ctx, session, data));
    } catch (error) {
      logSafely(ctx, 'warn', name + ': rewrite writer unavailable (' + (error instanceof Error ? error.message : String(error)) + ')');
    }
    try {
      // The guard is installed lazily on the first write; this is its owner.
      ctx.effect(() => restoreIgnorableWriteGuard);
    } catch (error) {
      logSafely(ctx, 'warn', name + ': could not scope the persistence guard (' + (error instanceof Error ? error.message : String(error)) + ')');
    }
    try {
      registerScene(ctx, config, state);
    } catch (error) {
      logSafely(ctx, 'warn', name + ': scene registration failed (' + (error instanceof Error ? error.message : String(error)) + ')');
    }
    try {
      registerCommand(ctx, state);
    } catch (error) {
      logSafely(ctx, 'warn', name + ': command registration failed (' + (error instanceof Error ? error.message : String(error)) + ')');
    }
    try {
      registerShortcut(ctx, config, state);
    } catch (error) {
      logSafely(ctx, 'warn', name + ': shortcut registration failed (' + (error instanceof Error ? error.message : String(error)) + ')');
    }
    try {
      if (debugEnabled) reportLateMountState(ctx, state);
    } catch (error) {
      logSafely(ctx, 'warn', name + ': late-mount self-check failed (' + (error instanceof Error ? error.message : String(error)) + ')');
    }
    try {
      watchForInertSessions(ctx, state);
    } catch (error) {
      state.reason = state.reason ?? ('watchForInertSessions: ' + (error instanceof Error ? error.message : String(error)));
    }
    state.applied = true;
    if (debugEnabled) logSafely(ctx, 'info', name + ': debug log enabled');
    // Deliberately WITHOUT the scene/command/shortcut booleans: a seam that
    // mounts a few hundred ms later still reads as absent here, so those values
    // would be a trap. The authoritative lines are the per-entry-point ones
    // ('scene registered', 'command registered', 'shortcut bound') and the
    // 'entry points verified' summary they end in.
    debugLog('applied', { registered: state.ok });
  };
  plugin.apply = apply;
  return plugin;
}

/** The row a profile mounts. Built last, so it is the default `latest`. */
const defaultPlugin = createPlugin();

export default defaultPlugin;
