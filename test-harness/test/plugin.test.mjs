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
import { loadSampleSession, textOf } from '../tools.mjs';

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
  const host = root.plugin(await budgetRow({ budgetMs: 300 }));
  await settle();
  return { root, host };
}

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
  const { root } = await boot();
  const owners = root.sessions.messageProjections.filter(projection => projection.type === REWRITE_EVENT_TYPE);
  assert.equal(owners.length, 1);
  assert.equal(projectionStatus().registered, true);
  assert.equal(projectionStatus().applied, true);
});

test('a second owner of the same event type is refused, not displaced', async () => {
  const { root } = await boot();
  // A foreign projection already holding our type: registration must fail, and
  // the plugin must survive it (an unguarded effect body would have aborted the
  // rest of apply and taken the self-check down with it).
  const foreign = new Context();
  foreign.plugin(SessionStore);
  await settle();
  foreign.sessions.registerMessageProjection({ type: REWRITE_EVENT_TYPE, project: () => new Map() });
  const before = foreign.sessions.messageProjections.length;
  const host = foreign.plugin(row);
  await settle();
  assert.equal(foreign.sessions.messageProjections.length, before);
  assert.equal(projectionStatus().registered, false);
  assert.equal(typeof projectionStatus().reason, 'string');
  await host.dispose();
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
  const { root, host } = await boot();
  assert.equal(root.sessions.messageProjections.some(p => p.type === REWRITE_EVENT_TYPE), true);
  await host.dispose();
  await settle();
  assert.equal(root.sessions.messageProjections.some(p => p.type === REWRITE_EVENT_TYPE), false);
  assert.equal(projectionStatus().registered, false);
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
  const host = root.plugin(await budgetRow({ budgetMs: 400 }));
  await settle();
  const status = projectionStatus();
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
  assert.equal(main.SHORTCUT_COMBO, 'alt+r');
  assert.equal(main.SCENE_ID, 'dsh-tui-rewrite-scene');
  assert.deepEqual(main.inject, ['sessions']);
  // kebab-case, one slash: the grammar the entry-renderer and scene registries accept
  assert.match(main.SCENE_ID, /^[a-z0-9]+(-[a-z0-9]+)*$/u);
  // modifier-carrying, as the shortcut registry requires (bare letters are typing)
  assert.match(main.SHORTCUT_COMBO, /^(ctrl|alt|meta)\+/u);
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
  const host = root.plugin(row);
  await settle();

  assert.equal(projectionStatus().scene, true);
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

  const host = root.plugin(row);
  await settle();

  assert.deepEqual(attempts, ['mediated'], 'the preferred path must be tried first');
  assert.equal(registered.length, 1, 'the fallback must register the command');
  assert.equal(registered[0].name, 'rewrite');
  assert.equal(registered[0].recordInput, false, 'opening a scene is not conversation content');
  assert.equal(typeof registered[0].handler, 'function');
  assert.equal(projectionStatus().command, true);
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