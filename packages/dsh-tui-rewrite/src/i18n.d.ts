/**
 * Types for the plugin's zh/en copy.
 *
 * @module dsh-tui-rewrite/i18n
 */

/**
 * Pin the language (plugin row config or a test); `undefined` reverts to the
 * automatic chain.
 */
export declare function setLangOverride(lang: string | undefined): void;

/**
 * Point the resolver at another preference file (a test seam); `undefined`
 * restores `~/.dsh-tui/lang.json`.
 */
export declare function setLangFile(path: string | undefined): void;

/**
 * The currently effective language: `DSH_TUI_LANG` -> plugin row
 * `config.lang` -> `~/.dsh-tui/lang.json` -> OS locale -> `zh`.
 */
export declare function getLang(): 'zh' | 'en';

/** One UI string in the active language; missing keys render the key itself. */
export declare function t(key: string, params?: Record<string, string | number>): string;
