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
import {
  RewriteScene, SCENE_ID, setSessionResolver, sessionFor, collectTargets, messageText, lineStartOf,
  lineEndOf, useMirrorRefs,
} from 'dsh-tui-rewrite/scene';
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
 * Rows carrying a hover handler, i.e. the list rows the pointer can rest on.
 * Found by React key rather than by position: the row a test means is the one
 * for a given seq, and the tests below exist precisely because the two can
 * disagree.
 */
function hoverRows(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) hoverRows(child, out); return out; }
  if (typeof node.props?.onMouseEnter === 'function') out.push(node);
  hoverRows(node.props?.children, out);
  return out;
}

/** The rendered list row for a target seq. */
function rowFor(view, seq) {
  return hoverRows(view.tree).find(row => row.key === 'target-' + seq);
}

/** The scrollable list container: the element the wheel events arrive on. */
function findWheelBox(node) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findWheelBox(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node.props?.onWheel === 'function') return node;
  return findWheelBox(node.props?.children);
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
  // Memoized hooks get their OWN counter: they must advance the shared hook
  // cursor (React matches hooks by call order) but their cache cannot share the
  // state array, or a useRef and a useCallback at different positions collide.
  // An un-memoized useCallback returns a NEW function every render, which makes
  // any effect listing it as a dependency re-fire forever.
  let memoCursor = 0;
  const memoSlot = () => {
    cursor += 1;
    memoCursor += 1;
    return memoCursor - 1;
  };
  const React = {
    useState: initial => {
      const slot = cursor;
      cursor += 1;
      if (state[slot] === undefined) {
        state[slot] = { value: typeof initial === 'function' ? initial() : initial };
        // The setter is created ONCE per slot and reused, as React reuses it.
        // A fresh setter per render would be captured by whatever useCallback
        // memoizes around it, and the memoized writer would then keep writing
        // through a closure of an earlier render - a hazard the real host does
        // not have, so the stub must not invent it.
        state[slot].set = next => {
          state[slot].value = typeof next === 'function' ? next(state[slot].value) : next;
        };
      }
      return [state[slot].value, state[slot].set];
    },
    useRef: initial => {
      const slot = memoSlot();
      memos[slot] ??= { value: { current: initial } };
      return memos[slot].value;
    },
    useMemo: (factory, deps) => {
      const slot = memoSlot();
      memos[slot] ??= { value: factory(), deps };
      return memos[slot].value;
    },
    useEffect: (fn, deps) => { pending.push({ fn, deps }); },
    useCallback: (fn, deps) => {
      const slot = memoSlot();
      const held = memos[slot];
      const stable = held !== undefined && deps !== undefined && held.deps !== undefined
        && deps.length === held.deps.length
        && deps.every((dep, index) => Object.is(dep, held.deps[index]));
      if (stable) return held.value;
      memos[slot] = { value: fn, deps };
      return fn;
    },
  };
  const ui = {
    Box: 'Box',
    Text: 'Text',
    useTerminalSize: () => ({ columns: 100, rows: 24 }),
    // One handler per render pass, like React: useInput re-registers on every
    // render (its subscription is effect-scoped, so the previous render's
    // handler is gone). Keeping the old ones would let a test drive a handler
    // whose captured state is a render stale - and would run every key twice.
    useInput: handler => { inputs.length = 0; inputs.push(handler); },
  };
  const pass = channel => {
    cursor = 0;
    memoCursor = 0;
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

/**
 * Drive the scene's input handler, which no other suite touches.
 *
 * The handler is where React batching bites: one stdin chunk delivers several
 * parsed keys before a re-render, so a handler that reads stale state loses
 * keys. These cases call `inputs[0]` directly, with no render in between -
 * exactly the shape of one chunk.
 */
function press(runtime, input, extra = {}) {
  runtime.inputs[0](input, {
    escape: false, ctrl: false, meta: false, super: false,
    leftArrow: false, rightArrow: false, upArrow: false, downArrow: false,
    return: false, backspace: false, delete: false, home: false, end: false, ...extra,
  });
}

/** The edit pane's caret line, i.e. what the user is actually typing into. */
function caretLine(view) {
  return view.text.split('\n').find(line => line.includes('▏'));
}

/**
 * A React stub whose ONLY tracked hook is the mirror hook, so a test can count
 * how many slots it occupies.
 */
function mirrorHost({ withUseRef }) {
  let slots = 0;
  const cache = [];
  const React = {
    useRef: initial => {
      const slot = slots++;
      cache[slot] ??= { current: initial };
      return cache[slot];
    },
    useMemo: (factory, deps) => {
      const slot = slots++;
      cache[slot] ??= { value: factory(), deps };
      return cache[slot].value;
    },
  };
  if (!withUseRef) delete React.useRef;
  // React resets the hook cursor at the start of every render; the call below
  // is the hook's call site, so each one begins a fresh pass.
  return { React, slots: () => slots, beginRender: () => { slots = 0; } };
}

test('the mirror hook is stable across renders and takes one slot either way', () => {
  // Its stability is what makes the handler's reads meaningful: a fresh mirror
  // object per render would detach the handler from the state it tracks, and a
  // hook count that varied between renders would shift every later hook slot.
  for (const withUseRef of [true, false]) {
    const host = mirrorHost({ withUseRef });
    host.beginRender();
    const first = useMirrorRefs(host.React);
    assert.equal(host.slots(), 1, 'the mirror hook must occupy exactly one slot');
    first.draft.current = 'EDITED';
    first.selected.current = 3;

    host.beginRender();
    const second = useMirrorRefs(host.React);
    assert.equal(host.slots(), 1, 'one slot per render, whether it is useRef or useMemo');
    assert.equal(second, first, 'the mirror object must survive a render');
    assert.equal(second.draft.current, 'EDITED', 'a render must not reset the mirrors');
    assert.equal(second.selected.current, 3);
  }
});

test('a session shape with a non-array content field degrades instead of throwing', () => {
  // collectTargets only wraps deriveEventMessage in a try/catch, so a throw from
  // the text extraction escapes into the render path and the host's error
  // boundary closes the whole scene. Same guard as applyRewrite uses.
  assert.equal(messageText({ role: 'assistant', content: 'plain string' }), '');
  assert.equal(messageText({ role: 'assistant', content: null }), '');
  assert.equal(messageText({ role: 'assistant', content: { type: 'text' } }), '');
  assert.equal(messageText({ role: 'assistant' }), '');
  // a text part with no string text must not become the literal "undefined"
  assert.equal(messageText({ content: [{ type: 'text' }, { type: 'text', text: 'ok' }] }), '\nok');

  const session = {
    surface: { nodes: [0] },
    eventAt: () => ({ seq: 0 }),
    deriveEventMessage: () => ({ role: 'assistant', content: 'plain string' }),
  };
  assert.deepEqual(collectTargets(session), []);
});

test('the no-session notice is not a render-time side effect', async () => {
  // debugLog appends to a file SYNCHRONOUSLY, and a render runs many times per
  // keystroke. The notice belongs to the effect that watches the resolved
  // session, so re-rendering the same state must not write again.
  setSessionResolver(undefined);
  const runtime = makeRenderer();
  assert.match(runtime.render({ sessionId: 's1' }).text, /no live session is bound/u);

  // The notice lives in an effect keyed on the resolved session. With an
  // unchanged session and an unchanged channel id, rendering again must produce
  // no effect to run at all - that is what keeps the file I/O off the render
  // path. (A render-time debugLog would have written on every single pass.)
  const settled = runtime.effects().length;
  runtime.render({ sessionId: 's1' });
  runtime.render({ sessionId: 's1' });
  assert.equal(runtime.effects().length, settled, 'a re-render with the same session must schedule nothing');
});

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
    effects().some(effect => effect.deps?.includes(session)),
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

test('two keys in ONE chunk both land in the draft (React batches a chunk)', async () => {
  // One stdin chunk is one batch: the handler runs for every parsed key before
  // any re-render. A handler that read React state directly would see the same
  // pre-chunk snapshot twice and drop the first key - the "lost keystroke" bug
  // the mirror discipline exists to prevent.
  const session = await sessionWithReplies(['HELLO']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });

  press(runtime, '', { return: true });   // Enter starts the edit
  press(runtime, 'X');
  press(runtime, 'Y');                    // same chunk: no render in between

  assert.match(caretLine(runtime.render({ sessionId: 's1' })), /HELLOXY/u);
});

test('a multi-character paste in one chunk survives whole', async () => {
  const session = await sessionWithReplies(['HELLO']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });

  press(runtime, '', { return: true });
  press(runtime, 'XYZ');                  // a paste is one multi-char input

  assert.match(caretLine(runtime.render({ sessionId: 's1' })), /HELLOXYZ/u);
});

test('Esc then Ctrl+S in ONE chunk does not append the cancelled draft', async () => {
  // Esc must win for the rest of the chunk. Reading the render-time mirror left
  // the handler in "edit" mode with the old draft, so the very next key of the
  // same chunk submitted text the user had just cancelled.
  const session = await sessionWithReplies(['HELLO']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });

  press(runtime, '', { return: true });
  press(runtime, 'Z');
  runtime.render({ sessionId: 's1' });     // the edit is on screen
  press(runtime, '', { escape: true });    // cancel ...
  press(runtime, 's', { ctrl: true });     // ... and submit, same chunk

  const appended = session.snapshotEvents().filter(event => event.type === 'dsh-tui-rewrite/message');
  assert.deepEqual(appended, [], 'a cancelled edit must not be appended');
  assert.equal(session.surface.nodes.length, 1, 'the surface must be untouched');
});

test('Ctrl+S in ONE chunk after an edit submits the text as edited', async () => {
  // The positive control for the case above: what the handler submits must be
  // the draft including the keys of the same chunk, never the render-time copy.
  const session = await sessionWithReplies(['HELLO']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });

  press(runtime, '', { return: true });
  press(runtime, 'X');
  press(runtime, 'Y');
  press(runtime, 's', { ctrl: true });

  // The payload is the contract: these sessions carry no projection (that round
  // trip is covered in plugin.test.mjs), so the event is what must be right.
  const appended = session.snapshotEvents().filter(event => event.type === 'dsh-tui-rewrite/message');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.content, 'HELLOXY');
  assert.equal(appended[0].data.targetSeq, session.surface.nodes[0]);
});

test('a draft emptied in the editor is refused instead of appended', async () => {
  // R-009: the projection would happily produce an assistant message whose only
  // text block is empty, a shape the natural derivation never produces.
  const session = await sessionWithReplies(['HELLO']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });

  press(runtime, '', { return: true });
  for (let i = 0; i < 5; i += 1) press(runtime, '', { backspace: true });   // empty it
  runtime.render({ sessionId: 's1' });
  press(runtime, 's', { ctrl: true });                                      // submit anyway

  assert.deepEqual(
    session.snapshotEvents().filter(event => event.type === 'dsh-tui-rewrite/message'),
    [],
    'an empty draft must not become a rewrite event',
  );
  const view = runtime.render({ sessionId: 's1' });
  assert.match(view.text, /empty text — nothing appended/u);
  // the editor closed, so the list is showing again and the reply is intact
  assert.match(view.text, /rewrite · 1 assistant reply/u);
});

test('a whitespace-only draft is refused too, and a non-empty one still works', async () => {
  const session = await sessionWithReplies(['HELLO']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });

  press(runtime, '', { return: true });
  for (let i = 0; i < 5; i += 1) press(runtime, '', { backspace: true });
  press(runtime, '   ');                    // spaces only
  runtime.render({ sessionId: 's1' });
  press(runtime, 's', { ctrl: true });
  assert.deepEqual(
    session.snapshotEvents().filter(event => event.type === 'dsh-tui-rewrite/message'),
    [],
  );

  // the control: real text still submits
  press(runtime, '', { return: true });
  press(runtime, 'ok');
  press(runtime, 's', { ctrl: true });
  const appended = session.snapshotEvents().filter(event => event.type === 'dsh-tui-rewrite/message');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.content, 'HELLOok');
});

/**
 * Home/End (phase 1c, PLAN C2).
 *
 * These drive the handler rather than a helper because the helper was never the
 * risk: R-001 was a distribution defect, and a key that is never delivered is
 * indistinguishable from a key that is not implemented. Both keys are therefore
 * tested through one chunk, mirror reads included.
 */
test('Home and End move within the caret LINE, not the buffer', async () => {
  const session = await sessionWithReplies(['ABC\nDE\nF']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });
  press(runtime, '', { return: true });          // Enter starts the edit, caret at the end

  const header = () => runtime.render({ sessionId: 's1' }).text.split('\n')[0];

  press(runtime, '', { home: true });            // line 3 "F" starts at unit 7
  press(runtime, '', { home: true });            // already there: a no-op, not a jump to unit 0
  assert.equal(header(), ' rewrite · editing seq 0  (line 3/3)');
  assert.match(caretLine(runtime.render({ sessionId: 's1' })), /▏F/u);

  // End on the LAST line has no terminator to stop at, so it reaches the end of
  // the buffer - one step further than Home put us.
  press(runtime, '', { end: true });
  press(runtime, '', { rightArrow: true });      // already at the end: still the end
  assert.match(caretLine(runtime.render({ sessionId: 's1' })), /▏F/u);

  // Two steps left: unit 7 is the first unit of line 3 (a position belongs to
  // the line it opens), and unit 6 is the newline that TERMINATES line 2. The
  // caret is then on line 2 but NOT at its start, which is what makes the pair
  // below discriminating: Home must land on unit 4 (line 2's first unit, not
  // the buffer's), and End must come back to unit 6 (line 2's terminator, not
  // one step past it into line 3).
  press(runtime, '', { leftArrow: true });
  assert.equal(header(), ' rewrite · editing seq 0  (line 3/3)', 'unit 7 opens line 3');
  press(runtime, '', { leftArrow: true });
  assert.equal(header(), ' rewrite · editing seq 0  (line 2/3)');
  press(runtime, '', { home: true });
  assert.match(caretLine(runtime.render({ sessionId: 's1' })), /▏DE/u);
  press(runtime, '', { end: true });
  assert.equal(header(), ' rewrite · editing seq 0  (line 2/3)');
  press(runtime, '', { home: true });
  assert.equal(header(), ' rewrite · editing seq 0  (line 2/3)');
  assert.match(caretLine(runtime.render({ sessionId: 's1' })), /▏DE/u);
});

test('End then Down keeps the column, because End lands on the terminator', async () => {
  const session = await sessionWithReplies(['ABCD\nXY\nZ']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });
  press(runtime, '', { return: true });

  press(runtime, '', { upArrow: true });         // line "XY", clamped to its end (unit 5)
  press(runtime, '', { upArrow: true });         // line "ABCD", clamped to its end for the column (4)
  press(runtime, '', { home: true });            // Home starts the line "ABCD"
  press(runtime, '', { end: true });             // End ends it - column 4, where Down will land
  press(runtime, '', { downArrow: true });

  // Landed in the SAME column on "XY". One column short (the pre-fix behaviour)
  // would put the caret before the Y.
  assert.match(caretLine(runtime.render({ sessionId: 's1' })), /▏XY/u);
});

test('Home then End in ONE chunk resolves against the draft, not the render', async () => {
  // The mirror discipline: both keys are parsed from the same stdin chunk and
  // the handler runs twice with no render in between. A handler reading state
  // would place the second move from the pre-chunk caret.
  const session = await sessionWithReplies(['ABC']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });
  press(runtime, '', { return: true });

  press(runtime, '', { home: true });            // caret 3 -> 0 ...
  press(runtime, '', { end: true });             // ... -> 3, in the same chunk
  assert.match(caretLine(runtime.render({ sessionId: 's1' })), /▏ABC/u);

  press(runtime, '', { home: true });
  press(runtime, 'X');                           // insert AT the line start
  assert.match(caretLine(runtime.render({ sessionId: 's1' })), /▏X/u);
});

test('a list row carries the hover handlers, and hover is component-local state', async () => {
  const session = await sessionWithReplies(['first', 'second']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  const view = runtime.render({ sessionId: 's1' });
  const [firstSeq, secondSeq] = session.surface.nodes;

  const first = rowFor(view, firstSeq);
  const second = rowFor(view, secondSeq);
  assert.equal(typeof second?.props.onMouseEnter, 'function', 'a row must be able to hover');
  assert.equal(typeof second?.props.onMouseLeave, 'function');
  // The host's hover diff hands the event in but the handler takes none; what
  // matters is that the handlers exist on the ROW (not on an inner Text, whose
  // rect is the same but whose identity is not stable across renders).
  assert.equal(second.props.backgroundColor, undefined, 'an untouched row is unhighlighted');
  assert.equal(first.props.backgroundColor, 'selectionBg', 'the selected row: selection outranks hover');

  // Hover the row that is NOT selected, so the assertion cannot be satisfied by
  // selection alone.
  second.props.onMouseEnter();
  const hovered = runtime.render({ sessionId: 's1' });
  assert.equal(rowFor(hovered, secondSeq).props.backgroundColor, 'userMessageBackgroundHover');
  assert.equal(rowFor(hovered, firstSeq).props.backgroundColor, 'selectionBg', 'selection is unchanged');

  rowFor(hovered, secondSeq).props.onMouseLeave();
  const left = runtime.render({ sessionId: 's1' });
  assert.equal(rowFor(left, secondSeq).props.backgroundColor, undefined, 'leaving clears the highlight');
});

test('a leave from the row just left does not blank the row just entered', async () => {
  // The host diffs its hovered set: one pointer move that crosses a row border
  // fires LEAVE(old) and ENTER(new) in the SAME React batch. A leave handler
  // that cleared unconditionally would erase the row the pointer now sits on -
  // and the pointer is not moving again, so the highlight would stay missing.
  const session = await sessionWithReplies(['first', 'second']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  const view = runtime.render({ sessionId: 's1' });
  const [firstSeq, secondSeq] = session.surface.nodes;

  rowFor(view, firstSeq).props.onMouseEnter();
  const onFirst = runtime.render({ sessionId: 's1' });
  assert.equal(rowFor(onFirst, firstSeq).props.backgroundColor, 'selectionBg');

  rowFor(onFirst, secondSeq).props.onMouseEnter();
  rowFor(onFirst, firstSeq).props.onMouseLeave();   // same batch
  const moved = runtime.render({ sessionId: 's1' });

  assert.equal(rowFor(moved, secondSeq).props.backgroundColor, 'userMessageBackgroundHover');
  // row 1 is still the SELECTED row, so its own highlight never went away -
  // the leave from it must not have been read as "hover row 1".
  assert.equal(rowFor(moved, firstSeq).props.backgroundColor, 'selectionBg');
});

test('a leave that arrives without an enter still clears the highlight', async () => {
  // The other half of the contract: a pointer that leaves the list entirely
  // (onto the header, past the last row, out of the terminal) fires leave with
  // no enter behind it. The row must go back to unhighlighted.
  const session = await sessionWithReplies(['first', 'second']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  const view = runtime.render({ sessionId: 's1' });
  const [firstSeq, secondSeq] = session.surface.nodes;

  // Move the SELECTION to row 1 first: while row 1 is selected it keeps its
  // selection block whatever the pointer does, so it cannot show the hover
  // coming and going. Row 2 is then a row whose appearance is hover alone.
  press(runtime, 'j');
  const withSelectionMoved = runtime.render({ sessionId: 's1' });
  assert.equal(rowFor(withSelectionMoved, secondSeq).props.backgroundColor, 'selectionBg');

  rowFor(withSelectionMoved, firstSeq).props.onMouseEnter();
  const hovered = runtime.render({ sessionId: 's1' });
  assert.equal(rowFor(hovered, firstSeq).props.backgroundColor, 'userMessageBackgroundHover');
  assert.equal(rowFor(hovered, secondSeq).props.backgroundColor, 'selectionBg');

  rowFor(hovered, firstSeq).props.onMouseLeave();
  const out = runtime.render({ sessionId: 's1' });
  assert.equal(rowFor(out, firstSeq).props.backgroundColor, undefined, 'the pointer left the list');
  assert.equal(rowFor(out, secondSeq).props.backgroundColor, 'selectionBg', 'selection is not hover');
});

test('the wheel scrolls the selection through the list, viewport following it', async () => {
  // The wheel is the third way to move the selection (after the arrows and a
  // click), and it exists so a long list can be traversed without arrowing
  // through it. It therefore has to obey the same invariant as the arrows: the
  // selected row stays inside the viewport, and nothing about the viewport
  // fights the input back.
  const session = await sessionWithReplies(
    Array.from({ length: 40 }, (unused, index) => 'reply ' + index),
  );
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  const view = runtime.render({ sessionId: 's1' });

  const windowRows = hoverRows(view.tree).length;
  assert.ok(windowRows > 2 && windowRows < 40, 'the viewport must be a real window over the list');
  assert.equal(hoverRows(view.tree)[0].key, 'target-0');

  findWheelBox(view.tree).props.onWheel({ deltaY: windowRows + 1, deltaX: 0 });
  const scrolled = runtime.render({ sessionId: 's1' });

  // The selection moved by the wheel's row step, and the window followed it:
  // exactly one row carries the selection block, and it is off the top of the
  // first screen.
  const step = windowRows + 1;
  const selectedRows = hoverRows(scrolled.tree)
    .filter(row => row.props.backgroundColor === 'selectionBg');
  assert.equal(selectedRows.length, 1, 'exactly one row is selected');
  assert.equal(selectedRows[0].key, 'target-' + step);
  // The selection is the last visible row: the window scrolled as little as it
  // could while still showing the selected row, which is what makes this a
  // viewport FOLLOW rather than a jump to the top.
  assert.equal(hoverRows(scrolled.tree).at(-1).key, 'target-' + step);
  assert.equal(rowFor(scrolled, 0), undefined, 'the first row left the window');
});

test('hover follows the row, not the screen slot, when the list scrolls under it', async () => {
  // B5: the pointer does not move, but the rows under it do. The host re-runs
  // its hit test after the commit and fires ENTER for whichever row now sits at
  // that screen position; the row that left must not keep a highlight, and the
  // newcomer must not inherit one from the slot it landed in.
  const session = await sessionWithReplies(
    Array.from({ length: 40 }, (unused, index) => 'reply ' + index),
  );
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  const view = runtime.render({ sessionId: 's1' });

  // Hovered row 0 also happens to be the selected one, whose block would mask
  // the hover - so this checks the slot's newcomer with row 0 deselected.
  press(runtime, 'j');                       // selection out of the way
  const moved = runtime.render({ sessionId: 's1' });
  rowFor(moved, session.surface.nodes[0]).props.onMouseEnter();
  const hovered = runtime.render({ sessionId: 's1' });
  assert.equal(rowFor(hovered, 0).props.backgroundColor, 'userMessageBackgroundHover');

  // Scroll it out of the window (the senders move the selection, viewport follows).
  const windowRows = hoverRows(hovered.tree).length;
  findWheelBox(hovered.tree).props.onWheel({ deltaY: windowRows, deltaX: 0 });
  const scrolled = runtime.render({ sessionId: 's1' });

  assert.equal(rowFor(scrolled, 0), undefined, 'the hovered row left the window');
  assert.equal(
    hoverRows(scrolled.tree).some(row => row.props.backgroundColor === 'userMessageBackgroundHover'),
    false,
    'no row may inherit the highlight from the screen slot it landed in',
  );

  // The host reports the pointer over whatever row is there now; that is the
  // row which gets the highlight.
  const arrived = hoverRows(scrolled.tree)[0];
  assert.notEqual(arrived.key, 'target-0');
  arrived.props.onMouseEnter();
  const landed = runtime.render({ sessionId: 's1' });
  const arrivedSeq = Number(arrived.key.slice('target-'.length));
  assert.equal(rowFor(landed, arrivedSeq).props.backgroundColor, 'userMessageBackgroundHover');
  assert.equal(rowFor(landed, 0), undefined);
});

test('a horizontal-only wheel event scrolls nothing', async () => {
  const session = await sessionWithReplies(['first', 'second', 'third']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  const view = runtime.render({ sessionId: 's1' });

  findWheelBox(view.tree).props.onWheel({ deltaY: 0, deltaX: 4 });
  const after = runtime.render({ sessionId: 's1' });
  assert.equal(hoverRows(after.tree)[0].key, 'target-0', 'the selection must not move sideways');
  assert.equal(rowFor(after, session.surface.nodes[0]).props.backgroundColor, 'selectionBg');
});

test('typing is a no-op in list mode and Esc closes instead', async () => {
  const session = await sessionWithReplies(['HELLO']);
  setSessionResolver(() => session);
  const runtime = makeRenderer();
  runtime.render({ sessionId: 's1' });

  press(runtime, 'q');
  assert.match(runtime.render({ sessionId: 's1' }).text, /rewrite · 1 assistant reply/u);
  press(runtime, '', { escape: true });
  assert.equal(runtime.isClosed(), true);
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
