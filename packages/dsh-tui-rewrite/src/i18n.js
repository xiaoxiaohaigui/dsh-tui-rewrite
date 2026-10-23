/**
 * Plugin copy, zh/en, following the host's language contract WITHOUT importing
 * it:
 *
 *   1. `DSH_TUI_LANG` - pinned at process start, wins over every config
 *   2. the plugin row's `config.lang` (an explicit plugin-level pin)
 *   3. `~/.dsh-tui/lang.json` - the persisted `/lang` choice (mtime-cached)
 *   4. the OS locale (`LC_ALL` / `LC_MESSAGES` / `LANG`)
 *   5. `zh` - the host's original hard-coded language
 *
 * This is the host's own order with the plugin row standing in for the host's
 * cordis `lang`: the TUI does not expose its i18n module (or its in-memory
 * `setLang`), and the scene only receives React/ui/channel/close. A runtime
 * `/lang` writes lang.json, so the file probe is what hot-swaps this plugin's
 * strings - including the next launch's default.
 *
 * The OS-locale rule is the host's `detectLocaleLang` exactly: an explicit
 * non-zh locale maps to en (a German user must not get a Chinese UI), C/POSIX
 * counts as explicit and maps to en, and only an ABSENT locale keeps zh.
 * `LANGUAGE` and `Intl` are deliberately not consulted - the host does not
 * read them either, and disagreeing there is how the two halves of one screen
 * end up in different languages.
 *
 * @module dsh-tui-rewrite/i18n
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The dsh-tui preference file this plugin mirrors. */
const DEFAULT_LANG_FILE = join(homedir(), '.dsh-tui', 'lang.json');
let langFile = DEFAULT_LANG_FILE;
/** A statSync per t() call would be a syscall on every keystroke; one probe a second is enough for /lang. */
const FILE_PROBE_INTERVAL_MS = 1000;

let override;
let cachedFileLang;
let cachedFileMtime = 0;
let lastProbeAt = 0;

function parseLang(value) {
  return value === 'zh' || value === 'en' ? value : undefined;
}

/** Pin the language (plugin row config or a test); undefined reverts to auto. */
export function setLangOverride(lang) {
  override = parseLang(lang);
}

/**
 * Point the resolver at another preference file (a test seam). `undefined`
 * restores `~/.dsh-tui/lang.json`; either way the mtime cache is reset so the
 * next call reads the new file instead of a stale probe.
 *
 * @param {string | undefined} path
 */
export function setLangFile(path) {
  langFile = path ?? DEFAULT_LANG_FILE;
  cachedFileLang = undefined;
  cachedFileMtime = 0;
  lastProbeAt = 0;
}

function fileLang() {
  const now = Date.now();
  if (now - lastProbeAt < FILE_PROBE_INTERVAL_MS) return cachedFileLang;
  lastProbeAt = now;
  try {
    const mtime = statSync(langFile).mtimeMs;
    if (mtime !== cachedFileMtime) {
      cachedFileMtime = mtime;
      try {
        const parsed = JSON.parse(readFileSync(langFile, 'utf8'));
        cachedFileLang = parseLang(parsed?.lang);
      } catch {
        cachedFileLang = undefined;
      }
    }
  } catch {
    cachedFileLang = undefined;
  }
  return cachedFileLang;
}

/**
 * The host's `detectLocaleLang`: `||` (not `??`) so an EMPTY variable means
 * "unset" and falls through; only the language tag before the first dot counts;
 * no locale at all keeps zh; every other stated locale maps to en.
 */
function localeLang() {
  const raw = process.env.LC_ALL
    || process.env.LC_MESSAGES
    || process.env.LANG
    || '';
  const locale = raw.split('.')[0]?.toLowerCase() ?? '';
  if (locale === '') return 'zh';
  return locale.startsWith('zh') ? 'zh' : 'en';
}

/** The currently effective language, read live (see the module comment). */
export function getLang() {
  return parseLang(process.env.DSH_TUI_LANG) ?? override ?? fileLang() ?? localeLang() ?? 'zh';
}

/** Flat key -> per-language text. Missing keys render the key itself (visible typo, not a blank). */
const dict = {
  'scene-title-one': {
    en: ' rewrite · 1 assistant reply · session {{id}}',
    zh: ' rewrite · 1 条助手回复 · 会话 {{id}}',
  },
  'scene-title': {
    en: ' rewrite · {{count}} assistant replies · session {{id}}',
    zh: ' rewrite · {{count}} 条助手回复 · 会话 {{id}}',
  },
  'scene-hint': {
    en: ' ↑↓ select · Enter edit · Esc close',
    zh: ' ↑↓ 选择 · Enter 编辑 · Esc 关闭',
  },
  'scene-empty': {
    en: ' (no assistant replies with text in this session yet)',
    zh: ' （本会话还没有带文本的助手回复）',
  },
  'scene-no-session': {
    en: ' rewrite · no live session is bound to this UI',
    zh: ' rewrite · 当前界面没有绑定活动会话',
  },
  'scene-session': {
    en: ' session {{id}}',
    zh: ' 会话 {{id}}',
  },
  'scene-esc-close': {
    en: ' Esc to close',
    zh: ' Esc 关闭',
  },
  'edit-title': {
    en: ' rewrite · editing seq {{seq}}  (line {{line}}/{{lines}}, col {{col}})',
    zh: ' rewrite · 正在编辑 seq {{seq}}  （第 {{line}}/{{lines}} 行，第 {{col}} 列）',
  },
  'edit-hint': {
    en: ' Enter newline · Ctrl+Z undo · Ctrl+S submit · Esc cancel',
    zh: ' Enter 换行 · Ctrl+Z 撤销 · Ctrl+S 提交 · Esc 取消',
  },
  'edit-cancelled': { en: 'edit cancelled', zh: '已取消编辑' },
  'edit-unchanged': { en: 'unchanged — nothing appended', zh: '未修改 — 没有追加事件' },
  'edit-empty': { en: 'empty text — nothing appended', zh: '文本为空 — 没有追加事件' },
  'edit-rewritten': {
    en: 'rewrote seq {{seq}} — the model sees the new text, the log keeps the original',
    zh: '已改写 seq {{seq}} — 模型看到新文本，日志保留原文',
  },
  'edit-append-failed': { en: 'append failed: {{error}}', zh: '追加失败：{{error}}' },
  'command-description': {
    en: 'Rewrite the text of an assistant reply on the model-visible surface',
    zh: '改写助手回复的文本（模型可见面）',
  },
  'command-input-hint': {
    en: '[no arguments — the scene picks the reply]',
    zh: '[无参数 — 在场景中选择回复]',
  },
  'shortcut-description': { en: 'Rewrite an assistant reply', zh: '改写一条助手回复' },
};

function substitute(template, params) {
  if (params === undefined) return template;
  return template.replace(/\{\{(\w+)\}\}/gu, (match, name) => (
    params[name] === undefined ? match : String(params[name])
  ));
}

/**
 * One UI string in the active language.
 *
 * @param {string} key - dictionary key.
 * @param {Record<string, string | number>} [params] - {{name}} placeholders.
 */
export function t(key, params) {
  const entry = dict[key];
  if (entry === undefined) return key;
  const active = getLang();
  return substitute(entry[active] ?? entry.en, params);
}
