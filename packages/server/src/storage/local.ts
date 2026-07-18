import fs from 'node:fs/promises';
import path from 'node:path';
import type { StorageBackend, FileEntry, FileStat } from './backend';

export class LocalStorageBackend implements StorageBackend {
  async read(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  async write(filePath: string, content: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  async list(dir: string): Promise<FileEntry[]> {
    const names = await fs.readdir(dir);
    const entries = await Promise.all(
      names.map(async (name) => {
        const fullPath = path.join(dir, name);
        const stat = await fs.stat(fullPath);
        return {
          name,
          path: fullPath,
          isDirectory: stat.isDirectory(),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        };
      })
    );
    return entries;
  }

  async delete(filePath: string): Promise<void> {
    await fs.rm(filePath, { recursive: true, force: true });
  }

  async stat(filePath: string): Promise<FileStat> {
    const s = await fs.stat(filePath);
    return {
      size: s.size,
      isDirectory: s.isDirectory(),
      modifiedAt: s.mtimeMs,
    };
  }
}