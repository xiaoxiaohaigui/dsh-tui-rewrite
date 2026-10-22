/**
 * Integration suite: the plugin against the REAL cordis service graph.
 *
 * Mounts a real SessionStore, applies the plugin as a real row, loads a real
 * session artifact, and drives a real rewrite end to end. What this suite
 * covers that the unit tests cannot: service resolution, projection
 * registration and its refusal path, fiber teardown, and the append -> derive
 * round trip through dsh-session's own surface fold.
 *
 * NOT covered here (needs a terminal): the scene's rendering and input routing.
 * That is on-device verification by design - see docs/explore/phase0-results.md.
 *
 * cordis applies a mounted row on a LATER TICK, not a microtask: every settle
 * below crosses a macrotask boundary (an earlier version asserted too early and
 * reported a false failure).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import pluginDefault, { name as pluginName, inject as pluginInject, projectionStatus } from 'dsh-tui-rewrite';
import { REWRITE_EVENT_TYPE } from 'dsh-tui-rewrite/projection';
import { REWRITE_RECORD_TYPE } from 'dsh-tui-rewrite/persist';
import { loadSampleSession, openSession, textOf } from '../tools.mjs';
// eslint-disable-next-line no-duplicate-imports -- the row builder below needs it
import { createPlugin } from 'dsh-tui-rewrite';

const settle = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
// The default export IS the mounted plugin (name + inject + apply).
const row = pluginDefault;
/**
 * A row whose late-mount polls run on zero-delay fake timers.
 *
 * The real budget is ~10 minutes; a suite must not leave that running, and the
 * zero-delay timers also make the retry path observable instead of slow.
 */
async function budgetRow(timers = {}) {
  const { createPlugin } = await import('dsh-tui-rewrite');
  return createPlugin({ timers: { schedule: (fn, ms) => setTimeout(fn, ms), cancel: clearTimeout, ...timers } });
}

/**
 * A context with the store row mounted and the plugin applied.
 *
 * Every test mounts through here, so every late-mount poll in the suite runs on
 * a SHORT budget: the production budget is ~10 minutes and a still-pending poll
 * holds the process open. The poll itself is exercised properly in the
 * "WITHOUT the TUI seams" test; here the budget only has to outlive `settle`.
 */
async function boot() {
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const row = await budgetRow({ budgetMs: 300 });
  const host = root.plugin(row);
  await settle();
  // The ROW carries its own status (R-008): asserting through the bare
  // projectionStatus() would read whichever instance was built last, and this
  // suite runs its tests concurrently.
  return { root, host, row };
}

test('a malformed rewrite event degrades to a skip instead of stranding the session', async () => {
  // A projection that throws is not a degraded rewrite: it runs inside the
  // surface fold, which a session ALSO runs while validating its seed, and
  // dsh-session's repair channel does not cover projection events. One bad
  // event - from a fork, a windowed replay, an older build, another tool, or a
  // hand-edited log - would make that session impossible to open, forever.
  const { rewriteSkips, resetRewriteSkips } = await import('dsh-tui-rewrite/projection');
  const { session } = await openSession([
    {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: 0,
        step: 0,
        stream: [],
        message: {
          id: 'msg-0',
          role: 'assistant',
          source: { kind: 'model', provider: 'harness', model: 'harness' },
          content: [{ type: 'text', text: 'ORIGINAL' }],
        },
      },
    },
    // No event lives at seq 99, which is what a bad window offset looks like.
    { type: REWRITE_EVENT_TYPE, data: { targetSeq: 99, content: 'NEVER LANDS' } },
    { type: REWRITE_EVENT_TYPE, data: { targetSeq: 'nope', content: 'NEITHER' } },
    { type: REWRITE_EVENT_TYPE, data: { targetSeq: 0, content: 42 } },
  ], { plugin: true });

  // Opening the session at all is the assertion: before, create() threw
  // "invalid seed event at index 1: dsh-tui-rewrite/message: no event at seq 99".
  assert.equal(session.surface.nodes.length, 1);
  assert.equal(textOf(session.deriveMessages()[0]), 'ORIGINAL', 'a skipped rewrite leaves the original in place');

  // And the skips are reported rather than silently absorbed.
  resetRewriteSkips();
  session.append(REWRITE_EVENT_TYPE, { targetSeq: 99, content: 'LATER BAD EVENT' });
  assert.equal(textOf(session.deriveMessages()[0]), 'ORIGINAL');
  assert.deepEqual(rewriteSkips(), [{ reason: 'no-target-event', count: 1 }]);

  // A good event still lands, even after bad ones.
  session.append(REWRITE_EVENT_TYPE, { targetSeq: 0, content: 'GOOD' });
  assert.equal(textOf(session.deriveMessages()[0]), 'GOOD');
});

test('the rewrite event type is outside the core vocabulary', () => {
  // Third-party events are unknown to core on purpose; the persistence path
  // classifies them through the ignorable envelope marker (see the ADR on the
  // event envelope in docs/decisions).
  assert.equal(KNOWN_SESSION_EVENT_TYPES.has(REWRITE_EVENT_TYPE), false);
});

test('mounting the store row makes ctx.sessions resolvable', async () => {
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  assert.equal(typeof root.sessions, 'object');
});

test('the plugin registers its projection exactly once', async () => {
  const { root, row } = await boot();
  const legacy = root.sessions.messageProjections.filter(projection => projection.type === REWRITE_EVENT_TYPE);
  const records = root.sessions.messageProjections.filter(projection => projection.type === REWRITE_RECORD_TYPE);
  assert.equal(legacy.length, 1, 'the legacy type stays readable for pre-fix logs');
  assert.equal(records.length, 1, 'new writes have exactly one owner');
  assert.equal(projectionStatus(row).registered, true);
  assert.equal(projectionStatus(row).applied, true);
});

test('a second owner of the same event type is refused, not displaced', async () => {
  // A foreign projection already holding our type: registration must fail, and
  // the plugin must survive it (an unguarded effect body would have aborted the
  // rest of apply and taken the self-check down with it).
  const foreign = new Context();
  foreign.plugin(SessionStore);
  await settle();
  // Both types the plugin would register, so neither registration can land.
  foreign.sessions.registerMessageProjection({ type: REWRITE_EVENT_TYPE, project: () => new Map() });
  foreign.sessions.registerMessageProjection({ type: REWRITE_RECORD_TYPE, project: () => new Map() });
  const before = foreign.sessions.messageProjections.length;
  const refused = await budgetRow({ budgetMs: 300 });
  const host = foreign.plugin(refused);
  await settle();
  assert.equal(foreign.sessions.messageProjections.length, before);
  assert.equal(projectionStatus(refused).registered, false, 'the refused instance reports itself refused');
  assert.equal(typeof projectionStatus(refused).reason, 'string');
  await host.dispose();
});

test('the late-mount self-check is owned by the activation (R-011)', async () => {
  // The interval and the 60 s timeout were created bare, so an unloaded plugin
  // kept writing to the debug log until the deadline. Every timer this module
  // starts must now be registered with the activation, the same posture the
  // seam polls take. The debug log is enabled for this whole file, so the
  // self-check really does start here.
  const disposers = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    effect: fn => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return () => {};
    },
    on: () => {},
    get: () => undefined,
    sessions: { registerMessageProjection: () => async () => {}, get: () => undefined },
  };

  const row = createPlugin({ timers: { budgetMs: 200 } });
  assert.doesNotThrow(() => row.apply(ctx), 'apply must stay synchronous and must not throw');
  assert.equal(projectionStatus(row).registered, true);

  // One disposer for the projection, at least one for the self-check. Before
  // the fix the self-check registered NOTHING, so this count is the assertion.
  assert.ok(disposers.length >= 2, 'expected the self-check to register a disposer too (got ' + disposers.length + ')');
  for (const dispose of disposers) assert.doesNotThrow(dispose, 'every disposer must be callable');
});

test('two instances in one process keep separate status (R-008)', async () => {
  // The module used to hold ONE state object, so a second instance's apply -
  // and any instance's dispose - rewrote the first one's reading. A diagnostic
  // that describes whichever plugin applied last is worse than none.
  const good = await boot();
  assert.equal(projectionStatus(good.row).registered, true);

  const foreign = new Context();
  foreign.plugin(SessionStore);
  await settle();
  foreign.sessions.registerMessageProjection({ type: REWRITE_RECORD_TYPE, project: () => new Map() });
  const refused = await budgetRow({ budgetMs: 300 });
  const refusedHost = foreign.plugin(refused);
  await settle();

  assert.equal(projectionStatus(refused).registered, false);
  assert.equal(projectionStatus(good.row).registered, true, 'the other instance must be unaffected');

  // Disposing one must not clear the other either.
  await refusedHost.dispose();
  assert.equal(projectionStatus(good.row).registered, true);
  await good.host.dispose();
  assert.equal(projectionStatus(good.row).registered, false, 'its own dispose does clear it');
});

test('a session created BEFORE the projection still honours it', async () => {
  // The ordering race the handoff flagged: a session is built first and only
  // then is the projection registered. The projection is consulted per event
  // while folding, so the rewrite still lands.
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const { header, events } = loadSampleSession();
  const session = root.sessions.create('ordering-probe', { seed: events, meta: { cwd: header.cwd } });
  const before = session.deriveMessages();
  assert.ok(before.length > 0);

  const host = root.plugin(row);
  await settle();

  const targetSeq = events.find(event => event.type === 'assistant/message'
    && Array.isArray(event.data?.message?.content)
    && event.data.message.content.some(part => part.type === 'text')).seq;
  const index = session.surface.nodes.indexOf(targetSeq);
  session.append(REWRITE_EVENT_TYPE, { targetSeq, content: 'ORDERING-PROBE' });
  assert.equal(textOf(session.deriveMessages()[index]), 'ORDERING-PROBE');
  await host.dispose();
});

test('appending a rewrite changes what the model sees and spares everything else', async () => {
  const { root, host } = await boot();
  const { header, events } = loadSampleSession();
  const session = root.sessions.create('rewrite-probe', { seed: events, meta: { cwd: header.cwd } });

  const targetSeq = events.find(event => event.type === 'assistant/message'
    && Array.isArray(event.data?.message?.content)
    && event.data.message.content.some(part => part.type === 'text')).seq;
  const index = session.surface.nodes.indexOf(targetSeq);

  const before = session.deriveMessages();
  const event = session.append(REWRITE_EVENT_TYPE, { targetSeq, content: 'REWRITTEN' });
  const after = session.deriveMessages();

  assert.equal(textOf(after[index]), 'REWRITTEN');
  assert.equal(after.length, before.length, 'message count must not change');
  assert.equal(session.surface.nodes[index], targetSeq, 'the message keeps its seq');
  for (let i = 0; i < after.length; i += 1) {
    if (i === index) continue;
    assert.equal(JSON.stringify(after[i]), JSON.stringify(before[i]), 'neighbour ' + i + ' changed');
  }
  // the log keeps the original, and the rewrite event carries no surface marker
  assert.notEqual(textOf(session.eventAt(targetSeq).data.message), 'REWRITTEN');
  assert.equal(event.surfaceOp, undefined);
  assert.equal(event.sourceEventSeqs, undefined);
  await host.dispose();
});

test('a later rewrite of the same seq wins, so undo is just another append', async () => {
  const { root, host } = await boot();
  const { header, events } = loadSampleSession();
  const session = root.sessions.create('compose-probe', { seed: events, meta: { cwd: header.cwd } });
  const targetSeq = events.find(event => event.type === 'assistant/message'
    && event.data.message.content.some(part => part.type === 'text')).seq;
  const index = session.surface.nodes.indexOf(targetSeq);

  session.append(REWRITE_EVENT_TYPE, { targetSeq, content: 'V1' });
  assert.equal(textOf(session.deriveMessages()[index]), 'V1');
  session.append(REWRITE_EVENT_TYPE, { targetSeq, content: 'V2' });
  assert.equal(textOf(session.deriveMessages()[index]), 'V2');
  await host.dispose();
});

test('disposing the fiber unwinds the projection', async () => {
  const { root, host, row } = await boot();
  assert.equal(root.sessions.messageProjections.some(p => p.type === REWRITE_EVENT_TYPE), true);
  assert.equal(projectionStatus(row).registered, true);
  await host.dispose();
  await settle();
  assert.equal(root.sessions.messageProjections.some(p => p.type === REWRITE_EVENT_TYPE), false);
  assert.equal(projectionStatus(row).registered, false);
});
test('a composition WITHOUT the TUI seams still applies and reports itself inert for the UI parts', async () => {
  // The Claude / Codex kernels and any headless composition have no tuiScenes /
  // commands / tuiShortcuts. The projection must still register, and the missing
  // UI seams must be reported rather than thrown - a plugin that throws here
  // would abort the boot.
  //
  // This test also pins the late-mount posture: with no scenes seam the plugin
  // starts a bounded poll, and that poll must EXPIRE (an unref'd/forever timer
  // would both hold the process open and mean "still waiting" forever). The
  // budget is shortened so the expiry is observable instead of a 10-minute wait.
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const row = await budgetRow({ budgetMs: 400 });
  const host = root.plugin(row);
  await settle();
  const status = projectionStatus(row);
  assert.equal(status.registered, true);
  assert.equal(status.scene, false);
  assert.equal(status.command, false);
  assert.equal(status.shortcut, false);
  assert.equal(root.sessions.messageProjections.some(p => p.type === REWRITE_EVENT_TYPE), true);
  await host.dispose();
});

test('the entry points are advertised with stable names', async () => {
  const main = await import('dsh-tui-rewrite');
  assert.equal(main.COMMAND_NAME, 'rewrite');
  assert.equal(main.SHORTCUT_COMBO, 'alt+w');
  assert.equal(main.SCENE_ID, 'dsh-tui-rewrite-scene');
  assert.deepEqual(main.inject, ['sessions']);
  // kebab-case, one slash: the grammar the entry-renderer and scene registries accept
  assert.match(main.SCENE_ID, /^[a-z0-9]+(-[a-z0-9]+)*$/u);
  // modifier-carrying, as the shortcut registry requires (bare letters are typing)
  assert.match(main.SHORTCUT_COMBO, /^(ctrl|alt|meta)\+/u);
});
test('a host-reserved configured shortcut falls back to the default', async () => {
  // The registry returns a disposer even for a refused combo (alt+r is the
  // host's Continue action), so the plugin must verify acceptance via list()
  // and fall back instead of reporting "shortcut bound" for a dead binding.
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const registered = [];
  root.provide('tuiShortcuts', {
    register(combo) {
      registered.push(combo);
      return () => {};
    },
    list() {
      return registered.filter(combo => combo !== 'alt+r').map(combo => ({ combo }));
    },
  });
  const row = createPlugin({ shortcut: 'alt+r', timers: { schedule: (fn) => setTimeout(fn, 0), cancel: clearTimeout, budgetMs: 200 } });
  const host = root.plugin(row);
  await settle(60);
  assert.deepEqual(registered, ['alt+r', 'alt+w']);
  assert.equal(projectionStatus(row).shortcut, true, 'the fallback is the live binding');
  await host.dispose();
});

test('the scene resolver reaches the live session through the real store', async () => {
  // This is the seam the host does NOT hand over in TuiSceneProps: the scene
  // gets React/ui/channel/close, so the plugin must resolve channel.sessionId
  // itself. A broken resolver renders the scene with no data - the failure mode
  // this test exists to catch.
  const { root, host } = await boot();
  const { header, events } = loadSampleSession();
  const session = root.sessions.create('resolver-probe', { seed: events, meta: { cwd: header.cwd } });
  const { sessionFor, collectTargets } = await import('dsh-tui-rewrite/scene');

  assert.equal(sessionFor(session.id), session);
  assert.equal(sessionFor('no-such-session'), undefined);
  assert.equal(sessionFor(''), undefined);
  assert.deepEqual(collectTargets(sessionFor(session.id)).map(t => t.seq), collectTargets(session).map(t => t.seq));
  await host.dispose();
});

test('the scene registers with the host scene runtime under the advertised id', async () => {
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const sceneRuntime = { registered: [], opened: [], register(descriptor) { this.registered.push(descriptor); return () => {}; }, open(id) { this.opened.push(id); return id === 'dsh-tui-rewrite-scene'; } };
  root.provide('tuiScenes', sceneRuntime);
  // Its own instance: the module default row is shared with other tests.
  const own = await budgetRow({ budgetMs: 300 });
  const host = root.plugin(own);
  await settle();

  assert.equal(projectionStatus(own).scene, true);
  assert.equal(sceneRuntime.registered.length, 1);
  const descriptor = sceneRuntime.registered[0];
  assert.equal(descriptor.id, 'dsh-tui-rewrite-scene');
  assert.equal(typeof descriptor.component, 'function');
  assert.equal(descriptor.title, 'rewrite');
  await host.dispose();
});

test('a command lands on the direct registry when the mediated host refuses', async () => {
  // The mediated path needs a verified admission identity the host does not
  // issue today, so the fallback IS the normal path - see
  // docs/decisions/2026-10-15-defer-command-mediated-registration.md.
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const attempts = [];
  const registered = [];
  root.provide('tuiPluginHost', {
    registerCommand() { attempts.push('mediated'); throw new Error('COMPONENT_NOT_ADMITTED'); },
  });
  root.provide('commands', { register(definition) { registered.push(definition); return () => {}; } });
  root.provide('tuiScenes', { register: () => () => {}, open: () => true });

  // Its own instance: the module default row is shared with other tests.
  const own = await budgetRow({ budgetMs: 300 });
  const host = root.plugin(own);
  await settle();

  assert.deepEqual(attempts, ['mediated'], 'the preferred path must be tried first');
  assert.equal(registered.length, 1, 'the fallback must register the command');
  assert.equal(registered[0].name, 'rewrite');
  assert.equal(registered[0].recordInput, false, 'opening a scene is not conversation content');
  assert.equal(typeof registered[0].handler, 'function');
  assert.equal(projectionStatus(own).command, true);
  await host.dispose();
});

test('the command handler reports a scene-open failure instead of failing silently', async () => {
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const registered = [];
  root.provide('commands', { register(definition) { registered.push(definition); return () => {}; } });
  root.provide('tuiScenes', { register: () => () => {}, open: () => false });
  const host = root.plugin(row);
  await settle();

  const result = registered[0].handler();
  assert.equal(result.kind, 'error');
  assert.match(result.text, /not registered/u);
  await host.dispose();
});

test('projectionStatus without a handle still describes the newest instance', async () => {
  // The single-instance production case: callers that have no row handle keep
  // working. A bare call before any instance exists must be honest, not throw.
  const { host, row } = await boot();
  assert.equal(projectionStatus().registered, projectionStatus(row).registered);
  await host.dispose();
});
test('a scene seam mounted AFTER apply is still picked up', async () => {
  // The real-boot race the reference implementation documents: the plugin's row
  // activates before the TUI runtime service exists, the soft-probe finds
  // nothing, and every /rewrite then fails to open for the whole session. The
  // late-mount poll is what makes this recoverable.
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const registered = [];
  const seam = {
    register(descriptor) { registered.push(descriptor); return () => {}; },
    open: () => true,
  };

  // The seam appears only AFTER apply has already probed for it.
  const arm = setTimeout(() => root.provide('tuiScenes', seam), 40);
  const host = root.plugin(await budgetRow({ budgetMs: 3000 }));
  assert.equal(registered.length, 0, 'nothing to register against at apply time');

  await settle(200);
  clearTimeout(arm);

  assert.equal(registered.length, 1, 'the poll must register once the seam appears');
  assert.equal(registered[0].id, 'dsh-tui-rewrite-scene');
  await host.dispose();
});