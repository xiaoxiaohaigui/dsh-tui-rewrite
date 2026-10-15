/**
 * Build the harness resolution fixture.
 *
 * Two layers, both mirroring a real install rather than a flag:
 *
 * 1. `test-harness/node_modules` - what the profile would provide.
 * 2. `packages/dsh-tui-rewrite/node_modules` - the plugin's OWN peer
 *    dependencies. A real `npm install` / pnpm resolves them next to the
 *    package; without them the bare `@deepseek-ai/dsh-session` import in
 *    `src/projection.js` cannot resolve, because module resolution walks up
 *    from the IMPORTING file's real path.
 *
 * Junctions (not symlinks) so Node resolves real paths and each package keeps
 * its own siblings reachable - no --preserve-symlinks flag anywhere.
 *
 * Both node_modules trees are generated artifacts: run this script instead of
 * committing them (see .gitignore).
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FIX = 'D:/dsh-tui-rewrite/test-harness';
const PKG = 'D:/dsh-tui-rewrite/packages/dsh-tui-rewrite';
const CORE = 'C:/Users/86198/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const PROF = 'C:/Users/86198/.dsh/profiles/dsh-tui/node_modules';

/** Pairs of [link to create, junction target]. */
const harnessLinks = [
  [join(FIX, 'node_modules', '@deepseek-ai', 'cordis'), join(CORE, 'cordis')],
  [join(FIX, 'node_modules', '@deepseek-ai', 'dsh-session'), join(CORE, 'dsh-session')],
  [join(FIX, 'node_modules', '@deepseek-harness-tui', 'dsh-tui'), join(PROF, '@deepseek-harness-tui', 'dsh-tui')],
  [join(FIX, 'node_modules', 'dsh-tui-rewrite'), PKG],
];

const peerLinks = [
  [join(PKG, 'node_modules', '@deepseek-ai', 'cordis'), join(CORE, 'cordis')],
  [join(PKG, 'node_modules', '@deepseek-ai', 'dsh-session'), join(CORE, 'dsh-session')],
  [join(PKG, 'node_modules', '@deepseek-harness-tui', 'dsh-tui'), join(PROF, '@deepseek-harness-tui', 'dsh-tui')],
];

const build = (label, links) => {
  console.log(label);
  for (const [link, target] of links) {
    mkdirSync(join(link, '..'), { recursive: true });
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link, 'junction');
    console.log('   ', link.replace(/^.*node_modules[\\/]/, ''), existsSync(link) ? 'ok' : 'MISSING');
  }
};

build('harness node_modules:', harnessLinks);
build('plugin peer node_modules:', peerLinks);
writeFileSync(join(FIX, 'package.json'), JSON.stringify({ name: 'dsh-tui-rewrite-harness', private: true, type: 'module' }, null, 2) + '\n');
console.log('fixture ready');
