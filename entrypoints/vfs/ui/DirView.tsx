import { ArrowUp, ChevronRight, Folder } from 'lucide-react';
import { t } from '@/lib/i18n';
import { fileExtension, formatSize, navigateTo, parentOf, pickFileIcon } from '../lib/path-utils';
import type { DirEntry } from '../types';

export function DirView({ path, entries }: { path: string; entries: DirEntry[] }) {
  const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const sorted = [...dirs, ...files];
  const showUpNav = path !== '/';

  if (sorted.length === 0 && !showUpNav) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <Folder size={48} strokeWidth={1} className="opacity-30" />
        <span className="text-sm">{t('common.empty.folder')}</span>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
      {showUpNav && (
        <button
          onClick={() => navigateTo(parentOf(path))}
          className="group w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
        >
          <ArrowUp size={16} className="text-muted-foreground group-hover:text-primary transition-colors" />
          <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">..</span>
        </button>
      )}
      {sorted.map((entry) => {
        const fullPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
        const ext = fileExtension(entry.name);
        const FileGlyph = pickFileIcon(ext);
        return (
          <button
            key={entry.name}
            onClick={() => navigateTo(fullPath)}
            className="group w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
          >
            {entry.isDir ? (
              <Folder size={18} strokeWidth={1.5} className="shrink-0 text-primary/80 group-hover:text-primary transition-colors" />
            ) : (
              <FileGlyph size={18} strokeWidth={1.5} className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
            )}
            <span className="flex-1 text-sm truncate text-foreground/90 group-hover:text-foreground transition-colors">
              {entry.name}
            </span>
            {!entry.isDir && (
              <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
                {formatSize(entry.size)}
              </span>
            )}
            {entry.isDir && (
              <ChevronRight size={14} className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
            )}
          </button>
        );
      })}
    </div>
  );
}
