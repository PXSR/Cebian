import { File, FileCode, FileText, type LucideIcon } from 'lucide-react';
import { normalizePath } from '@/lib/vfs';

export const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp',
  'pdf', 'zip', 'gz', 'tar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'ogg',
]);

const CODE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html']);

export function getHashPath(): string {
  const raw = window.location.hash.slice(1); // strip leading #
  return normalizePath(decodeURIComponent(raw) || '/');
}

export function navigateTo(path: string) {
  window.location.hash = '#' + encodeURIComponent(path);
}

export function parentOf(p: string): string {
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Pick the lucide icon component for a given file extension. Used by
 *  both DirView and FileView so the same `.md` file gets the same glyph
 *  in the listing and in its detail header. */
export function pickFileIcon(ext: string): LucideIcon {
  if (CODE_EXTS.has(ext)) return FileCode;
  if (ext === 'md') return FileText;
  return File;
}
