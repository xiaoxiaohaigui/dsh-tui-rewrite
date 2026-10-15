
import { RewriteScene, setSessionResolver } from 'dsh-tui-rewrite/scene';
import { sessionWithReplies } from './test-harness/tools.mjs';

// Minimal re-implementation of the harness renderer (probe only, deleted after).
function makeRenderer() {
  const state = []; const memos = []; const effects = []; const inputs = []; const pending = [];
  let committed = []; let cursor = 0;
  const React = {
    useState: initial => { const slot = cursor++; if (state[slot] === undefined) state[slot] = { value: typeof initial === 'function' ? initial() : initial };
      const set = next => { state[slot].value = typeof next === 'function' ? next(state[slot].value) : next; }; return [state[slot].value, set]; },
    useMemo: (factory, deps) => { const slot = cursor++; memos[slot] ??= { value: factory(), deps }; return memos[slot].value; },
    useEffect: (fn, deps) => { pending.push({ fn, deps }); },
    useCallback: fn => fn,
  };
  const ui = { Box: 'Box', Text: 'Text', useTerminalSize: () => ({ columns: 100, rows: 24 }), useInput: h => { inputs.push(h); } };
  const pass = () => { cursor = 0; pending.length = 0; return RewriteScene({ React, ui, channel: { sessionId: 's1' }, close: () => {} }); };
  const texts = (node, out = []) => { if (node == null || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
    if (Array.isArray(node)) { for (const c of node) texts(c, out); return out; }
    const { children } = node.props ?? {}; if (typeof children === 'string' || typeof children === 'number') out.push(String(children)); else texts(children, out); return out; };
  const render = () => { const tree = pass(); const fresh = pending.splice(0); let dirty = false;
    fresh.forEach((e, i) => { const p = committed[i];
      const changed = p === undefined || e.deps === undefined || p.deps === undefined || e.deps.length !== p.deps.length || e.deps.some((d, n) => !Object.is(d, p.deps[n]));
      if (!changed) return; e.fn(); dirty = true; });
    committed = fresh; return dirty ? render() : texts(tree).join('\n'); };
  return { render, inputs };
}

const session = await sessionWithReplies(['HELLO']);
setSessionResolver(() => session);
const r = makeRenderer();
r.render();
const key = (input, extra = {}) => r.inputs[0](input, { escape: false, ctrl: false, meta: false, super: false, leftArrow: false, rightArrow: false, upArrow: false, downArrow: false, return: false, backspace: false, delete: false, ...extra });

// Enter -> edit mode
key('', { return: true });
console.log('after Enter (edit view):');
console.log(r.render().split('\n').slice(0, 4).join('\n'));

// TWO keys in ONE chunk, no render between them (exactly what React batching does)
key('X');
key('Y');
console.log('\nafter X then Y in one chunk:');
console.log(r.render().split('\n').slice(2, 5).join('\n'));
console.log('--- expected draft: HELLOXY ---');

// second scenario: Esc then Ctrl+S in one chunk
const before = session.surface.nodes.length;
key('', { escape: true });
key('s', { ctrl: true });
console.log('\nappend count before=' + before + ' after Esc+CtrlS in one chunk=' + session.surface.nodes.length);
console.log('log events of our type:', session.events?.filter?.(e => e.type === 'dsh-tui-rewrite/message').length ?? '(n/a)');
