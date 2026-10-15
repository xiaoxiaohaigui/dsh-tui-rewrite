/**
 * Shared harness utilities: session loading and the assertion vocabulary the
 * verification suites share.
 *
 * Session artifacts are CONCATENATED zstd frames, not one frame - the Node zstd
 * stream and a single-shot decompress both stop after the first frame, which
 * looks exactly like "this session has one event". The magic-scan below is the
 * only way to decode a real log without the (non-exported) official helper.
 *
 * @module dsh-tui-rewrite-test/tools
 */
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';

const settle = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * The default sample session: a real, mid-size log from this machine.
 * Override with DSH_REWRITE_SAMPLE when it moves.
 */
export const DEFAULT_SAMPLE = 'C:/Users/86198/.dsh/sessions/--D-dsh-tui-theme--/74b50eef-dad8-4731-b8cb-f85cafac74ce/session.v4.jsonl.zstd';

/** Resolve the sample path, failing loudly with the override hint. */
export function samplePath(explicit) {
  const path = explicit ?? process.env.DSH_REWRITE_SAMPLE ?? DEFAULT_SAMPLE;
  if (!existsSync(path)) {
    throw new Error('sample session not found: ' + path
      + '\n  set DSH_REWRITE_SAMPLE=<path to a session.v4.jsonl.zstd>');
  }
  return path;
}

/**
 * Split a concatenated-frame zstd container and decode every JSONL frame.
 * Frames whose decompressed text does not start with '{' are false magic hits
 * inside compressed data and are skipped.
 *
 * @param {Buffer} buffer
 * @returns {string} the joined JSONL text of every real frame.
 */
export function decodeFrames(buffer) {
  const starts = [];
  let cursor = 0;
  for (;;) {
    const at = buffer.indexOf(ZSTD_MAGIC, cursor);
    if (at < 0) break;
    starts.push(at);
    cursor = at + 4;
  }
  const parts = [];
  for (const offset of starts) {
    let plain;
    try {
      plain = zstdDecompressSync(buffer.subarray(offset));
    } catch {
      continue;
    }
    const text = plain.toString('utf8');
    if (!text.startsWith('{')) continue;
    parts.push(text);
  }
  return parts.join('');
}

/**
 * Load one session artifact.
 *
 * The first record is the session HEADER (type 'session', carries version/id/cwd)
 * and has NO seq; foldSurface and Session.create both want sequenced events
 * starting at 0, so it is separated out.
 *
 * @param {string} [path] - artifact path; defaults to the sample.
 * @returns {{header: Record<string, unknown>, events: Record<string, unknown>[]}}
 */
export function loadSampleSession(path) {
  const records = decodeFrames(readFileSync(samplePath(path)))
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  const header = records.find(record => record.type === 'session' && record.version !== undefined);
  if (header === undefined) throw new Error('session header record not found');
  return { header, events: records.filter(record => record !== header) };
}

/** Structured check results, so a suite can report every assertion at once. */
export class Checks {
  constructor() {
    this.results = [];
  }

  /** Record one assertion. `detail` is shown whether it passes or fails. */
  check(name, ok, detail) {
    this.results.push({ name, ok: ok === true, detail: detail === undefined ? '' : String(detail) });
    return ok === true;
  }

  /** Assert two JSON values are byte-identical in serialized form. */
  equal(name, actual, expected) {
    return this.check(name, JSON.stringify(actual) === JSON.stringify(expected));
  }

  get failed() {
    return this.results.filter(result => !result.ok);
  }

  /** Print every result and return the failure count. */
  report() {
    for (const result of this.results) {
      process.stdout.write((result.ok ? 'PASS  ' : 'FAIL  ') + result.name + (result.detail ? '\n        ' + result.detail : '') + '\n');
    }
    const failed = this.failed.length;
    process.stdout.write('\nRESULT ' + (failed === 0 ? 'all-pass' : failed + '-failed') + ' (' + this.results.length + ' checks)\n');
    return failed;
  }
}

/** Collapse an unknown thrown value into one readable line. */
export function brief(error, max = 190) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/gu, ' ').slice(0, max);
}

/** The text parts of a derived message, joined. */
export function textOf(message) {
  return (message?.content ?? [])
    .filter(part => part !== null && typeof part === 'object' && part.type === 'text')
    .map(part => part.text)
    .join(' ');
}
// ---------------------------------------------------------------------------
// Synthetic sessions
//
// The scene's data source is a live Session, so its tests build REAL sessions
// through a real SessionStore rather than hand-rolled shape doubles - a double
// would drift from the surface semantics dsh-session actually implements.
// ---------------------------------------------------------------------------

/** Storage dir for synthetic sessions; they are never persisted. */
export function sessionOptions(cwd = 'C:/dsh-tui-rewrite-test') {
  return { meta: { cwd }, storage: { localDir: join(tmpdir(), 'dsh-tui-rewrite-harness', 'sessions') } };
}

/**
 * Build a real live session from explicit events.
 *
 * @param {Record<string, unknown>[]} specs - events; `seq`/`time` are filled in.
 * @param {{id?: string}} [options]
 * @returns {Promise<{ session: object, store: object, root: object, dispose: () => Promise<void> }>}
 */
export async function openSession(specs = [], options = {}) {
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  // A rewrite only lands if the projection is registered BEFORE the session is
  // built: a session folds its seed once, at creation, and there is no re-fold.
  if (options.plugin === true) {
    const { createPlugin } = await import('dsh-tui-rewrite');
    // A composition without a tuiScenes seam starts the late-mount poll; on the
    // production budget that poll would hold the test process open for minutes.
    root.plugin(createPlugin({ timers: { budgetMs: 200 } }));
    await settle();
  }
  const events = specs.map((spec, seq) => ({ seq, time: 1_700_000_000_000 + seq, ...spec }));
  const session = root.sessions.create(options.id ?? 'harness-session', { seed: events, ...sessionOptions() });
  return {
    root,
    store: root.sessions,
    session,
    // The store fiber is owned by the root context; a test that outlives its
    // session only has to settle. Kept as the suite's teardown hook.
    dispose: async () => { await settle(); },
  };
}

/**
 * A real session carrying one assistant message per reply. Replies that are not
 * strings become part lists, so a test can build tool-call-only messages.
 *
 * @param {(string | Record<string, unknown>[])[]} replies
 * @returns {Promise<object>} the live session.
 */
export async function sessionWithReplies(replies, options) {
  const { session, dispose } = await openSession(replies.map((content, index) => ({
    type: 'assistant/message',
    // Surface-eligible event types must declare how they enter the surface.
    surfaceOp: 'append',
    data: {
      // Settlement fields the restore validator insists on, plus the embedded
      // provider stream (empty: the settled message is what derives).
      turn: 0,
      step: index,
      stream: [],
      // The envelope validator insists an assistant message be identified.
      message: {
        id: 'msg-' + index,
        role: 'assistant',
        // The envelope validator requires an identified model source.
        source: { kind: 'model', provider: 'harness-provider', model: 'harness-model' },
        content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      },
    },
  })), options);
  // The store's fiber owns the session; the test process outlives it.
  void dispose;
  return session;
}