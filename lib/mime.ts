/**
 * MIME type ↔ file extension lookup. Used by the VFS file preview loader
 * (to build object URLs for image/video/audio media) and by the fs_save_url
 * tool (to derive a fallback filename when neither Content-Disposition nor
 * the URL pathname carry an extension).
 *
 * Kept deliberately small. The map covers the media types Cebian renders
 * inline plus the most common textual types — anything else falls back to
 * `application/octet-stream` (forward) or `bin` (reverse).
 */

/** Canonical extension → MIME mapping. */
export const MIME_MAP: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

/** Map a file extension to a MIME type. Unknown extensions return the
 *  generic `application/octet-stream` so callers (e.g. Blob construction)
 *  always have a usable string. */
export function mimeFor(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Lazy reverse map: MIME → extension. Built once on first access. The
 *  reverse direction is many-to-one for some MIMEs (jpg / jpeg both map to
 *  image/jpeg), so we pick the first key seen as the canonical extension
 *  — which means MIME_MAP's declaration order matters for the reverse
 *  direction. Extra textual types not in MIME_MAP are added explicitly. */
let _extByMime: Map<string, string> | null = null;
function reverseMap(): Map<string, string> {
  if (_extByMime) return _extByMime;
  const m = new Map<string, string>();
  for (const [ext, mime] of Object.entries(MIME_MAP)) {
    if (!m.has(mime)) m.set(mime, ext);
  }
  // Common textual types not worth listing in MIME_MAP (we don't render
  // them inline beyond plain `<pre>`), but useful for filename derivation.
  m.set('text/plain', 'txt');
  m.set('text/html', 'html');
  m.set('text/css', 'css');
  m.set('text/markdown', 'md');
  m.set('text/csv', 'csv');
  m.set('application/json', 'json');
  m.set('application/xml', 'xml');
  m.set('text/xml', 'xml');
  m.set('application/javascript', 'js');
  m.set('application/typescript', 'ts');
  m.set('application/pdf', 'pdf');
  m.set('application/zip', 'zip');
  m.set('application/gzip', 'gz');
  m.set('application/x-tar', 'tar');
  m.set('application/x-yaml', 'yaml');
  m.set('text/yaml', 'yaml');
  m.set('application/octet-stream', 'bin');
  _extByMime = m;
  return m;
}

/** Map a MIME type to a representative file extension (no leading dot).
 *  Unknown types fall back to `bin`. Case-insensitive on the MIME. */
export function extensionForMime(mime: string): string {
  return reverseMap().get(mime.toLowerCase()) ?? 'bin';
}
