export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export type ViewState =
  | { kind: 'loading' }
  | { kind: 'dir'; path: string; entries: DirEntry[] }
  | { kind: 'file'; path: string; content: string; size: number; isBinary: boolean }
  | { kind: 'error'; path: string; message: string };
