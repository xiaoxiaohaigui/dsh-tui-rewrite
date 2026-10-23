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
/** Undo depth, snapshot budget and the idle window that folds a typing run. */
const UNDO_LIMIT = 100;
const UNDO_MAX_CHARS = 1_000_000;
const UNDO_IDLE_MS = 700;
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
 * Break one logical line into display rows of at most `width` cells.
 *
 * Word-aware, like the host's prompt editor: prefer the last space, and hard-
 * break a word that cannot fit. Ranges are code-point offsets into `chars`.
 * A wide character is never split; `width` is clamped to 2 by the caller so a
 * two-cell glyph always fits on a row of its own.
 *
 * The trailing space of a word break stays on the earlier row, which is also
 * where a caret at the break sits (the same rule the prompt editor uses).
 */
export function wrapEditorLine(chars, width) {
  if (chars.length === 0) return [{ start: 0, end: 0 }];
  const rows = [];
  let rowStart = 0;
  let rowWidth = 0;
  let lastBreak = -1;
  for (let i = 0; i < chars.length; i += 1) {
    const cell = cellWidth(chars[i].codePointAt(0));
    while (rowWidth + cell > width && i > rowStart) {
      if (lastBreak > rowStart) {
        rows.push({ start: rowStart, end: lastBreak });
        rowStart = lastBreak;
        rowWidth = 0;
        for (let j = rowStart; j < i; j += 1) rowWidth += cellWidth(chars[j].codePointAt(0));
        lastBreak = -1;
      } else {
        rows.push({ start: rowStart, end: i });
        rowStart = i;
        rowWidth = 0;
        lastBreak = -1;
      }
    }
    rowWidth += cell;
    if (chars[i] === ' ') lastBreak = i + 1;
  }
  rows.push({ start: rowStart, end: chars.length });
  return rows;
}

/**
 * Lay a whole draft out as display rows. Offsets (`start`/`end`) are code-point
 * positions in `text`, so a click or caret can be mapped in either direction.
 * Empty text still yields one row, so an empty editor has a caret cell.
 */
export function layoutEditorRows(text, width) {
  const rows = [];
  let base = 0;
  for (const line of text.split('\n')) {
    const chars = units(line);
    for (const row of wrapEditorLine(chars, width)) {
      rows.push({
        start: base + row.start,
        end: base + row.end,
        text: chars.slice(row.start, row.end).join(''),
      });
    }
    base += chars.length + 1;
  }
  return rows;
}

/**
 * Index of the display row holding `caret`, or the last row.
 *
 * A soft-wrap boundary belongs to two rows on paper (the end of one and the
 * start of the next). By default the caret stays on the earlier row, which is
 * the host's rule; `hint` overrides that for a move that deliberately aimed at
 * one row (vertical navigation, a click), so Up from a blank line lands on the
 * LAST row of the previous paragraph instead of its first row.
 */
export function visualRowOfCaret(rows, caret, hint) {
  if (hint !== undefined && hint >= 0 && hint < rows.length) {
    const row = rows[hint];
    if (caret >= row.start && caret <= row.end) return hint;
  }
  for (let i = 0; i < rows.length; i += 1) if (caret <= rows[i].end) return i;
  return Math.max(0, rows.length - 1);
}

/** Display cells from the start of display row `index` to `caret`. */
export function visualColumnOfCaret(chars, rows, index, caret) {
  const row = rows[index] ?? { start: 0, end: 0 };
  let cells = 0;
  const stop = Math.max(row.start, Math.min(caret, row.end));
  for (let i = row.start; i < stop; i += 1) cells += cellWidth(chars[i].codePointAt(0));
  return cells;
}

/**
 * Caret offset one display row above (`delta < 0`) or below (`delta > 0`),
 * keeping the visual column. This is what makes Up/Down walk the SOFT-WRAPPED
 * rows of a long sentence instead of jumping over the whole logical line.
 * Above the first row the caret goes to the buffer start; below the last row,
 * to its end.
 */
export function verticalCaretTarget(rows, chars, caret, delta, hint) {
  const index = visualRowOfCaret(rows, caret, hint);
  const column = visualColumnOfCaret(chars, rows, index, caret);
  const target = index + delta;
  if (target < 0) return 0;
  if (target >= rows.length) return chars.length;
  const row = rows[target];
  return row.start + caretAtVisualColumn(units(row.text), column);
}

/**
 * Whether the caret seam in `text` is a word boundary (used to end an undo
 * typing run). Cheap approximation of the host's ICU rule: edges, whitespace,
 * punctuation, script/CJK changes and digit/letter changes break a word.
 */
function wordBoundaryAt(text, offset) {
  const chars = units(text);
  if (offset <= 0 || offset >= chars.length) return true;
  const left = chars[offset - 1];
  const right = chars[offset];
  const word = /[\p{L}\p{N}]/u;
  if (!word.test(left) || !word.test(right)) return true;
  if (/\s/u.test(left) || /\s/u.test(right)) return true;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  if (cjk.test(left) || cjk.test(right)) return true;
  const digit = /\p{N}/u;
  if (digit.test(left) !== digit.test(right)) return true;
  // Any script other than Latin ends the run at every character; for Latin,
  // letters (including accents) keep folding into the same word.
  const latin = /\p{Script=Latin}/u;
  return !latin.test(left) || !latin.test(right);
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
    // Display row the caret was last deliberately placed on. Only consulted
    // at a soft-wrap boundary, where an offset belongs to two rows.
    caretHint: { current: undefined },
    // Draft-scoped undo stack, in snapshot-before-edit form. `group` is the
    // currently open typing/deletion run, so a word folds into one Ctrl+Z.
    undo: { current: { stack: [], group: null } },
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
  const terminalColumns = Math.max(8, size.columns ?? 80);
  const bodyRows = Math.max(1, terminalRows - 5);
  // Title + hint + status take three rows; the bordered box adds its two border
  // rows on top of the text rows. Filling the terminal is what makes the editor
  // usable for long replies instead of a four-row slit.
  const editRows = Math.max(1, terminalRows - 5);
  // Display cells available inside one painted line: the box's two borders, its
  // two padding cells and the line's leading space are not text. One more cell
  // is reserved on every row so the caret's trailing blank fits at EOL.
  const editorTextWidth = Math.max(2, terminalColumns - 6);

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
  // The editor renders DISPLAY rows (soft-wrapped at the box width), not
  // logical lines: a long reply is one logical line but many screen rows. The
  // viewport, the wheel, the caret and click mapping all speak display rows.
  const editorRows = draft === undefined ? [] : layoutEditorRows(draft, editorTextWidth);
  const maxEditTop = draft === undefined ? 0 : Math.max(0, editorRows.length - editRows);
  const draftFirst = draft === undefined ? 0 : Math.max(0, Math.min(editTop, maxEditTop));
  const draftLineStart = draft === undefined ? 0 : lineStartOf(draftChars, draftCaret);
  const draftColumn = draftCaret - draftLineStart;
  const caretRowIndex = draft === undefined
    ? 0
    : visualRowOfCaret(editorRows, draftCaret, mirrors.caretHint.current);
  const caretVisualColumn = 1 + (draft === undefined
    ? 0
    : visualColumnOfCaret(draftChars, editorRows, caretRowIndex, draftCaret));
  const cursorRef = typeof useDeclaredCursor === 'function'
    ? useDeclaredCursor({
      line: 0,
      column: caretVisualColumn,
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
    // Any ordinary caret move drops the old row affinity; the operations that
    // mean a specific display row (click, vertical move) set it again after
    // this call.
    mirrors.caretHint.current = undefined;
    setCaret(at);
  }, []);

  const writeTargets = useCallback(found => {
    mirrors.targets.current = found;
    setTargets(found);
  }, []);

  /**
   * Apply one text mutation, recording an undo snapshot first.
   *
   * A run folds into the previous step when the same direction continues at
   * the same caret within {@link UNDO_IDLE_MS}, and - for an insertion - the
   * seam stays inside a word. That is the host prompt editor's word-level
   * granularity: Ctrl+Z drops "world", not the whole sentence and not one
   * keystroke. A newline or a paste always starts a sealed step.
   */
  const recordEdit = useCallback((next, nextCaret, kind) => {
    const before = mirrors.draft.current ?? '';
    const beforeCaret = mirrors.caret.current ?? 0;
    const store = mirrors.undo.current;
    const at = Date.now();
    const last = store.group;
    const continues = last !== null
      && last.kind === kind
      && at - last.atMs <= UNDO_IDLE_MS
      && last.caretAfter === beforeCaret;
    const fold = kind === 'insert'
      ? continues && !wordBoundaryAt(next, beforeCaret)
      : (kind === 'backspace' || kind === 'delete') && continues;
    if (!fold) {
      store.stack.push({ text: before, caret: beforeCaret });
      while (store.stack.length > UNDO_LIMIT) store.stack.shift();
      // Memory guard: a few huge drafts must not pin tens of megabytes.
      let chars = store.stack.reduce((total, entry) => total + entry.text.length, 0);
      while (chars > UNDO_MAX_CHARS && store.stack.length > 1) {
        chars -= store.stack.shift().text.length;
      }
    }
    store.group = { kind, caretAfter: nextCaret, atMs: at };
    writeDraft(next);
    writeCaret(nextCaret);
  }, [mirrors, writeDraft, writeCaret]);

  /** Ctrl+Z: restore the state before the current undo step. Empty = no-op. */
  const undoEdit = useCallback(() => {
    const store = mirrors.undo.current;
    const entry = store.stack.pop();
    if (entry === undefined) return;
    // The restored state starts a fresh run: the next keystroke must not fold
    // into the step that was just undone.
    store.group = null;
    writeDraft(entry.text);
    writeCaret(entry.caret);
    setStatus('');
  }, [mirrors, writeDraft, writeCaret]);

  /**
   * Leave the editor. The draft mirror IS the mode switch, so it clears here
   * too - a handler that runs again in the same chunk must already read "list".
   *
   * @param {string | ((current: string) => string)} [next] - status to show.
   */
  const leaveEdit = useCallback(next => {
    mirrors.draft.current = undefined;
    mirrors.caret.current = 0;
    mirrors.caretHint.current = undefined;
    // The undo stack belongs to this edit session; a later message must not
    // restore this one's text.
    mirrors.undo.current = { stack: [], group: null };
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
    const rows = layoutEditorRows(target.original, editorTextWidth);
    const max = Math.max(0, rows.length - editRows);
    mirrors.undo.current = { stack: [], group: null };
    writeCaret(at);
    writeDraft(target.original);
    // Start with the caret centred rather than at the very bottom: the last
    // rows of a long reply are usually the interesting ones, and the user can
    // still wheel or arrow from there.
    const caretRow = visualRowOfCaret(rows, at);
    setEditTop(Math.max(0, Math.min(max, caretRow - Math.floor(editRows / 2))));
    setStatus('');
  }, [writeCaret, writeDraft, editRows, editorTextWidth]);

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
      if (key.ctrl && !key.shift && typeof input === 'string' && input.toLowerCase() === 'z') {
        undoEdit();
        return;
      }
      if (key.ctrl && input === 's') { submit(); return; }
      if (key.leftArrow) { move(Math.max(0, cursor - 1)); return; }
      if (key.rightArrow) { move(Math.min(chars.length, cursor + 1)); return; }
      // Up/Down walk DISPLAY rows, not logical lines: in a soft-wrapped
      // sentence one press moves one visual line and keeps the column, which
      // is what every other editor does. Home/End stay on the logical line.
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        const rows = layoutEditorRows(mirrors.draft.current ?? '', editorTextWidth);
        const hint = mirrors.caretHint.current;
        const index = visualRowOfCaret(rows, cursor, hint);
        // `move` clears the affinity; aim at the target row explicitly so a
        // soft-wrap boundary displays on the row the move asked for.
        move(verticalCaretTarget(rows, chars, cursor, delta, hint));
        mirrors.caretHint.current = Math.max(0, Math.min(rows.length - 1, index + delta));
        return;
      }
      // Home/End move within the LINE, not the buffer: the editor is a
      // multi-line one and the host names the keys `key.home`/`key.end`.
      if (key.home) { move(lineStartOf(chars, cursor)); return; }
      if (key.end) { move(lineEndOf(chars, cursor)); return; }
      if (key.return || input === '\n' || input === '\r') {
        recordEdit([...chars.slice(0, cursor), '\n', ...chars.slice(cursor)].join(''), cursor + 1, 'newline');
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        recordEdit(
          [...chars.slice(0, cursor - 1), ...chars.slice(cursor)].join(''),
          cursor - 1,
          key.backspace ? 'backspace' : 'delete',
        );
        return;
      }
      if (key.ctrl || key.meta || key.super) return;
      if (input === undefined || input === '') return;
      // A paste arrives as ONE multi-character input; insert it whole, or the
      // rest of the pasted text is silently dropped. A single character is
      // ordinary typing, so it may fold into the current word's undo step.
      const pasted = units(input);
      recordEdit(
        [...chars.slice(0, cursor), ...pasted, ...chars.slice(cursor)].join(''),
        cursor + pasted.length,
        pasted.length > 1 ? 'paste' : 'insert',
      );
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
      const max = Math.max(0, editorRows.length - editRows);
      let next = Math.max(0, Math.min(top, max));
      if (caretRowIndex < next) next = caretRowIndex;
      else if (caretRowIndex >= next + editRows) next = Math.min(max, caretRowIndex - editRows + 1);
      return next;
    });
  }, [draft, caret, caretRowIndex, editRows, editorRows.length]);

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
    const visible = editorRows.slice(first, first + editRows);
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
            const visualIndex = first + innerRow;
            // Below the last display row: the end of the buffer is where
            // clicking the blank tail of an editor usually puts the caret.
            if (visualIndex >= editorRows.length) {
              writeCaret(draftChars.length);
              return;
            }
            const clicked = editorRows[visualIndex];
            writeCaret(
              clicked.start
              + caretAtVisualColumn(units(clicked.text), innerColumn),
            );
            // A click names its display row; keep the caret there even when the
            // click landed on a soft-wrap boundary.
            mirrors.caretHint.current = visualIndex;
          },
          children: visible.map((editorRow, offset) => {
            const absolute = first + offset;
            const painted = editorRow.text.length === 0 ? ' ' : editorRow.text;
            if (absolute === caretRowIndex) {
              if (paintedCaret) {
                // Host without a declared native cursor: keep the caret visible,
                // accepting the one-cell shift (the pre-2026-10-22 behaviour).
                const rowChars = units(editorRow.text);
                const local = Math.max(0, Math.min(draftCaret - editorRow.start, rowChars.length));
                const before = rowChars.slice(0, local).join('');
                const after = rowChars.slice(local).join('');
                return jsx(Text, {
                  key: 'line-' + absolute,
                  wrap: 'truncate-end',
                  color: 'suggestion',
                  children: ' ' + before + '▏' + after,
                });
              }
              return jsx(Text, {
                key: 'line-' + absolute,
                ref: cursorRef,
                wrap: 'truncate-end',
                color: 'suggestion',
                // The trailing blank is the cell the native cursor parks on at EOL.
                children: ' ' + painted + ' ',
              });
            }
            return jsx(Text, {
              key: 'line-' + absolute,
              wrap: 'truncate-end',
              children: ' ' + painted,
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