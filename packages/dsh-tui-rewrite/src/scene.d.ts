/**
 * Types for the full-screen scene.
 *
 * @module dsh-tui-rewrite/scene
 */
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes';
import type { Session } from '@deepseek-ai/dsh-session';

/** Scene id (kebab-case, per the tuiScenes grammar). */
export declare const SCENE_ID: 'dsh-tui-rewrite-scene';

/**
 * Publish the session lookup. Called once from the plugin's `apply`; swapping it
 * again is allowed so a test can drive the scene without a cordis context.
 */
export declare function setSessionResolver(resolve: ((sessionId: string) => unknown) | undefined): void;

/**
 * The live session the UI is bound to, or `undefined` when it cannot be reached.
 * A resolver that throws is contained: the scene must still render.
 */
export declare function sessionFor(sessionId: unknown): Session | undefined;

/** Code points, so astral characters edit as one unit. */
export declare function units(text: string): string[];

/** Display cells a code point occupies: 2 for the wide ranges, else 1. */
export declare function cellWidth(codePoint: number): number;

/** Clip to a display-cell budget (CJK-safe), with an ellipsis when clipped. */
export declare function clipCells(text: string, budget: number): string;

/** The message's own text, verbatim (what the editor starts from). */
export declare function messageText(message: unknown): string;

/** A one-line list preview: whitespace flattened, then clipped by display width. */
export declare function previewOf(text: string): string;

/** Index of the first unit of the line holding `cursor`. */
export declare function lineStartOf(chars: readonly string[], cursor: number): number;

/** Visual row of `cursor` (counting newlines, not wrapped lines). */
export declare function rowOf(chars: readonly string[], cursor: number): number;

/** Signed rows one wheel notch asks for; 0 for a horizontal-only event. */
export declare function wheelRows(deltaY: number, deltaX: number): number;

/** One assistant reply the scene can rewrite. */
export interface RewriteTarget {
  /** Seq of the surface node carrying this reply. */
  seq: number;
  /** Index of that node in `surface.nodes`. */
  index: number;
  /** The text the MODEL currently sees, which is what the editor starts from. */
  original: string;
  /** One-line, width-clipped preview. */
  preview: string;
}

/**
 * Enumerate the session's model-visible assistant messages that carry text.
 *
 * `surface.nodes` holds the message-producing event seqs in model order, and
 * each node is paired with its OWN event through the public derives rather than
 * by zipping against `deriveMessages()` - the two are index-aligned only while
 * every node yields a message, which nothing guarantees.
 *
 * Never throws: a session from another kernel degrades to an empty list.
 */
export declare function collectTargets(session: unknown): RewriteTarget[];

/**
 * Create the synchronous mirrors the input handler reads.
 *
 * One stable ref object per value the handler reads; the handler is their only
 * writer, because React commits state updates asynchronously and a mid-chunk
 * render would otherwise reset them to the previous state.
 */
export declare function useMirrorRefs(React: {
  useRef?: (initial: unknown) => { current: unknown };
  useMemo?: (factory: () => unknown, deps: unknown[]) => unknown;
}): {
  selected: { current: number };
  draft: { current: string | undefined };
  caret: { current: number };
  targets: { current: RewriteTarget[] };
};

/** The full-screen scene, rendered by the host with `TuiSceneProps`. */
export declare function RewriteScene(props: TuiSceneProps): unknown;

export default RewriteScene;
