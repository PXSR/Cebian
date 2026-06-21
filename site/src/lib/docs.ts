import { getCollection, type CollectionEntry } from 'astro:content';
import { LANGS, type Lang } from './i18n';

// 文档条目的 id 形如 "zh/getting-started/introduction/index"（每篇文章一个文件夹，
// 正文为 index.mdx）。这里把它解析成 { lang, group, slug }，并剥掉末尾的 "index"。

export interface DocMeta {
  lang: Lang;
  group: string;
  slug: string;
  title: string;
  description: string;
  order: number;
  /** 占位页：noindex（内容待补） */
  placeholder: boolean;
  /** 无 locale 前缀的路径，如 "/docs/getting-started/introduction" */
  path: string;
}

function parseId(id: string): { lang: string; group: string; slug: string } | null {
  const parts = id.split('/').filter(Boolean);
  // 末尾的 index 是文件名，不属于路由 slug，剥掉。
  if (parts[parts.length - 1] === 'index') parts.pop();
  if (parts.length < 3) return null;
  const [lang, group, ...rest] = parts;
  return { lang, group, slug: rest.join('/') };
}

const isLang = (s: string): s is Lang => (LANGS as string[]).includes(s);

/** 取某语言下全部非草稿文档（已按 group→order→title 排序）。 */
export async function getDocsFor(lang: Lang): Promise<{ entry: CollectionEntry<'docs'>; meta: DocMeta }[]> {
  const all = await getCollection('docs', (e) => !e.data.draft);
  const out = all
    .map((entry) => {
      const parsed = parseId(entry.id);
      if (!parsed || !isLang(parsed.lang) || parsed.lang !== lang) return null;
      const meta: DocMeta = {
        lang: parsed.lang,
        group: parsed.group,
        slug: parsed.slug,
        title: entry.data.title,
        description: entry.data.description,
        order: entry.data.order,
        placeholder: entry.data.placeholder,
        path: `/docs/${parsed.group}/${parsed.slug}`,
      };
      return { entry, meta };
    })
    .filter((x): x is { entry: CollectionEntry<'docs'>; meta: DocMeta } => x !== null);
  out.sort((a, b) => a.meta.order - b.meta.order || a.meta.title.localeCompare(b.meta.title));
  return out;
}

export interface DocGroup {
  key: string;
  label: string;
  items: DocMeta[];
}

/**
 * 按 groupOrder 给定的顺序把文档分组，附上每组的本地化标题。
 * groupOrder / labels 来自 i18n（dict.docs.groups），保证顺序与译名单一来源。
 * 若某文档的 group 不在 groupOrder 里声明（多半是 frontmatter 拼写错误），
 * 直接抛错让构建失败——避免把未翻译的原始 group key 当章节悄悄发布。
 */
export function groupDocs(
  docs: { meta: DocMeta }[],
  groupOrder: { key: string; label: string }[],
): DocGroup[] {
  const known = new Set(groupOrder.map((g) => g.key));
  const byKey = new Map<string, DocMeta[]>();
  for (const { meta } of docs) {
    if (!known.has(meta.group)) {
      throw new Error(
        `[docs] 文档 "${meta.lang}/${meta.group}/${meta.slug}" 的 group "${meta.group}" 未在 dict.docs.groups 中声明。` +
          `请修正 frontmatter 的 group，或在 i18n 的 docs.groups 里新增该分组。`,
      );
    }
    if (!byKey.has(meta.group)) byKey.set(meta.group, []);
    byKey.get(meta.group)!.push(meta);
  }
  const groups: DocGroup[] = [];
  for (const g of groupOrder) {
    const items = byKey.get(g.key);
    if (items && items.length) groups.push({ key: g.key, label: g.label, items });
  }
  return groups;
}

/** 给 getStaticPaths 用：列出某语言所有文档的 [group, slug]。 */
export async function docStaticParams(lang: Lang) {
  const docs = await getDocsFor(lang);
  return docs.map(({ meta }) => ({ group: meta.group, slug: meta.slug }));
}

/**
 * 取当前文档在「分组顺序 → 组内 order」展开后的扁平序列里的上一篇 / 下一篇。
 * groupOrder 来自 i18n，保证翻页顺序与侧栏一致。
 */
export function adjacentDocs(
  docs: { meta: DocMeta }[],
  groupOrder: { key: string; label: string }[],
  currentPath: string,
): { prev: DocMeta | null; next: DocMeta | null } {
  const rank = new Map(groupOrder.map((g, i) => [g.key, i]));
  const flat = docs
    .map((d) => d.meta)
    .filter((m) => rank.has(m.group))
    .sort((a, b) => (rank.get(a.group)! - rank.get(b.group)!) || a.order - b.order || a.title.localeCompare(b.title));
  const idx = flat.findIndex((m) => m.path === currentPath);
  if (idx === -1) return { prev: null, next: null };
  return {
    prev: idx > 0 ? flat[idx - 1] : null,
    next: idx < flat.length - 1 ? flat[idx + 1] : null,
  };
}
