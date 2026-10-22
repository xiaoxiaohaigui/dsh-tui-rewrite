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
 * Keys: arrows move, Enter edits, Esc backs out one layer, Ctrl+S submits,
 * Home/End go to the line bounds inside the editor. Clicking a row opens the
 * editor on that row; the wheel moves the selection.
 * Enter cannot submit: the editor needs it for newlines, and the host's rule is
 * that only an unmodified Enter commits a modal. Ctrl+S is therefore the submit
 * key. It is deliberately NOT a way into the editor: Ctrl+S means save, and a
 * list selection that opened on it would read as a different action.
 *
 * Hover is the ONE piece of view state that does not belong in the mirrors:
 * the mirrors exist for the input handler's decisions, and no key reads the
 * pointer. It is also the one piece the host will not clean up for us — its
 * hover diff skips detached nodes, so a row unmounted under the pointer never
 * gets its `onMouseLeave`. Holding the hovered row by its STABLE seq and
 * clearing it only when the departing row is still the current one makes the
 * result independent of enter/leave ordering inside one pointer move, and
 * leaves "no row hovered" as the honest state after a reflow.
 *
 * @module dsh-tui-rewrite/scene
 */
import { jsx, jsxs } from '@deepseek-harness-tui/dsh-tui/jsx-runtime';
import { REWRITE_RECORD_TYPE } from './persist.js';
import { debugLog } from './debug.js';
import { t } from './i18n.js';

/** Scene id (kebab-case, per the tuiScenes grammar). */
export const SCENE_ID = 'dsh-tui-rewrite-scene';

/** Cells before a rendered editor line's first text cell: border + padding + its leading space. */
const EDIT_TEXT_OFFSET = 3;
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

/**
 * How the scene commits a rewrite. Installed by main.js, which owns the cordis
 * context the persistence guard needs; `undefined` means "not wired" and the
 * default path appends the record event through the session (in-memory tests,
 * and the honest fallback when a composition has no persistence service).
 *
 * @type {((session: import('@deepseek-ai/dsh-session').Session, data: {targetSeq: number, content: string}) => unknown) | undefined}
 */
let rewriteSubmitter;

/**
 * Publish the rewrite write path. Called once from the plugin's `apply`;
 * swapping it again is allowed so a test can observe the submit.
 *
 * @param {((session: import('@deepseek-ai/dsh-session').Session, data: {targetSeq: number, content: string}) => unknown) | undefined} submit
 */
export function setRewriteSubmitter(submit) {
  rewriteSubmitter = submit;
}

/** The one write path the scene uses, with the no-context fallback. */
function writeRewrite(session, data) {
  if (rewriteSubmitter !== undefined) return rewriteSubmitter(session, data);
  return session.append(REWRITE_RECORD_TYPE, data);
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

/**
 * Index of the line's terminator (or of the last unit when it is the last
 * line), i.e. the cursor position Home/End and Up/Down share. That sharing is
 * the point: End then Down lands in the SAME column as Up/Down would, instead
 * of one column short.
 */
export function lineEndOf(chars, cursor) {
  let i = Math.max(0, Math.min(cursor, chars.length));
  while (i < chars.length && chars[i] !== '\n') i += 1;
  return i;
}

/** Visual row of `cursor` (counting newlines, not wrapped lines). */
export function rowOf(chars, cursor) {
  let row = 0;
  for (let i = 0; i < cursor; i += 1) if (chars[i] === '\n') row += 1;
  return row;
}

/**
 * Caret index a click at display column `visualColumn` targets.
 *
 * Columns are display cells, not code points: a CJK character or an emoji
 * spans two cells, and clicking either half lands on the nearest boundary
 * (left half before it, right half after it). A column past the line end clamps
 * to the end, so clicking the blank area right of the text continues typing
 * where it visually appears to.
 *
 * The rendered line has one leading space that is not part of `chars`; callers
 * subtract it (and the border/padding) from the event column before calling.
 */
export function caretAtVisualColumn(chars, visualColumn) {
  if (!Number.isFinite(visualColumn) || visualColumn <= 0) return 0;
  let cells = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const width = cellWidth(chars[i].codePointAt(0));
    if (visualColumn < cells + width) {
      return visualColumn - cells >= width / 2 ? i + 1 : i;
    }
    cells += width;
  }
  return chars.length;
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
  // The host's deployment language wins for the scene copy when it sets one;
  // otherwise t() follows DSH_TUI_LANG / ~/.dsh-tui/lang.json / OS locale.
  const tr = (key, params) => t(key, params, channel?.configuredLang);

  const [targets, setTargets] = useState(() => collectTargets(session));
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0);
  // Top line of the editor viewport. Kept apart from the caret so the wheel can
  // look around without moving the insertion point (see the follow effect).
  const [editTop, setEditTop] = useState(0);
  const [draft, setDraft] = useState(undefined);
  const [status, setStatus] = useState('');
  const [caret, setCaret] = useState(0);
  // Component-local per PLAN 1b, keyed by the row's stable seq (never a row
  // index: the index changes under the pointer whenever the list scrolls).
  const [hoverSeq, setHoverSeq] = useState(undefined);

  // Mirrors for the input handler, which can run several times per stdin chunk.
  // The handler writes them; the render path must NOT re-sync them from state
  // (see useMirrorRefs). The setter wrappers below are the only writers.
  const mirrors = useMirrorRefs(React);

  const terminalRows = Math.max(6, size.rows ?? 24);
  const bodyRows = Math.max(1, terminalRows - 5);
  // Title + hint + status take three rows; the bordered box adds its two border
  // rows on top of the text rows. Filling the terminal is what makes the editor
  // usable for long replies instead of a four-row slit.
  const editRows = Math.max(1, terminalRows - 5);

  // The editor caret must not consume a text cell: inserting a ▏ glyph shifts
  // every character to its right, which is what made the editor look like it
  // was "making room" while the caret moved. Prefer the host's declared native
  // cursor (the same mechanism the prompt input uses); fall back to the painted
  // glyph only for hosts without that hook.
  const useDeclaredCursor = ui.useDeclaredCursor;
  const useNativeCursor = ui.useNativeCursor;
  const nativeCursor = typeof useNativeCursor === 'function' ? useNativeCursor() : false;
  const draftChars = draft === undefined ? [] : units(draft);
  const draftCaret = Math.min(caret, draftChars.length);
  const draftRow = draft === undefined ? 0 : rowOf(draftChars, draftCaret);
  const draftLines = draft === undefined ? [] : draft.split('\n');
  const maxEditTop = draft === undefined ? 0 : Math.max(0, draftLines.length - editRows);
  const draftFirst = draft === undefined ? 0 : Math.max(0, Math.min(editTop, maxEditTop));
  // Code-point offset where each rendered line starts. Click mapping needs the
  // line's start, not a linear scan to it on every render.
  const draftLineStarts = [];
  if (draft !== undefined) {
    let start = 0;
    for (const line of draftLines) {
      draftLineStarts.push(start);
      start += units(line).length + 1;
    }
  }
  const draftLineStart = draft === undefined ? 0 : lineStartOf(draftChars, draftCaret);
  const draftColumn = draftCaret - draftLineStart;
  const draftLineChars = draft === undefined ? [] : units(draftLines[draftRow] ?? '');
  let draftVisualColumn = 1; // the leading space is part of the rendered line
  for (let i = 0; i < Math.min(draftColumn, draftLineChars.length); i += 1) {
    draftVisualColumn += cellWidth(draftLineChars[i].codePointAt(0));
  }
  const cursorRef = typeof useDeclaredCursor === 'function'
    ? useDeclaredCursor({
      line: 0,
      column: draftVisualColumn,
      active: draft !== undefined,
      visible: nativeCursor,
    })
    : undefined;
  const paintedCaret = cursorRef === undefined || !nativeCursor;

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
      leaveEdit(tr('edit-unchanged'));
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
      leaveEdit(tr('edit-empty'));
      return;
    }
    try {
      const event = writeRewrite(session, { targetSeq: target.seq, content: text });
      const eventSeq = event?.seq;
      debugLog('rewrite appended', { targetSeq: target.seq, eventSeq, chars: units(text).length });
      leaveEdit(tr('edit-rewritten', { seq: target.seq }));
      writeTargets(collectTargets(session));
    } catch (error) {
      debugLog('append threw', { targetSeq: target.seq, error: String(error) });
      leaveEdit(tr('edit-append-failed', { error: String(error).slice(0, 70) }));
    }
  }, [session, leaveEdit, writeTargets]);

  const beginEdit = useCallback(target => {
    if (target === undefined) return;
    const chars = units(target.original);
    const at = chars.length;
    const lines = target.original.split('\n');
    const max = Math.max(0, lines.length - editRows);
    writeCaret(at);
    writeDraft(target.original);
    // Start with the caret centred rather than at the very bottom: the last
    // lines of a long reply are usually the interesting ones, and the user can
    // still wheel or arrow from there.
    setEditTop(Math.max(0, Math.min(max, rowOf(chars, at) - Math.floor(editRows / 2))));
    setStatus('');
  }, [writeCaret, writeDraft, editRows]);

  useInput((input, key) => {
    // The draft mirror IS the mode switch: it is written by the same statement
    // that enters or leaves the editor, so a second key of the same chunk sees
    // the transition immediately. A separate "mode" mirror was a second account
    // of the same fact and could disagree with it.
    if (mirrors.draft.current !== undefined) {
      const chars = units(mirrors.draft.current ?? '');
      const cursor = Math.min(mirrors.caret.current, chars.length);
      const move = writeCaret;

      if (key.escape) { leaveEdit(current => (current === '' ? tr('edit-cancelled') : current)); return; }
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
      // Home/End move within the LINE, not the buffer: the editor is a
      // multi-line one and the host names the keys `key.home`/`key.end`.
      // They land on the line's terminator, which is the cursor position
      // Up/Down already clamp to, so End then Down moves straight down.
      if (key.home) { move(lineStartOf(chars, cursor)); return; }
      if (key.end) { move(lineEndOf(chars, cursor)); return; }
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
    if (mirrors.targets.current.length === 0) return;
    const step = delta => {
      choose(Math.max(0, Math.min(mirrors.targets.current.length - 1, mirrors.selected.current + delta)));
    };
    // Arrows and Enter only. Typing in the list must not act: `j`/`k` used to
    // move the selection, and Ctrl+S used to open the editor, but both made the
    // list respond to letters that mean something else everywhere else.
    if (key.upArrow) step(-1);
    else if (key.downArrow) step(1);
    else if (key.return) beginEdit(mirrors.targets.current[mirrors.selected.current]);
  });

  // Keep the selected row inside the viewport.
  useEffect(() => {
    if (selected < scroll) setScroll(selected);
    else if (selected >= scroll + bodyRows) setScroll(selected - bodyRows + 1);
  }, [selected, scroll, bodyRows]);

  // Keep the caret inside the editor viewport while it moves (typing, arrows,
  // a click). Deliberately NOT keyed on editTop: the wheel changes only
  // editTop, and the effect must not snap the view straight back to the caret.
  useEffect(() => {
    if (draft === undefined) return;
    setEditTop(top => {
      const max = Math.max(0, draftLines.length - editRows);
      let next = Math.max(0, Math.min(top, max));
      if (draftRow < next) next = draftRow;
      else if (draftRow >= next + editRows) next = Math.min(max, draftRow - editRows + 1);
      return next;
    });
  }, [draft, draftRow, editRows, draftLines.length]);

  if (session === undefined) {
    // Reachable in three honest situations: the composition has no session
    // store, the bound channel is not backed by a live session yet (the
    // startup placeholder), or the id names a session this process does not
    // hold. All three are "nothing to rewrite" - the scene says so instead of
    // presenting an empty list that looks like a bug.
    return jsxs(Box, {
      flexDirection: 'column',
      children: [
        jsx(Text, { color: 'error', children: tr('scene-no-session') }),
        jsx(Text, { dimColor: true, children: tr('scene-session', { id: String(channel?.sessionId ?? '(none)') }) }),
        jsx(Text, { dimColor: true, children: tr('scene-esc-close') }),
      ],
    });
  }

  if (draft !== undefined) {
    const row = draftRow;
    const column = draftColumn;
    const lines = draftLines;
    const first = draftFirst;
    const visible = lines.slice(first, first + editRows);
    const target = targets[selected];
    return jsxs(Box, {
      flexDirection: 'column',
      height: terminalRows,
      // The wheel moves the VIEWPORT, not the caret: looking around must not
      // change what Ctrl+S would submit.
      onWheel: event => {
        const delta = wheelRows(event.deltaY ?? 0, event.deltaX ?? 0);
        if (delta === 0 || maxEditTop === 0) return;
        setEditTop(top => Math.max(0, Math.min(maxEditTop, top + delta)));
      },
      children: [
        jsx(Text, { bold: true, children: tr('edit-title', { seq: target === undefined ? '?' : target.seq, line: row + 1, lines: lines.length, col: column + 1 }) }),
        jsx(Text, { dimColor: true, children: tr('edit-hint') }),
        jsx(Box, {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'permission',
          paddingX: 1,
          height: editRows + 2,
          onClick: event => {
            // localRow/localCol are relative to THIS box, borders included:
            // row 0 is the top border, the text starts after border + padding
            // and the one leading space every painted line carries.
            const innerRow = event.localRow - 1;
            const innerColumn = event.localCol - EDIT_TEXT_OFFSET;
            if (innerRow < 0 || innerRow >= editRows || innerColumn < 0) return;
            const lineIndex = first + innerRow;
            // Below the last line: the end of the buffer is where clicking the
            // blank tail of an editor usually puts the caret.
            if (lineIndex >= lines.length) {
              writeCaret(draftChars.length);
              return;
            }
            writeCaret(
              draftLineStarts[lineIndex]
              + caretAtVisualColumn(units(lines[lineIndex]), innerColumn),
            );
          },
          children: visible.map((line, offset) => {
            const absolute = first + offset;
            if (absolute === row) {
              if (paintedCaret) {
                // Host without a declared native cursor: keep the caret visible,
                // accepting the one-cell shift (the pre-2026-10-22 behaviour).
                const lineChars = units(line);
                const before = lineChars.slice(0, column).join('');
                const after = lineChars.slice(column).join('');
                return jsx(Text, {
                  key: 'line-' + absolute,
                  color: 'suggestion',
                  children: ' ' + before + '▏' + after,
                });
              }
              return jsx(Text, {
                key: 'line-' + absolute,
                ref: cursorRef,
                color: 'suggestion',
                // The trailing blank is the cell the native cursor parks on at EOL.
                children: ' ' + (line.length === 0 ? ' ' : line) + ' ',
              });
            }
            return jsx(Text, {
              key: 'line-' + absolute,
              children: ' ' + (line.length === 0 ? ' ' : line),
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
      jsx(Text, { bold: true, children: tr(targets.length === 1 ? 'scene-title-one' : 'scene-title', { count: targets.length, id: String(channel?.sessionId ?? '').slice(0, 8) }) }),
      jsx(Text, { dimColor: true, children: tr('scene-hint') }),
      jsx(Box, {
        flexDirection: 'column',
        flexGrow: 1,
        overflow: 'hidden',
        // The wheel moves the SELECTION, and the viewport follows it through
        // the effect above. Scrolling the camera on its own was a second driver
        // of the same state: the follow effect immediately recentres the
        // selection, so a wheel notch scrolled nowhere the moment the selected
        // row was off screen. One driver, one scroll position.
        onWheel: event => {
          const delta = wheelRows(event.deltaY ?? 0, event.deltaX ?? 0);
          if (delta === 0) return;
          choose(Math.max(0, Math.min(targets.length - 1, mirrors.selected.current + delta)));
        },
        children: visibleTargets.length === 0
          ? [jsx(Text, { dimColor: true, children: tr('scene-empty') })]
          : visibleTargets.map((target, offset) => {
            const index = scroll + offset;
            const isSelected = index === selected;
            const isHovered = target.seq === hoverSeq;
            return jsx(Box, {
              key: 'target-' + target.seq,
              flexDirection: 'column',
              flexShrink: 0,
              // Selection wins: it is the row Enter acts on.
              ...(isSelected ? { backgroundColor: 'selectionBg' }
                : isHovered ? { backgroundColor: 'userMessageBackgroundHover' } : {}),
              onClick: () => {
                // A click selects AND edits: the pointer should not need a
                // second Enter after the row is already under it.
                choose(index);
                beginEdit(target);
              },
              onMouseEnter: () => setHoverSeq(target.seq),
              // Only retract the hover if this row is still the hovered one: a
              // leave and an enter of the same pointer move land in ONE React
              // batch, and a leave that cleared unconditionally would blank the
              // row the pointer just moved onto.
              onMouseLeave: () => setHoverSeq(current => (current === target.seq ? undefined : current)),
              children: jsx(Text, {
                bold: isSelected,
                ...(isSelected ? { color: 'suggestion' } : {}),
                children: (isSelected ? '❯ ' : '  ') + 'seq ' + target.seq + '  ' + target.preview,
              }),
            });
          }),
      }),
      jsx(Text, { color: status.startsWith(tr('edit-append-failed', { error: '' })) ? 'error' : 'success', children: ' ' + status }),
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