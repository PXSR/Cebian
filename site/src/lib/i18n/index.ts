// ── i18n 单一注册中心 ────────────────────────────────────────────────
// 新增语言需要三处改动（受静态打包限制，import 无法省略）：
//   1. 在 src/lib/i18n/locales/ 加一个 <code>.ts（导出同形状的 Dict）；
//   2. 在本文件顶部 import 它；
//   3. 在下面 REGISTRY 加一行（元信息 + dict）。
//   4. 在 ../../locales.config.mjs 的 LOCALE_CODES 加上同一个码。
// 其余（Lang 类型、LANGS、getDict、langStaticPaths、localePath/alternatePath/
// langFromUrl）全部由 REGISTRY 自动派生。下方的 assertion 会在 REGISTRY 与
// locales.config.mjs 漂移时直接构建报错，确保两处不脱节。
// 代码与语言数据分离：本文件是代码，locales/ 是数据。

import { LOCALE_CODES, DEFAULT_LOCALE } from '../../../locales.config.mjs';
import type { Dict } from './types';
import { zh } from './locales/zh';
import { en } from './locales/en';
import { zhTW } from './locales/zh-tw';

export interface LocaleMeta {
  /** <html lang> 值 */
  htmlLang: string;
  /** 菜单里的完整名 */
  name: string;
  /** 语言下拉触发器上的短名 */
  short: string;
  /** og:locale */
  ogLocale: string;
  /** 该语言的文案字典 */
  dict: Dict;
}

// 唯一需要随新增语言改动的地方。顺序即语言菜单展示顺序。
const REGISTRY = {
  zh:      { htmlLang: 'zh-CN', name: '简体中文', short: '简体', ogLocale: 'zh_CN', dict: zh },
  'zh-TW': { htmlLang: 'zh-TW', name: '繁體中文', short: '繁體', ogLocale: 'zh_TW', dict: zhTW },
  en:      { htmlLang: 'en',    name: 'English',  short: 'EN',   ogLocale: 'en_US', dict: en },
} as const satisfies Record<string, LocaleMeta>;

export type Lang = keyof typeof REGISTRY;

export const LOCALES: Record<Lang, LocaleMeta> = REGISTRY;
export const LANGS = Object.keys(REGISTRY) as Lang[];
export const DEFAULT_LANG = DEFAULT_LOCALE as Lang;

// 漂移守卫：REGISTRY 必须与 locales.config.mjs 完全一致（构建期即报错）。
{
  const cfg = [...LOCALE_CODES].sort().join(',');
  const reg = [...LANGS].sort().join(',');
  if (cfg !== reg) {
    throw new Error(
      `[i18n] REGISTRY (${reg}) 与 locales.config.mjs (${cfg}) 不一致，请同步两处的语言列表。`,
    );
  }
  if (!LANGS.includes(DEFAULT_LANG)) {
    throw new Error(`[i18n] DEFAULT_LOCALE "${DEFAULT_LOCALE}" 不在 REGISTRY 中。`);
  }
}

export function getDict(lang: Lang): Dict {
  return REGISTRY[lang].dict;
}

const isLang = (s: string): s is Lang => Object.prototype.hasOwnProperty.call(REGISTRY, s);

/** astro getStaticPaths 用：[{ params: { lang } }, ...] */
export function langStaticPaths() {
  return LANGS.map((lang) => ({ params: { lang } }));
}

/** 给定语言 + 无前缀路径，拼出带 locale 前缀、且统一带尾斜杠的链接。
 *  与 astro.config 的 trailingSlash:'always' + sitemap 输出保持一致，
 *  避免 canonical / hreflang 指向会 301 的无斜杠 URL。 */
export function localePath(lang: Lang, path: string): string {
  let clean = path.startsWith('/') ? path : `/${path}`;
  if (clean === '/') clean = '';
  const withSlash = clean === '' ? '/' : clean.endsWith('/') ? clean : `${clean}/`;
  return `/${lang}${withSlash}`;
}

/** 从 URL 解析当前语言；解析不到回退默认。 */
export function langFromUrl(url: URL): Lang {
  const seg = url.pathname.split('/').filter(Boolean)[0] ?? '';
  return isLang(seg) ? seg : DEFAULT_LANG;
}

/** 把当前路径映射到目标语言的对应路径（语言切换用），统一带尾斜杠。 */
export function alternatePath(currentPath: string, target: Lang): string {
  const parts = currentPath.split('/').filter(Boolean);
  if (parts.length && isLang(parts[0])) parts.shift();
  const rest = parts.length ? '/' + parts.join('/') : '/';
  return localePath(target, rest);
}

export type { Dict } from './types';
