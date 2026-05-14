import { CopyButton } from '@/components/common/CopyButton';
import { t } from '@/lib/i18n';
import { fileExtension, formatSize, pickFileIcon } from '../lib/path-utils';
import type { FileMedia } from '../types';

export function FileView({ path, media }: { path: string; media: FileMedia }) {
  const name = path.split('/').pop() ?? path;
  const ext = fileExtension(name);
  const Icon = pickFileIcon(ext);

  // Header is shared across all media types; per-type bits (copy button,
  // line count) live behind the switch below.
  const renderHeader = (right: React.ReactNode) => (
    <div className="flex items-center justify-between px-4 py-2.5 bg-card border-b border-border">
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon size={18} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium truncate">{name}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  );

  switch (media.type) {
    case 'text':
    case 'markdown': {
      // Task 2 bridge: render both text and markdown as a raw `<pre>`.
      // Task 4 will add the markdown preview / source toggle.
      const lineCount = media.content.length === 0 ? 0 : media.content.split('\n').length;
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(
            <>
              <CopyButton text={media.content} />
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">{t('vfs.lines', [lineCount])}</span>
                <span className="text-border">·</span>
                <span className="tabular-nums">{formatSize(media.size)}</span>
              </div>
            </>,
          )}
          <div className="relative overflow-auto max-h-[calc(100vh-12rem)]">
            <pre className="p-4 text-[13px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap wrap-break-word selection:bg-primary/20">
              {media.content}
            </pre>
          </div>
        </div>
      );
    }
    case 'binary':
    case 'image':
    case 'video':
    case 'audio':
      // Task 2 placeholder: image/video/audio share the binary placeholder
      // until Task 4 lights up real renderers. Header shows just the size
      // (no line count, no copy — there's nothing meaningful to copy).
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(
            <span className="text-xs text-muted-foreground tabular-nums">{formatSize(media.size)}</span>,
          )}
          <div className="p-4 text-[13px] text-muted-foreground italic">
            {t('vfs.binaryFile', [formatSize(media.size)])}
          </div>
        </div>
      );
    case 'tooLarge':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(
            <span className="text-xs text-muted-foreground tabular-nums">{formatSize(media.size)}</span>,
          )}
          <div className="p-4 text-[13px] text-muted-foreground">
            {t('vfs.tooLargeToPreview', [formatSize(media.size)])}
          </div>
        </div>
      );
    default: {
      // Exhaustiveness guard — if a new FileMedia variant is added without
      // a matching case, TS will flag this assignment at compile time
      // rather than letting React silently render `undefined` at runtime.
      const _exhaustive: never = media;
      return _exhaustive;
    }
  }
}
