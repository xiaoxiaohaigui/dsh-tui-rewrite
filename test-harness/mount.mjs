/**
 * Mount dsh-tui-rewrite into the real dsh-tui profile.
 *
 * Idempotent, and reversible with unmount.mjs. Writes exactly two things:
 *
 *   1. a junction  <profile>/node_modules/dsh-tui-rewrite -> this repo's package
 *      (what a package manager would install; a junction rather than a symlink so
 *      Node resolves the real path and the package keeps its own peers reachable)
 *   2. one insert row in the profile's cordis.patch.yml, backed up first
 *
 * The row must be an \`insert:\` LIST. A plain \`- id:/name:\` pair is an overlay for
 * an EXISTING entry and is reported as "patch: entry ... not found" when the
 * bundle layer has not inserted it first.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_DIR, PROFILE_DIR, requirePath } from './tools.mjs';

// Resolved from THIS file, so the script works from any cwd and any checkout.
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'dsh-tui-rewrite');
// This script writes into a real profile: a guessed location must fail BEFORE
// the first write, not half-way through one.
const CORE = requirePath(CORE_DIR, 'the @deepseek-ai packages dsh resolves', 'DSH_REWRITE_CORE');
const PROF = requirePath(PROFILE_DIR, 'the dsh-tui profile', 'DSH_REWRITE_PROFILE');
const PATCH = requirePath(join(PROF, 'cordis.patch.yml'), 'the profile patch file', 'DSH_REWRITE_PROFILE');

// 1) the plugin's own peers, resolvable from its real path
for (const p of ['dsh-session', 'cordis']) {
  const link = join(PKG, 'node_modules', '@deepseek-ai', p);
  if (!existsSync(link)) {
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(join(CORE, p), link, 'junction');
    console.log('linked peer  :', p);
  }
}

// 2) the profile resolves the package by name
const profLink = join(PROF, 'node_modules', 'dsh-tui-rewrite');
if (!existsSync(profLink)) {
  symlinkSync(PKG, profLink, 'junction');
  console.log('linked into profile: dsh-tui-rewrite');
}

// 3) the mount row
const text = readFileSync(PATCH, 'utf8');
if (/^- id: dsh-tui-rewrite$/mu.test(text) || /^\s+- id: dsh-tui-rewrite$/mu.test(text)) {
  console.log('mount row already present; patch untouched');
} else {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  copyFileSync(PATCH, PATCH + '.bak-rewrite-mount-' + stamp);
  console.log('backup       :', 'cordis.patch.yml.bak-rewrite-mount-' + stamp);
  writeFileSync(PATCH, text.replace(/\n*$/u, '\n') + [
    '',
    '# dsh-tui-rewrite — local development mount (2026-10-15). Not published.',
    '# Roll back with: node D:/dsh-tui-rewrite/test-harness/unmount.mjs',
    '- insert:',
    '    - id: dsh-tui-rewrite',
    '      name: dsh-tui-rewrite',
    '',
  ].join('\n'));
  console.log('mount row    : appended');
}
console.log('');
console.log('now start the TUI with:  dst');
