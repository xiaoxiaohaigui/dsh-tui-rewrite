/**
 * The published `.d.ts` files against the runtime they describe.
 *
 * This package is plain ESM with hand-written declarations, so nothing forces
 * the two to agree: a declaration can name an export that does not exist (a
 * consumer's build then breaks) or miss one that does (the export becomes
 * invisible to TypeScript). No TypeScript compiler is available in this
 * harness, and none is needed for the half that matters mechanically - compare
 * the VALUE exports on both sides.
 *
 * Type-only declarations are skipped: an interface has no runtime counterpart
 * by definition. The check covers exactly what a mismatch would break.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The package's subpath export map and the declaration file serving each one. */
const MODULES = [
  { specifier: 'dsh-tui-rewrite', declaration: 'main.d.ts' },
  { specifier: 'dsh-tui-rewrite/projection', declaration: 'projection.d.ts' },
  { specifier: 'dsh-tui-rewrite/scene', declaration: 'scene.d.ts' },
  { specifier: 'dsh-tui-rewrite/i18n', declaration: 'i18n.d.ts' },
  { specifier: 'dsh-tui-rewrite/debug', declaration: 'debug.d.ts' },
  { specifier: 'dsh-tui-rewrite/seam', declaration: 'seam.d.ts' },
  { specifier: 'dsh-tui-rewrite/persist', declaration: 'persist.d.ts' },
];

/** Resolve a declaration file through the package's real install location. */
function declarationPath(file) {
  const entry = fileURLToPath(import.meta.resolve('dsh-tui-rewrite/package.json'));
  return new URL('./src/' + file, pathToFileURL(entry));
}

/**
 * The names a declaration file exports AT RUNTIME, i.e. excluding types.
 *
 * `export declare const|function|class` and `export { a, b } from './x.js'`
 * declare values; `export interface|type` does not. Re-exported type names are
 * skipped when they are not also declared as values in this file, which is the
 * conservative direction: a missed name shows up as a runtime export the
 * declaration lacks.
 */
function declaredValues(source) {
  const names = new Set();
  const valueDecl = /^export declare (?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/gmu;
  for (const match of source.matchAll(valueDecl)) names.add(match[1]);
  if (/^export default /mu.test(source)) names.add('default');
  // export { a, b as c } from './x.js'  (the pure-type lists use `export type`)
  const reExport = /^export\s*\{([^}]*)\}\s*from\s*'[^']*'/gmu;
  for (const match of source.matchAll(reExport)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/u).pop().trim();
      if (name.length > 0) names.add(name);
    }
  }
  return names;
}

for (const { specifier, declaration } of MODULES) {
  test(specifier + ': every runtime export is declared, and vice versa', async () => {
    const source = readFileSync(declarationPath(declaration), 'utf8');
    const declared = declaredValues(source);
    const runtime = new Set(Object.keys(await import(specifier)));

    const undeclared = [...runtime].filter(name => !declared.has(name)).sort();
    const phantom = [...declared].filter(name => !runtime.has(name)).sort();

    assert.deepEqual(undeclared, [], 'runtime exports missing from ' + declaration);
    assert.deepEqual(phantom, [], declaration + ' declares exports the module does not have');
  });
}

/**
 * Erase the module syntax, then strip the types, then parse.
 *
 * There is no TypeScript compiler in this harness, but Node's own type stripper
 * is a real syntax check: a malformed declaration file fails here instead of in
 * a consumer's build.
 *
 * @param {string} source
 */
function assertDeclarationSyntax(source, label) {
  // Join multi-line import/export lists so the single-line rules below match.
  let stripped = source.replace(/\{[^}]*\}/gu, list => list.replace(/\n\s*/gu, ' '));
  stripped = stripped.replace(/^import[^;]*;$/gmu, '');
  // Drop re-export lines ENTIRELY, including the `export type` form: removing
  // only the keyword would leave a `type { .. } from '..'` statement behind.
  stripped = stripped.replace(/^export\s+(?:type\s+)?\{[^}]*\}\s*from\s*'[^']*';$/gmu, '');
  stripped = stripped.replace(/^export\s+type\s+\{[^}]*\};$/gmu, '');
  stripped = stripped.replace(/^export\s+default\s+/gmu, 'const __default = ');
  stripped = stripped.replace(/^export\s+/gmu, '');
  assert.doesNotThrow(() => new Function(stripTypeScriptTypes(stripped, { mode: 'strip' })), label);
}

test('every published declaration file is syntactically valid', () => {
  // test/ -> test-harness/ -> repo root, then packages/ (the same path
  // debug.test.mjs reaches its entry through).
  const src = new URL('../../packages/dsh-tui-rewrite/src/', import.meta.url);
  for (const { declaration } of MODULES) {
    assertDeclarationSyntax(readFileSync(new URL(declaration, src), 'utf8'), declaration);
  }
});

test('the package points types at declarations that exist', async () => {
  const entry = fileURLToPath(import.meta.resolve('dsh-tui-rewrite/package.json'));
  const manifest = JSON.parse(readFileSync(entry, 'utf8'));
  const targets = [manifest.types];
  for (const value of Object.values(manifest.exports)) {
    if (value !== null && typeof value === 'object' && typeof value.types === 'string') targets.push(value.types);
  }
  // The root `types` field plus one per typed subpath; every one is read below.
  assert.ok(targets.length >= MODULES.length, 'every typed subpath must declare types');
  for (const target of targets) {
    assert.doesNotThrow(
      () => readFileSync(fileURLToPath(new URL(target, pathToFileURL(entry))), 'utf8'),
      'package.json points types at a missing file: ' + target,
    );
  }
});
