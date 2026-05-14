export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** Discriminated union of file rendering modes. The loader picks the type
 *  via `classifyFile` + size check; `FileView` switches on `type`. */
export type FileMedia =
  | { type: 'text'; content: string; size: number }
  | { type: 'markdown'; content: string; size: number }
  | { type: 'image'; mime: string; size: number }
  | { type: 'video'; mime: string; size: number }
  | { type: 'audio'; mime: string; size: number }
  | { type: 'binary'; size: number }
  | { type: 'tooLarge'; size: number };

export type ViewState =
  | { kind: 'loading' }
  | { kind: 'dir'; path: string; entries: DirEntry[] }
  | { kind: 'file'; path: string; media: FileMedia }
  | { kind: 'error'; path: string; message: string };
