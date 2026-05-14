import { CopyButton } from '@/components/common/CopyButton';
import { t } from '@/lib/i18n';
import { fileExtension, formatSize, pickFileIcon } from '../lib/path-utils';

export function FileView({ path, content, size, isBinary }: { path: string; content: string; size: number; isBinary: boolean }) {
  const name = path.split('/').pop() ?? path;
  const ext = fileExtension(name);
  const Icon = pickFileIcon(ext);
  const lineCount = content.length === 0 ? 0 : content.split('\n').length;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* File header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-card border-b border-border">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon size={18} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">{name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Copy is hidden for binary files — `content` is the localized
           *  "[Binary file — N KB]" placeholder, which there's no point
           *  copying. Download still works through the App-header button. */}
          {!isBinary && <CopyButton text={content} />}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{t('vfs.lines', [lineCount])}</span>
            <span className="text-border">·</span>
            <span className="tabular-nums">{formatSize(size)}</span>
          </div>
        </div>
      </div>
      {/* Content */}
      <div className="relative overflow-auto max-h-[calc(100vh-12rem)]">
        <pre className="p-4 text-[13px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap wrap-break-word selection:bg-primary/20">
          {content}
        </pre>
      </div>
    </div>
  );
}
