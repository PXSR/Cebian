import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Download, Loader2 } from 'lucide-react';
import { vfs } from '@/lib/vfs';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/storage';
import { downloadFile } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { t } from '@/lib/i18n';
import { applyTheme, resolveTheme } from './lib/theme';
import { BINARY_EXTS, fileExtension, formatSize, getHashPath, navigateTo } from './lib/path-utils';
import { zipDirectory, zipNameFor } from './lib/download';
import { Breadcrumbs } from './ui/Breadcrumbs';
import { DirView } from './ui/DirView';
import { FileView } from './ui/FileView';
import type { ViewState } from './types';

export default function App() {
  const [theme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  // Global busy flag for the download button. Kept outside `view` because a
  // download started on `/prompts` MUST keep running even if the user
  // navigates away mid-zip (decision A: don't interrupt explicit downloads).
  // The handler captures its target path from the closure at click time, so
  // the in-flight task is independent of subsequent view changes.
  const [isDownloading, setIsDownloading] = useState(false);

  // ── Theme sync ──
  useEffect(() => {
    themePreference.getValue().then((val) => {
      applyTheme(resolveTheme(val ?? 'system'));
      setThemeReady(true);
    });
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    applyTheme(resolveTheme(theme));
  }, [theme, themeReady]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // ── Load path from hash ──
  useEffect(() => {
    if (!themeReady) return;
    let stale = false;

    async function loadPath() {
      const p = getHashPath();
      setView({ kind: 'loading' });

      try {
        const st = await vfs.stat(p);

        if (st.isDirectory()) {
          const names = await vfs.readdir(p);
          const entries = await Promise.all(
            names.map(async (name) => {
              const childPath = p === '/' ? `/${name}` : `${p}/${name}`;
              try {
                const childStat = await vfs.stat(childPath);
                return { name, isDir: childStat.isDirectory(), size: childStat.size };
              } catch {
                return { name, isDir: false, size: 0 };
              }
            }),
          );

          if (!stale) setView({ kind: 'dir', path: p, entries });
        } else {
          const ext = fileExtension(p.split('/').pop() ?? '');
          if (BINARY_EXTS.has(ext)) {
            if (!stale) setView({ kind: 'file', path: p, content: t('vfs.binaryFile', [formatSize(st.size)]), size: st.size, isBinary: true });
          } else {
            const raw = (await vfs.readFile(p, 'utf8')) as unknown as string;
            if (!stale) setView({ kind: 'file', path: p, content: raw, size: st.size, isBinary: false });
          }
        }
      } catch (err: any) {
        if (stale) return;
        const message =
          err?.code === 'ENOENT'
            ? t('vfs.pathNotFound', [p])
            : err?.message ?? t('vfs.unknownError');
        setView({ kind: 'error', path: p, message });
      }
    }

    loadPath();
    window.addEventListener('hashchange', loadPath);
    return () => {
      stale = true;
      window.removeEventListener('hashchange', loadPath);
    };
  }, [themeReady]);

  // ── Download (file or zipped folder) ──
  //
  // Snapshots `view` into a const before the first await so a concurrent
  // hashchange that flips us to a different path can't redirect the
  // download to the wrong content. We intentionally do NOT abort on
  // navigation — see the `isDownloading` declaration comment.
  async function handleDownload() {
    if (isDownloading) return;
    const snapshot = view;
    if (snapshot.kind !== 'file' && snapshot.kind !== 'dir') return;

    setIsDownloading(true);
    try {
      if (snapshot.kind === 'file') {
        const data = (await vfs.readFile(snapshot.path)) as unknown as Uint8Array;
        const name = snapshot.path.split('/').pop() || 'file';
        // Wrap in Blob — `downloadFile` accepts ArrayBuffer/Blob/string but
        // not Uint8Array directly. The `as BlobPart` cast is required: the
        // current TS DOM lib types `Uint8Array<ArrayBufferLike>` which
        // includes SharedArrayBuffer, but BlobPart only accepts plain
        // ArrayBuffer-backed views. The vfs always hands us regular
        // ArrayBuffer, so the cast is sound. Generic octet-stream mime
        // keeps the browser from rewriting the extension (e.g. .md → .txt).
        downloadFile(name, new Blob([data as BlobPart], { type: 'application/octet-stream' }), 'application/octet-stream');
      } else {
        const data = await zipDirectory(snapshot.path);
        downloadFile(zipNameFor(snapshot.path), new Blob([data as BlobPart], { type: 'application/zip' }), 'application/zip');
      }
    } catch (err) {
      console.error('[vfs.download]', err);
      toast.error(t('common.downloadFailed'));
    } finally {
      setIsDownloading(false);
    }
  }

  // ── Render ──

  if (!themeReady) return null;

  const currentPath = view.kind !== 'loading' ? view.path : getHashPath();

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen bg-background text-foreground">
        {/* Header */}
        <header className="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-base font-semibold tracking-tight">VFS</span>
            <span className="text-xs text-muted-foreground/50 font-mono">cebian</span>
          </div>
          <div className="h-4 w-px bg-border shrink-0" />
          <div className="flex-1 min-w-0">
            <Breadcrumbs path={currentPath} />
          </div>
          {/* Keep the button mounted while a download is in flight, even if
           *  `view` has flipped to `loading` because the user navigated
           *  away — otherwise the spinner unmounts and the user loses the
           *  busy indicator until the download finishes. Hidden only on
           *  `error` (nothing to download) and on a clean `loading` state
           *  with no active download. */}
          {(view.kind === 'file' || view.kind === 'dir' || isDownloading) && (
            <button
              onClick={handleDownload}
              disabled={isDownloading}
              title={isDownloading ? t('vfs.zipping') : t('common.download')}
              aria-label={isDownloading ? t('vfs.zipping') : t('common.download')}
              className="shrink-0 size-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              {isDownloading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
            </button>
          )}
        </header>

        {/* Main content */}
        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-5">
            {view.kind === 'loading' && (
              <div className="flex items-center justify-center py-20">
                <div className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            )}

            {view.kind === 'dir' && <DirView path={view.path} entries={view.entries} />}

            {view.kind === 'file' && <FileView path={view.path} content={view.content} size={view.size} isBinary={view.isBinary} />}

            {view.kind === 'error' && (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <span className="text-destructive text-lg">!</span>
                </div>
                <p className="text-sm text-muted-foreground">{view.message}</p>
                <button
                  onClick={() => navigateTo('/')}
                  className="mt-2 text-xs text-primary hover:underline"
                >
                  {t('vfs.backToRoot')}
                </button>
              </div>
            )}
          </div>
        </main>
        <Toaster theme={resolveTheme(theme)} />
      </div>
    </TooltipProvider>
  );
}
