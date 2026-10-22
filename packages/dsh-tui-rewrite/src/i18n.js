/**
 * Plugin copy, zh/en, following the host's language contract WITHOUT importing
 * it: config lang -> DSH_TUI_LANG -> ~/.dsh-tui/lang.json (mtime-cached) ->
 * OS locale -> zh. A /lang switch therefore hot-swaps this plugin's strings on
 * the next render, exactly like the host's own screens.
 *
 * The resolver is copied from the host's published contract (the same order
 * dsh-tui-find uses) because the TUI does not expose its i18n module through
 * the plugin surface; the scene only receives React/ui/channel/close.
 *
 * @module dsh-tui-rewrite/i18n
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The dsh-tui preference file this plugin mirrors. */
const LANG_FILE = join(homedir(), '.dsh-tui', 'lang.json');
/** A statSync per t() call would be a syscall on every keystroke; one probe a second is enough for /lang. */
const FILE_PROBE_INTERVAL_MS = 1000;

let override;
let cachedFileLang;
let cachedFileMtime = 0;
let lastProbeAt = 0;

function parseLang(value) {
  return value === 'zh' || value === 'en' ? value : undefined;
}

/** Pin the language (plugin config or a test); undefined reverts to auto. */
export function setLangOverride(lang) {
  override = parseLang(lang);
}

function fileLang() {
  const now = Date.now();
  if (now - lastProbeAt < FILE_PROBE_INTERVAL_MS) return cachedFileLang;
  lastProbeAt = now;
  try {
    const mtime = statSync(LANG_FILE).mtimeMs;
    if (mtime !== cachedFileMtime) {
      cachedFileMtime = mtime;
      try {
        const parsed = JSON.parse(readFileSync(LANG_FILE, 'utf8'));
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

function localeLang() {
  const raw = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? process.env.LANGUAGE ?? '';
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('en')) return 'en';
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    if (locale.startsWith('zh')) return 'zh';
    if (locale.startsWith('en')) return 'en';
  } catch { /* an exotic ICU build must not break the scene */ }
  return undefined;
}

/** The currently effective language, read live. */
export function getLang() {
  return override ?? parseLang(process.env.DSH_TUI_LANG) ?? fileLang() ?? localeLang() ?? 'zh';
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
    en: ' Enter newline · Ctrl+S submit · Esc cancel',
    zh: ' Enter 换行 · Ctrl+S 提交 · Esc 取消',
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
export function t(key, params, lang) {
  const entry = dict[key];
  if (entry === undefined) return key;
  const active = parseLang(lang) ?? getLang();
  return substitute(entry[active] ?? entry.en, params);
}
