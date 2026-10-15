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
import { join } from 'node:path';

const PKG = 'D:/dsh-tui-rewrite/packages/dsh-tui-rewrite';
const CORE = 'C:/Users/86198/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const PROF = 'C:/Users/86198/.dsh/profiles/dsh-tui';
const PATCH = join(PROF, 'cordis.patch.yml');

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
