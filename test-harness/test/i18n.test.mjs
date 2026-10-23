/**
 * The plugin's language resolver, against the host's contract.
 *
 * R-021/R-022/R-024a: the scene used to let the host's static
 * `channel.configuredLang` outrank everything, and the locale fallback did not
 * match the host. These cases pin the order and the locale rule directly so a
 * future edit cannot quietly reintroduce the split.
 *
 * `setLangFile` is the module's test seam: it points the resolver at a temp
 * file instead of the user's real ~/.dsh-tui/lang.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLang, setLangFile, setLangOverride, t } from 'dsh-tui-rewrite/i18n';

const ENV_KEYS = ['DSH_TUI_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'];

/** Run `fn` with exactly `vars` set (all other locale keys unset), then restore. */
function withEnv(vars, fn) {
  const saved = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A file the resolver will not find, so the file layer is honestly unset. */
function withoutLangFile() {
  setLangFile(join(tmpdir(), 'dsh-rewrite-no-such-lang-' + process.pid + '.json'));
}

test('DSH_TUI_LANG is pinned above the plugin row config, like the host', () => {
  withoutLangFile();
  try {
    withEnv({ DSH_TUI_LANG: 'en' }, () => {
      setLangOverride('zh');
      assert.equal(getLang(), 'en');
    });
    withEnv({ DSH_TUI_LANG: 'zh' }, () => {
      setLangOverride('en');
      assert.equal(getLang(), 'zh');
    });
  } finally {
    setLangOverride(undefined);
  }
});

test('the plugin row config.lang pins the language when no env does', () => {
  withoutLangFile();
  try {
    withEnv({ LC_ALL: 'en_US.UTF-8' }, () => {
      setLangOverride('zh');
      assert.equal(getLang(), 'zh', 'row config outranks the OS locale');
    });
    setLangOverride('bogus');
    withEnv({ LC_ALL: 'en_US.UTF-8' }, () => {
      assert.equal(getLang(), 'en', 'an invalid pin falls back to the automatic chain');
    });
  } finally {
    setLangOverride(undefined);
  }
});

test('the persisted /lang choice outranks the locale and hot-swaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rewrite-i18n-'));
  const file = join(dir, 'lang.json');
  try {
    setLangOverride(undefined);
    writeFileSync(file, JSON.stringify({ lang: 'zh' }));
    setLangFile(file);
    withEnv({ LC_ALL: 'en_US.UTF-8' }, () => {
      assert.equal(getLang(), 'zh');
    });

    // A runtime /lang writes the file; re-pointing the resolver stands in for
    // the one-second mtime probe so the test does not sleep.
    writeFileSync(file, JSON.stringify({ lang: 'en' }));
    setLangFile(file);
    withEnv({ LC_ALL: 'zh_CN.UTF-8' }, () => {
      assert.equal(getLang(), 'en');
    });

    // A corrupt file is "unset", not a crash and not a stuck language.
    writeFileSync(file, '{ not json');
    setLangFile(file);
    withEnv({ LC_ALL: 'en_US.UTF-8' }, () => {
      assert.equal(getLang(), 'en');
    });
  } finally {
    setLangFile(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the locale fallback is the host detectLocaleLang rule', () => {
  setLangOverride(undefined);
  withoutLangFile();
  // Any explicit non-zh locale maps to en - not to zh, which is what the old
  // prefix-only resolver did for de/fr/ja and how the UI split in half.
  withEnv({ LC_ALL: 'de_DE.UTF-8' }, () => assert.equal(getLang(), 'en'));
  withEnv({ LC_ALL: 'ja_JP.UTF-8' }, () => assert.equal(getLang(), 'en'));
  withEnv({ LC_ALL: 'C' }, () => assert.equal(getLang(), 'en', 'C is an explicit locale'));
  // An EMPTY variable means unset and falls through (||, not ??).
  withEnv({ LC_ALL: '', LC_MESSAGES: '', LANG: 'zh_CN.UTF-8' }, () => assert.equal(getLang(), 'zh'));
  withEnv({ LC_ALL: '', LANG: 'en_US.UTF-8' }, () => assert.equal(getLang(), 'en'));
  // LANGUAGE / Intl are not part of the host contract.
  withEnv({ LANG: 'en_US.UTF-8', LANGUAGE: 'zh_CN' }, () => assert.equal(getLang(), 'en'));
  // Only an ABSENT locale keeps the zh default. An Intl locale saying en must
  // not override that: the host does not consult Intl either.
  const originalFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function fakeFormat() {
    return { resolvedOptions: () => ({ locale: 'en-US' }) };
  };
  try {
    withEnv({}, () => assert.equal(getLang(), 'zh'));
  } finally {
    Intl.DateTimeFormat = originalFormat;
  }
});

test('t substitutes placeholders and renders a missing key as itself', () => {
  setLangOverride('en');
  try {
    assert.match(t('edit-rewritten', { seq: 7 }), /rewrote seq 7/u);
    assert.equal(t('no-such-key'), 'no-such-key');
    assert.match(t('edit-title', { seq: 1, line: 2, lines: 3, col: 4 }), /line 2\/3, col 4/u);
  } finally {
    setLangOverride(undefined);
  }
});
