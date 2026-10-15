/**
 * Remove dsh-tui-rewrite from the real dsh-tui profile (undo mount.mjs).
 * Deletes only the junction and the mount section; the plugin package itself
 * lives in the repo and is untouched.
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROF = 'C:/Users/86198/.dsh/profiles/dsh-tui';
const PATCH = join(PROF, 'cordis.patch.yml');

const link = join(PROF, 'node_modules', 'dsh-tui-rewrite');
if (existsSync(link)) {
  // rmSync on a junction removes the link, never the target's contents.
  rmSync(link, { recursive: true, force: true });
  console.log(existsSync(link) ? 'junction: STILL PRESENT' : 'junction: removed');
} else {
  console.log('junction: absent');
}

const text = readFileSync(PATCH, 'utf8');
// Matches every mount comment the script has ever written ("phase 0 mount",
// "local development mount"), so unmount keeps working across revisions.
const marker = '# dsh-tui-rewrite — ';
const at = text.indexOf(marker);
if (at < 0) {
  console.log('mount section: not present');
} else {
  writeFileSync(PATCH, text.slice(0, at).replace(/\n*$/u, '\n'));
  console.log('mount section: removed');
}
