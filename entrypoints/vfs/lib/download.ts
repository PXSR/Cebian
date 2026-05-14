import { zip } from 'fflate';
import { vfs } from '@/lib/vfs';

/** Recursively walks `rootPath` in the VFS and bundles every regular file
 *  into a zip archive. Paths inside the archive are kept FLAT relative to
 *  `rootPath` — downloading `/prompts` produces `prompts.zip` whose root
 *  entries are `foo.md`, `sub/bar.md`, ... (no extra wrapper folder), so
 *  the archive mirrors the VFS subtree as the user sees it.
 *
 *  Symlinks are followed via `vfs.stat` (same as the directory listing),
 *  so linked content is included with paths relative to the walked
 *  subtree — e.g. `/prompts/shared → /lib/shared` shows up inside
 *  `prompts.zip` as `shared/...`. A visited-set on the resolved child
 *  paths prevents `link → ancestor` loops from recursing forever.
 *
 *  Files whose `stat` blows up are silently skipped — we'd rather get a
 *  partial archive than abort the whole download for one broken entry. */
export async function zipDirectory(rootPath: string): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  const visited = new Set<string>([rootPath]);

  async function walk(dir: string, prefix: string): Promise<void> {
    const names = await vfs.readdir(dir);
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const childPath = dir === '/' ? `/${name}` : `${dir}/${name}`;
      const rel = prefix ? `${prefix}/${name}` : name;
      let st: Awaited<ReturnType<typeof vfs.stat>>;
      try {
        st = await vfs.stat(childPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Guard against symlink loops (e.g. /a/back → /a) by tracking
        // already-walked paths. The set uses normalized vfs paths, which
        // are unique per logical location.
        if (visited.has(childPath)) continue;
        visited.add(childPath);
        await walk(childPath, rel);
      } else {
        const data = (await vfs.readFile(childPath)) as unknown as Uint8Array;
        entries[rel] = data;
      }
    }
  }

  await walk(rootPath, '');

  return new Promise((resolve, reject) => {
    zip(entries, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/** Returns the filename to use when downloading `path` as a zip. Strips
 *  the trailing slash and uses the basename; root `/` falls back to a
 *  branded name so users don't end up with a nameless `.zip`. */
export function zipNameFor(path: string): string {
  if (path === '/') return 'cebian-vfs.zip';
  const base = path.split('/').filter(Boolean).pop() ?? 'cebian-vfs';
  return `${base}.zip`;
}
