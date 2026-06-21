// 语言码 + 默认语言的单一来源（无依赖，纯数据）。
// astro.config.mjs 与 src/lib/i18n 都从这里读，避免两处 locale 列表漂移。
// 新增语言时，这里加一个码，astro 的 i18n.locales 与 sitemap 自动跟上。
export const LOCALE_CODES = ['zh', 'zh-TW', 'en'];
export const DEFAULT_LOCALE = 'zh';
