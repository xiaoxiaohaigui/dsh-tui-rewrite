/**
 * The plugin's debug log is the ONLY evidence channel a full-screen TUI leaves
 * (stderr is hidden behind the alternate screen), so what it records is part of
 * the contract: without these lines a broken entry point is indistinguishable
 * from a healthy boot. See docs/explore/phase1a-results.md section 3.1, where
 * exactly these lines are what proved the late-mount path fires on a real boot.
 *
 * `debug.js` reads its switch at MODULE LOAD and the plugin reaches it through a
 * bare relative import, so every dynamically loaded copy shares the first-loaded
 * instance's configuration. The whole file therefore runs under ONE switch
 * setting, set before the first import below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';

const settle = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
const stamp = Date.now();
const logPath = join(tmpdir(), 'dsh-tui-rewrite-debug-' + stamp + '.jsonl');
rmSync(logPath, { force: true });
process.env.DSH_TUI_REWRITE_DEBUG = logPath;

// The plugin entry loaded through the repo path: a bare specifier cannot carry
// the cache-busting query, and the package is plain ESM with no self-reference.
const ENTRY = new URL('../../packages/dsh-tui-rewrite/src/main.js', import.meta.url);
const plugin = await import(ENTRY.href);

function lines() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('the debug log records every entry point as it lands', async () => {
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  root.provide('commands', { register: () => () => {} });
  root.provide('tuiScenes', { register: () => () => {}, open: () => true });
  root.provide('tuiShortcuts', { register: () => () => {} });
  const host = root.plugin(plugin.createPlugin({ timers: { budgetMs: 200 } }));
  await settle();

  const messages = lines().map(entry => entry.message);
  assert.ok(messages.includes('applied'), messages.join(','));
  assert.ok(messages.includes('scene registered'));
  assert.ok(messages.includes('command registered'));
  assert.ok(messages.includes('shortcut bound'));
  assert.equal(lines().find(entry => entry.message === 'applied').registered, true);
  await host.dispose();
});

test('the applied line does NOT report entry-point booleans', async () => {
  // A seam that mounts 400 ms after apply still reads as absent at apply time
  // (real boot: scene:false at apply, 'scene registered' 439 ms later), so those
  // booleans would be a trap. The per-entry-point lines are the truth.
  const applied = lines().find(entry => entry.message === 'applied');
  assert.deepEqual(Object.keys(applied).sort(), ['at', 'message', 'registered']);
});

test('a composition without the seams records no entry-point lines', async () => {
  // Nothing to register against: apply must still be recorded, and no
  // 'scene registered' / 'shortcut bound' line may ever appear.
  rmSync(logPath, { force: true });
  const root = new Context();
  root.plugin(SessionStore);
  await settle();
  const host = root.plugin(plugin.createPlugin({ timers: { budgetMs: 150 } }));
  await settle();

  const messages = lines().map(entry => entry.message);
  assert.deepEqual(messages, ['applied']);
  assert.equal(plugin.projectionStatus().registered, true);
  await host.dispose();
  rmSync(logPath, { force: true });
});
