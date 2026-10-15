/**
 * Opt-in JSONL diagnostics for the rewrite plugin.
 *
 * The TUI renders to an alternate screen and its stderr is gated on isTTY, so a
 * full-screen problem leaves no readable trace anywhere. `DSH_TUI_REWRITE_DEBUG`
 * (a file path, or any truthy value for the default location) enables a JSONL
 * log of scene mounts, target enumeration, and appends instead.
 *
 * Every write is guarded: diagnostics must never be load-bearing.
 *
 * @module dsh-tui-rewrite/debug
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_PATH = join(homedir(), '.dsh-tui', 'dsh-tui-rewrite.log');

/** `undefined` when disabled; the resolved file path when enabled. */
const configured = (() => {
  const value = process.env.DSH_TUI_REWRITE_DEBUG;
  if (value === undefined || value === '' || value === '0' || value === 'false') return undefined;
  return value === '1' || value === 'true' ? DEFAULT_PATH : value;
})();

/** Whether the debug log is on (also mirrored into every log line). */
export const debugEnabled = configured !== undefined;

/**
 * Append one JSONL record. No-ops unless the env switch is set.
 *
 * @param {string} message - the event name.
 * @param {Record<string, unknown>} [fields] - structured detail.
 */
export function debugLog(message, fields) {
  if (configured === undefined) return;
  try {
    mkdirSync(dirname(configured), { recursive: true });
    appendFileSync(configured, JSON.stringify({ at: new Date().toISOString(), message, ...fields }) + '\n', { mode: 0o600 });
  } catch {
    // A measurement aid must never affect the UI.
  }
}

/** The active log path, for diagnostics output. */
export function debugPath() {
  return configured;
}
