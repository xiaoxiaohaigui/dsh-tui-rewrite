/**
 * The /rewrite full-screen scene: pick one assistant reply, edit its text.
 *
 * Opened by `/rewrite` or the plugin shortcut, through `ctx.tuiScenes`. The host
 * renders it in place of the chat tree, inside its own error boundary, so the
 * scene owns the whole screen and its own chrome.
 *
 * Session discovery needs NO hand-off from the command handler:
 * `channel.sessionId` names the session the UI is bound to, and
 * `ctx.sessions.get(id)` returns the live Session. The model-visible list is
 * `session.surface.nodes` (message-producing event seqs, in model order), each
 * paired with its own event through `deriveEventMessage()` - the pairing
 * matters, see collectTargets.
 *
 * The host injects exactly four props (React, ui, channel, close - see
 * `channel-scene-outlet.js`), and NONE of them is a session: main.js therefore
 * publishes the plugin's own lookup through `setSessionResolver`, and the scene
 * resolves `channel.sessionId` against it on every render. Reading the id from
 * the live channel rather than capturing it at open time is what lets the scene
 * follow a session switch instead of editing the session it was opened on.
 *
 * Input discipline: React batches every parsed key of one stdin chunk, so a
 * handler can run several times before a re-render. Branch decisions therefore
 * read synchronous ref mirrors, and position edits go through functional
 * setState — the same discipline the reference implementation documents.
 *
 * Keys: arrows/jk move, Enter edits, Esc backs out one layer, Ctrl+S submits.
 * Enter cannot submit: the editor needs it for newlines, and the host's rule is
 * that only an unmodified Enter commits a modal. Ctrl+S is therefore the submit
 * key, and it is also accepted on a list selection.
 *
 * @module dsh-tui-rewrite/scene
 */
import { jsx, jsxs } from '@deepseek-harness-tui/dsh-tui/jsx-runtime';
import { REWRITE_EVENT_TYPE } from './projection.js';
import { debugLog } from './debug.js';

/** Scene id (kebab-case, per the tuiScenes grammar). */
export const SCENE_ID = 'dsh-tui-rewrite-scene';

/** Edit-pane viewport rows. */
const EDIT_ROWS = 4;
/** Width budget for a list preview, in display cells. */
const PREVIEW_CELLS = 64;

/**
 * How the scene reaches the live Session. Installed once by main.js (which is
 * the side that owns a cordis context); `undefined` means "the plugin is not
 * wired", which the scene reports in the UI instead of rendering an empty list.
 *
 * @type {((sessionId: string) => unknown) | undefined}
 */
let sessionResolver;

/**
 * Publish the session lookup. Called once from the plugin's `apply`; swapping it
 * again is allowed so a test can drive the scene without a cordis context.
 *
 * @param {((sessionId: string) => unknown) | undefined} resolve
 */
export function setSessionResolver(resolve) {
  sessionResolver = resolve;
}

/**
 * The live session the UI is bound to, or `undefined` when it cannot be reached.
 *
 * @param {unknown} sessionId - `channel.sessionId`.
 * @returns {import('@deepseek-ai/dsh-session').Session | undefined}
 */
export function sessionFor(sessionId) {
  if (sessionResolver === undefined) return undefined;
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  try {
    return sessionResolver(sessionId);
  } catch (error) {
    // A store that throws is a host problem; the scene must still render.
    debugLog('sessionResolver threw', { sessionId, error: String(error) });
    return undefined;
  }
}

/** Code points, so astral characters edit as one unit. */
export function units(text) {
  return Array.from(text);
}

/** Display cells a code point occupies: 2 for the wide ranges, else 1. */
export function cellWidth(codePoint) {
  if (codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f680 && codePoint <= 0x1f6ff)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
    || (codePoint >= 0x1fa70 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )) return 2;
  return 1;
}

/** Clip to a display-cell budget (CJK-safe), with an ellipsis when clipped. */
export function clipCells(text, budget) {
  let used = 0;
  let out = '';
  for (const ch of text) {
    const w = cellWidth(ch.codePointAt(0));
    if (used + w > budget) return out + '…';
    out += ch;
    used += w;
  }
  return out;
}

/**
 * The message's own text, verbatim (what the editor starts from).
 *
 * `content` is a block array for every message dsh-llm produces, but this runs
 * from the render path on a session that may come from another kernel, and a
 * non-array there would throw out of `collectTargets`'s caller - past the
 * try/catch that only wraps `deriveEventMessage` - and close the whole scene
 * through the host's error boundary. `applyRewrite` already guards the same
 * field the same way; the two must agree on what a usable message is.
 *
 * @param {{content?: unknown}} [message]
 * @returns {string}
 */
export function messageText(message) {
  const content = message?.content;
  const parts = Array.isArray(content) ? content : [];
  return parts
    .filter(part => part !== null && typeof part === 'object' && part.type === 'text')
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

/** A one-line list preview: whitespace flattened, then clipped by display width. */
export function previewOf(text) {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length === 0 ? '(no text)' : clipCells(flat, PREVIEW_CELLS);
}

/** Index of the first unit of the line holding `cursor`. */
export function lineStartOf(chars, cursor) {
  let i = cursor;
  while (i > 0 && chars[i - 1] !== '\n') i -= 1;
  return i;
}

/** Visual row of `cursor` (counting newlines, not wrapped lines). */
export function rowOf(chars, cursor) {
  let row = 0;
  for (let i = 0; i < cursor; i += 1) if (chars[i] === '\n') row += 1;
  return row;
}

/**
 * Create the synchronous mirrors the input handler reads.
 *
 * A stdin chunk can deliver several keys before React re-renders, so a handler
 * that read state directly would act on stale values (the reference
 * implementation documents this as the source of "one key moves two rows"
 * bugs). The mirrors are a ref OBJECT created once.
 *
 * The handler is the ONLY writer of these mirrors, and every state edit goes
 * through a setter that writes the mirror in the same statement. Nothing in the
 * render path may re-sync them from state: React commits state updates
 * asynchronously, so a render triggered mid-chunk carries the PREVIOUS state
 * and would reset the mirror to it - dropping every key of the chunk (the
 * "cancel then Ctrl+S still submits" defect). `useRef` is what makes the
 * object outlive a discarded render, which `useMemo` does not promise.
 *
 * @param {typeof import('react')} React - the injected host React.
 * @returns {Record<string, {current: unknown}>} - one stable ref per mirror.
 */
export function useMirrorRefs(React) {
  const { useRef, useMemo } = React;
  // useRef is the correct API: React documents useMemo as a performance hint
  // only, so a discarded cache would hand back a NEW mirror object and detach
  // the handler from the state it is supposed to track.
  if (typeof useRef === 'function') return useRef(makeMirrors()).current;
  // Fallback for a host React without useRef. It occupies exactly ONE hook slot
  // like useRef does, so the slot layout - and therefore every later hook - does
  // not depend on which branch ran. scene-render.test.mjs exercises both.
  return useMemo(() => makeMirrors(), []);
}

/** The initial mirror set: one stable ref object per value the handler reads. */
function makeMirrors() {
  return {
    selected: { current: 0 },
    draft: { current: undefined },
    caret: { current: 0 },
    targets: { current: [] },
  };
}

/** Signed rows one wheel notch asks for; 0 for a horizontal-only event. */
export function wheelRows(deltaY, deltaX) {
  if (deltaY === 0 || !Number.isFinite(deltaY) || !Number.isFinite(deltaX)) return 0;
  const magnitude = Math.max(1, Math.round(Math.abs(deltaY)));
  return deltaY > 0 ? magnitude : -magnitude;
}

/**
 * The full-screen scene. Every hook and element comes from the injected host
 * React: a plugin-owned React copy dies with invalid-hook-call on first render.
 *
 * @param {Record<string, unknown>} props - the host's TuiSceneProps.
 */
export function RewriteScene(props) {
  const { React, ui, channel, close } = props;
  const { Box, Text, useInput, useTerminalSize } = ui;
  const { useState, useEffect, useCallback } = React;
  const size = useTerminalSize();
  // Read per render, not captured: a session switch under an open scene must
  // rebind the list instead of editing the session it was opened on.
  const session = sessionFor(channel?.sessionId);

  const [targets, setTargets] = useState(() => collectTargets(session));
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [draft, setDraft] = useState(undefined);
  const [status, setStatus] = useState('');
  const [caret, setCaret] = useState(0);

  // Mirrors for the input handler, which can run several times per stdin chunk.
  // The handler writes them; the render path must NOT re-sync them from state
  // (see useMirrorRefs). The setter wrappers below are the only writers.
  const mirrors = useMirrorRefs(React);

  const bodyRows = Math.max(1, (size.rows ?? 24) - 5);

  // Reported from an effect, NOT from render: debugLog appends to a file
  // synchronously, and a render can run many times per keystroke. Rendering
  // must stay free of side effects.
  useEffect(() => {
    if (session === undefined) {
      debugLog('no session for channel', {
        sessionId: channel?.sessionId,
        resolver: sessionResolver !== undefined,
      });
    }
  }, [session, channel?.sessionId]);

  useEffect(() => {
    debugLog('scene mounted', {
      sessionId: channel?.sessionId,
      hasSession: session !== undefined,
      targets: targets.length,
      columns: size.columns,
      rows: size.rows,
    });
  }, []);

  const choose = useCallback(index => {
    mirrors.selected.current = index;
    setSelected(index);
  }, []);

  const writeDraft = useCallback(text => {
    mirrors.draft.current = text;
    setDraft(text);
  }, []);

  const writeCaret = useCallback(at => {
    mirrors.caret.current = at;
    setCaret(at);
  }, []);

  const writeTargets = useCallback(found => {
    mirrors.targets.current = found;
    setTargets(found);
  }, []);

  /**
   * Leave the editor. The draft mirror IS the mode switch, so it clears here
   * too - a handler that runs again in the same chunk must already read "list".
   *
   * @param {string | ((current: string) => string)} [next] - status to show.
   */
  const leaveEdit = useCallback(next => {
    mirrors.draft.current = undefined;
    mirrors.caret.current = 0;
    setDraft(undefined);
    setCaret(0);
    if (next !== undefined) setStatus(next);
  }, []);

  // The scene can outlive the session it was opened on (a switch or a rewind);
  // re-enumerate rather than showing another session's rows.
  useEffect(() => {
    const found = collectTargets(session);
    writeTargets(found);
    choose(Math.max(0, Math.min(mirrors.selected.current, found.length - 1)));
    setScroll(0);
    debugLog('targets enumerated', { sessionId: channel?.sessionId, targets: found.length });
  }, [session, writeTargets, choose, mirrors]);

  /** Append the rewrite for the selected target. */
  const submit = useCallback(() => {
    const text = mirrors.draft.current;
    const target = mirrors.targets.current[mirrors.selected.current];
    if (text === undefined || target === undefined || session === undefined) return;
    if (text === target.original) {
      leaveEdit('unchanged — nothing appended');
      return;
    }
    // An emptied editor is not a rewrite. The projection would faithfully
    // produce an assistant message with an empty text block, which nothing
    // downstream asks for and `deriveEventMessage` would never produce on its
    // own for an original event - so refuse it here rather than hand the model
    // a message the plugin invented. Whitespace-only counts as emptied: a
    // reply of nothing but spaces is not text a user meant to send.
    if (text.trim().length === 0) {
      debugLog('empty rewrite refused', { targetSeq: target.seq });
      leaveEdit('empty text — nothing appended');
      return;
    }
    try {
      const event = session.append(REWRITE_EVENT_TYPE, { targetSeq: target.seq, content: text });
      debugLog('rewrite appended', { targetSeq: target.seq, eventSeq: event.seq, chars: units(text).length });
      leaveEdit('rewrote seq ' + target.seq + ' — the model sees the new text, the log keeps the original');
      writeTargets(collectTargets(session));
    } catch (error) {
      debugLog('append threw', { targetSeq: target.seq, error: String(error) });
      leaveEdit('append failed: ' + String(error).slice(0, 70));
    }
  }, [session, leaveEdit, writeTargets]);

  const beginEdit = useCallback(target => {
    if (target === undefined) return;
    writeCaret(units(target.original).length);
    writeDraft(target.original);
    setStatus('');
  }, [writeCaret, writeDraft]);

  useInput((input, key) => {
    // The draft mirror IS the mode switch: it is written by the same statement
    // that enters or leaves the editor, so a second key of the same chunk sees
    // the transition immediately. A separate "mode" mirror was a second account
    // of the same fact and could disagree with it.
    if (mirrors.draft.current !== undefined) {
      const chars = units(mirrors.draft.current ?? '');
      const cursor = Math.min(mirrors.caret.current, chars.length);
      const move = writeCaret;

      if (key.escape) { leaveEdit(current => (current === '' ? 'edit cancelled' : current)); return; }
      if (key.ctrl && input === 's') { submit(); return; }
      if (key.leftArrow) { move(Math.max(0, cursor - 1)); return; }
      if (key.rightArrow) { move(Math.min(chars.length, cursor + 1)); return; }
      if (key.upArrow) {
        const start = lineStartOf(chars, cursor);
        if (start === 0) { move(0); return; }
        const column = cursor - start;
        const prevStart = lineStartOf(chars, start - 1);
        move(Math.min(prevStart + column, start - 1));
        return;
      }
      if (key.downArrow) {
        const start = lineStartOf(chars, cursor);
        const column = cursor - start;
        let end = cursor;
        while (end < chars.length && chars[end] !== '\n') end += 1;
        if (end >= chars.length) { move(chars.length); return; }
        const nextStart = end + 1;
        let nextEnd = nextStart;
        while (nextEnd < chars.length && chars[nextEnd] !== '\n') nextEnd += 1;
        move(Math.min(nextStart + column, nextEnd));
        return;
      }
      if (key.return || input === '\n' || input === '\r') {
        writeDraft([...chars.slice(0, cursor), '\n', ...chars.slice(cursor)].join(''));
        move(cursor + 1);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        writeDraft([...chars.slice(0, cursor - 1), ...chars.slice(cursor)].join(''));
        move(cursor - 1);
        return;
      }
      if (key.ctrl || key.meta || key.super) return;
      if (input === undefined || input === '') return;
      // A paste arrives as ONE multi-character input; insert it whole, or the
      // rest of the pasted text is silently dropped.
      const pasted = units(input);
      writeDraft([...chars.slice(0, cursor), ...pasted, ...chars.slice(cursor)].join(''));
      move(cursor + pasted.length);
      return;
    }

    // list mode
    if (key.escape) { close(); return; }
    if (key.ctrl && input === 's') { beginEdit(mirrors.targets.current[mirrors.selected.current]); return; }
    if (mirrors.targets.current.length === 0) return;
    const step = delta => {
      choose(Math.max(0, Math.min(mirrors.targets.current.length - 1, mirrors.selected.current + delta)));
    };
    if (key.upArrow || input === 'k') step(-1);
    else if (key.downArrow || input === 'j') step(1);
    else if (key.return) beginEdit(mirrors.targets.current[mirrors.selected.current]);
  });

  // Keep the selected row inside the viewport.
  useEffect(() => {
    if (selected < scroll) setScroll(selected);
    else if (selected >= scroll + bodyRows) setScroll(selected - bodyRows + 1);
  }, [selected, scroll, bodyRows]);

  if (session === undefined) {
    // Reachable in three honest situations: the composition has no session
    // store, the bound channel is not backed by a live session yet (the
    // startup placeholder), or the id names a session this process does not
    // hold. All three are "nothing to rewrite" - the scene says so instead of
    // presenting an empty list that looks like a bug.
    return jsxs(Box, {
      flexDirection: 'column',
      children: [
        jsx(Text, { color: 'error', children: ' rewrite · no live session is bound to this UI' }),
        jsx(Text, { dimColor: true, children: ' session ' + String(channel?.sessionId ?? '(none)') }),
        jsx(Text, { dimColor: true, children: ' Esc to close' }),
      ],
    });
  }

  if (draft !== undefined) {
    const chars = units(draft);
    const caretAt = Math.min(caret, chars.length);
    const row = rowOf(chars, caretAt);
    const lines = draft.split('\n');
    const first = Math.max(0, Math.min(Math.max(0, lines.length - 1), row - Math.floor(EDIT_ROWS / 2)));
    const visible = lines.slice(first, first + EDIT_ROWS);
    const target = targets[selected];
    return jsxs(Box, {
      flexDirection: 'column',
      children: [
        jsx(Text, { bold: true, children: ' rewrite · editing seq ' + (target === undefined ? '?' : target.seq) + '  (line ' + (row + 1) + '/' + lines.length + ')' }),
        jsx(Text, { dimColor: true, children: ' Enter newline · Ctrl+S submit · Esc cancel' }),
        jsx(Box, {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'permission',
          paddingX: 1,
          height: EDIT_ROWS + 2,
          children: visible.map((line, offset) => {
            const absolute = first + offset;
            return jsx(Text, {
              key: 'line-' + absolute,
              ...(absolute === row ? { color: 'suggestion' } : {}),
              children: (absolute === row ? '▏' : ' ') + (line.length === 0 ? ' ' : line),
            });
          }),
        }),
        jsx(Text, { color: 'success', children: ' ' + status }),
      ],
    });
  }

  const visibleTargets = targets.slice(scroll, scroll + bodyRows);
  return jsxs(Box, {
    flexDirection: 'column',
    children: [
      jsx(Text, { bold: true, children: ' rewrite · ' + targets.length + ' assistant repl' + (targets.length === 1 ? 'y' : 'ies') + ' · session ' + String(channel?.sessionId ?? '').slice(0, 8) }),
      jsx(Text, { dimColor: true, children: ' ↑↓ / jk select · Enter edit · click a row · wheel scrolls · Ctrl+S edit · Esc close' }),
      jsx(Box, {
        flexDirection: 'column',
        flexGrow: 1,
        overflow: 'hidden',
        onWheel: event => {
          const delta = wheelRows(event.deltaY ?? 0, event.deltaX ?? 0);
          if (delta === 0) return;
          setScroll(current => Math.max(0, Math.min(Math.max(0, targets.length - bodyRows), current + delta)));
        },
        children: visibleTargets.length === 0
          ? [jsx(Text, { dimColor: true, children: ' (no assistant replies with text in this session yet)' })]
          : visibleTargets.map((target, offset) => {
            const index = scroll + offset;
            const isSelected = index === selected;
            return jsx(Box, {
              key: 'target-' + target.seq,
              flexDirection: 'column',
              flexShrink: 0,
              ...(isSelected ? { backgroundColor: 'selectionBg' } : {}),
              onClick: () => choose(index),
              children: jsx(Text, {
                bold: isSelected,
                ...(isSelected ? { color: 'suggestion' } : {}),
                children: (isSelected ? '❯ ' : '  ') + 'seq ' + target.seq + '  ' + target.preview,
              }),
            });
          }),
      }),
      jsx(Text, { color: status.startsWith('append failed') ? 'error' : 'success', children: ' ' + status }),
    ],
  });
}

/**
 * Enumerate the session's model-visible assistant messages.
 *
 * `surface.nodes` holds the message-producing event seqs in model order, and
 * `deriveMessages()` returns the messages in the same order — so index i of one
 * pairs with index i of the other. Projected (already rewritten) content is what
 * derives, which is what the model sees and therefore what the editor edits.
 *
 * @param {import('@deepseek-ai/dsh-session').Session | undefined} session
 * @returns {{seq: number, index: number, original: string, preview: string}[]}
 */
export function collectTargets(session) {
  if (session === undefined) return [];
  // A session from another kernel may not carry this shape; the enumeration is
  // the scene's only hard dependency on it, so it degrades to an empty list.
  const nodes = session.surface?.nodes;
  if (!Array.isArray(nodes)) {
    debugLog('session.surface.nodes is not an array', { got: typeof nodes });
    return [];
  }
  const found = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index];
    // Pair each node with its OWN event, through the public derives, rather than
    // zipping `surface.nodes` against `deriveMessages()`. deriveMessages appends
    // only non-null derivations, so the two arrays are index-aligned only while
    // every node yields a message - a property nothing guarantees.
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    let message;
    try {
      message = session.deriveEventMessage(event);
    } catch (error) {
      debugLog('deriveEventMessage threw', { seq, error: String(error) });
      continue;
    }
    if (message === null || message === undefined || message.role !== 'assistant') continue;
    const original = messageText(message);
    if (original.length === 0) continue;
    found.push({ seq, index, original, preview: previewOf(original) });
  }
  return found;
}

export default RewriteScene;