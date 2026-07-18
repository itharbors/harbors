export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export interface FileStat {
  size: number;
  isDirectory: boolean;
  modifiedAt: number;
}

export interface StorageBackend {
  read(path: string): Promise<Buffer>;
  write(path: string, content: Buffer): Promise<void>;
  list(dir: string): Promise<FileEntry[]>;
  delete(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
}