/**
 * Phase 1a: the scene's data source and its degraded paths.
 *
 * The host injects exactly four props (React, ui, channel, close) - there is no
 * session prop - so the scene resolves the live Session itself through the
 * resolver main.js publishes. These tests drive the component with a minimal
 * hook simulation (no reconciler, no terminal) and assert what the user would
 * actually read on screen: the header, the row previews, and the empty states.
 *
 * The sessions are REAL dsh-session sessions built through a real SessionStore
 * (see tools.mjs) - a hand-rolled double would drift from the surface semantics
 * the scene depends on.
 *
 * Rendering the real tree is on-device verification by design - see
 * docs/explore/phase1a-results.md.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { RewriteScene, SCENE_ID, setSessionResolver, sessionFor, collectTargets } from 'dsh-tui-rewrite/scene';
import { openSession, sessionWithReplies } from '../tools.mjs';

// A leaked resolver would make the next test read another test's session.
after(() => { setSessionResolver(undefined); });

/** Deepest-first text content of a rendered tree, one string per Text node. */
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out; }
  const { children } = node.props ?? {};
  if (typeof children === 'string' || typeof children === 'number') out.push(String(children));
  else texts(children, out);
  return out;
}

/** Rows the scene painted, i.e. elements carrying a click handler. */
function rows(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) rows(child, out); return out; }
  if (typeof node.props?.onClick === 'function') out.push(node);
  rows(node.props?.children, out);
  return out;
}

/**
 * Call the component with the host's four props on a simulated hook runtime.
 * Each `render()` is one render pass; state persists in call order, the way
 * React keeps it per hook slot.
 */
function makeRenderer() {
  const state = [];
  const memos = [];
  const effects = [];
  const inputs = [];
  const pending = [];
  let committed = [];
  let cursor = 0;
  let closed = false;
  const React = {
    useState: initial => {
      const slot = cursor;
      cursor += 1;
      if (state[slot] === undefined) state[slot] = { value: typeof initial === 'function' ? initial() : initial };
      const set = next => { state[slot].value = typeof next === 'function' ? next(state[slot].value) : next; };
      return [state[slot].value, set];
    },
    // No dependency tracking: the scene's memo has an empty list by design.
    useMemo: (factory, deps) => {
      const slot = cursor;
      cursor += 1;
      memos[slot] ??= { value: factory(), deps };
      return memos[slot].value;
    },
    useEffect: (fn, deps) => { pending.push({ fn, deps }); },
    useCallback: fn => fn,
  };
  const ui = {
    Box: 'Box',
    Text: 'Text',
    useTerminalSize: () => ({ columns: 100, rows: 24 }),
    useInput: handler => { inputs.push(handler); },
  };
  const pass = channel => {
    cursor = 0;
    pending.length = 0;
    const tree = RewriteScene({
      React,
      ui,
      channel: channel ?? { sessionId: 's1' },
      close: () => { closed = true; },
    });
    return { text: texts(tree).join('\n'), rows: rows(tree), tree };
  };
  /**
   * One render pass, then every effect whose dependencies changed - as React
   * does. Effects are matched to the PREVIOUS render's effects by call order
   * (their hook slot), so an early return that skips hooks does not shift the
   * comparison.
   */
  const render = channel => {
    const view = pass(channel);
    const fresh = pending.splice(0);
    let dirty = false;
    fresh.forEach((effect, index) => {
      const previous = committed[index];
      const changed = previous === undefined
        || effect.deps === undefined
        || previous.deps === undefined
        || effect.deps.length !== previous.deps.length
        || effect.deps.some((dep, position) => !Object.is(dep, previous.deps[position]));
      if (!changed) return;
      effect.runs = 0;
      effect.fn();
      if (effect.runs !== undefined) effect.runs += 1;
      dirty = true;
    });
    committed = fresh;
    return dirty ? render(channel) : view;
  };
  return { render, effects: () => committed, inputs, isClosed: () => closed };
}

test('the scene paints one row per assistant reply, from the resolver session', async () => {
  const session = await sessionWithReplies(['first reply', 'second reply']);
  setSessionResolver(id => (id === 's1' ? session : undefined));
  const { render } = makeRenderer();

  const view = render({ sessionId: 's1' });
  assert.match(view.text, /rewrite · 2 assistant replies · session s1/u);
  assert.equal(view.rows.length, 2);
  assert.ok(view.text.includes('first reply'));
  assert.ok(view.text.includes('second reply'));
  // the row shows the seq the model surface uses, not a display index
  assert.ok(view.text.includes('seq ' + session.surface.nodes[0]));
});

test('the header truncates the session id to eight characters', async () => {
  const session = await sessionWithReplies(['one']);
  setSessionResolver(() => session);
  const { render } = makeRenderer();
  const view = render({ sessionId: 'abcdefgh-1234-5678' });
  assert.match(view.text, /session abcdefgh/u);
  assert.ok(!view.text.includes('abcdefgh-1234'));
});

test('the scene says so when no session is bound instead of showing an empty list', () => {
  setSessionResolver(undefined);
  const { render } = makeRenderer();
  const view = render({ sessionId: 's1' });
  assert.match(view.text, /no live session is bound to this UI/u);
  assert.equal(view.rows.length, 0);
});

test('a resolver that throws degrades to the no-session notice', () => {
  setSessionResolver(() => { throw new Error('store exploded'); });
  const { render } = makeRenderer();
  const view = render({ sessionId: 's1' });
  assert.match(view.text, /no live session is bound to this UI/u);
});

test('sessionFor refuses an empty or non-string id without calling the resolver', () => {
  let calls = 0;
  setSessionResolver(() => { calls += 1; return undefined; });
  assert.equal(sessionFor(''), undefined);
  assert.equal(sessionFor(undefined), undefined);
  assert.equal(sessionFor(42), undefined);
  assert.equal(calls, 0);
  assert.equal(sessionFor('s1'), undefined);
  assert.equal(calls, 1);
});

test('a session with no assistant replies shows the empty state, not a crash', async () => {
  const session = (await openSession([])).session;
  setSessionResolver(() => session);
  const { render } = makeRenderer();
  const view = render({ sessionId: 's1' });
  assert.match(view.text, /rewrite · 0 assistant replies/u);
  assert.match(view.text, /no assistant replies with text in this session yet/u);
  assert.equal(view.rows.length, 0);
});

test('a session whose replies are all tool calls shows the empty state', async () => {
  const session = await sessionWithReplies([[{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }]]);
  assert.equal(collectTargets(session).length, 0);
  setSessionResolver(() => session);
  const { render } = makeRenderer();
  assert.match(render({ sessionId: 's1' }).text, /no assistant replies with text/u);
});

test('a session shape from another kernel degrades to the empty state', () => {
  // A stable object: the resolver is called per render, and a fresh object each
  // time would read as "the session changed" (main.js returns the store's own
  // instance).
  const foreign = {};
  setSessionResolver(() => foreign);
  const { render } = makeRenderer();
  const view = render({ sessionId: 's1' });
  assert.match(view.text, /rewrite · 0 assistant replies/u);
});

test('a first paint without a session does not shift the hook slots', async () => {
  // React matches hooks by CALL ORDER. An effect (or a state hook) that only
  // runs on the session branch would shift every later hook by one slot when
  // the session appears - the list would then read its state from the wrong
  // slot and stay empty forever while looking healthy.
  const session = await sessionWithReplies(['first reply', 'second reply']);
  let live;
  setSessionResolver(id => (id === 's1' ? live : undefined));
  const { render } = makeRenderer();

  assert.match(render({ sessionId: 's1' }).text, /no live session is bound/u);

  live = session;
  const view = render({ sessionId: 's1' });
  // The selected row is slot 1 of the state; a shift would leave selection
  // pointing at a row that is not the first one.
  assert.equal(view.rows.length, 2);
  assert.ok(view.text.includes('❯ seq ' + session.surface.nodes[0]));
});

test('the list re-enumerates when the resolver starts answering for the bound id', async () => {
  const session = await sessionWithReplies(['late arrival']);
  let live;
  setSessionResolver(id => (id === 's1' ? live : undefined));
  const { render, effects } = makeRenderer();

  // First paint: the channel is bound but its session is not in the store yet.
  assert.match(render({ sessionId: 's1' }).text, /no live session is bound/u);

  // The session lands; the effect keyed on it must re-enumerate the rows.
  live = session;
  const view = render({ sessionId: 's1' });
  assert.equal(view.rows.length, 1);
  assert.ok(view.text.includes('late arrival'));
  assert.ok(
    effects().some(effect => effect.deps?.length === 1 && effect.deps[0] === session),
    'expected an effect keyed on the resolved session',
  );
});

test('the scene id is the kebab-case token the scene registry accepts', () => {
  assert.equal(SCENE_ID, 'dsh-tui-rewrite-scene');
  assert.match(SCENE_ID, /^[a-z0-9]+(-[a-z0-9]+)*$/u);
});

test('collectTargets enumerates nothing when a session has no nodes', async () => {
  const { session } = await openSession([]);
  assert.deepEqual(collectTargets(session), []);
});

test('collectTargets reads the projected text once a reply has been rewritten', async () => {
  const { session, root } = await openSession([{
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 0,
      step: 0,
      stream: [],
      message: {
        id: 'msg-0',
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'text', text: 'ORIGINAL' }, { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }],
      },
    },
  }], { plugin: true });
  const { REWRITE_EVENT_TYPE } = await import('dsh-tui-rewrite/projection');

  const seq = session.surface.nodes[0];
  session.append(REWRITE_EVENT_TYPE, { targetSeq: seq, content: 'REWRITTEN TEXT' });
  const target = collectTargets(session).find(item => item.seq === seq);
  assert.equal(target.original, 'REWRITTEN TEXT');
  assert.equal(target.preview, 'REWRITTEN TEXT');
  // the editor must start from what the MODEL sees, and the log keeps its own copy
  assert.notEqual(JSON.stringify(session.eventAt(seq).data.message).includes('REWRITTEN TEXT'), true);
});
