import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Server } from '../core/config';
import { RemoteEntry, Transport, TransportError } from './types';

/**
 * "Local or mounted folder": remote paths are posix paths below `rootPath`, which is a local
 * directory. Path `/` maps to the filesystem root so that `rootPath` behaves like on other servers.
 */
export class LocalTransport implements Transport {
  connected = false;

  constructor(readonly server: Server) {}

  private abs(p: string): string {
    const segments = p.split('/').filter(Boolean);
    if (segments.length && /^[A-Za-z]:$/.test(segments[0])) {
      segments.shift(); // Windows drive letter kept from rootPath
    }
    return path.join(path.parse(this.server.rootPath || process.cwd()).root, ...segments);
  }

  async connect(): Promise<void> {
    if (!this.server.rootPath) {
      throw new TransportError(`${this.server.name}: folder is not specified`);
    }
    await fs.access(this.server.rootPath);
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async home(): Promise<string> {
    return this.server.rootPath.split(path.sep).join('/').replace(/^[A-Za-z]:/, '') || '/';
  }

  private async entry(p: string): Promise<RemoteEntry> {
    const abs = this.abs(p);
    const l = await fs.lstat(abs);
    const st = l.isSymbolicLink() ? await fs.stat(abs).catch(() => l) : l;
    return {
      name: path.posix.basename(p) || '/',
      path: p,
      isDir: st.isDirectory(),
      isSymlink: l.isSymbolicLink(),
      size: st.size,
      mtime: st.mtimeMs,
      mode: st.mode & 0o7777,
    };
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const names = await fs.readdir(this.abs(dir));
    return Promise.all(names.map((n) => this.entry(path.posix.join(dir, n))));
  }

  async stat(p: string): Promise<RemoteEntry | undefined> {
    try {
      return await this.entry(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw e;
    }
  }

  readFile(p: string): Promise<Buffer> {
    return fs.readFile(this.abs(p));
  }

  writeFile(p: string, data: Buffer): Promise<void> {
    return fs.writeFile(this.abs(p), data);
  }

  uploadFile(localPath: string, remotePath: string): Promise<void> {
    return fs.copyFile(localPath, this.abs(remotePath));
  }

  downloadFile(remotePath: string, localPath: string): Promise<void> {
    return fs.copyFile(this.abs(remotePath), localPath);
  }

  async mkdir(p: string): Promise<void> {
    await fs.mkdir(this.abs(p), { recursive: true });
  }

  deleteFile(p: string): Promise<void> {
    return fs.unlink(this.abs(p));
  }

  deleteDir(p: string): Promise<void> {
    return fs.rmdir(this.abs(p));
  }

  rename(from: string, to: string): Promise<void> {
    return fs.rename(this.abs(from), this.abs(to));
  }

  chmod(p: string, mode: number): Promise<void> {
    return fs.chmod(this.abs(p), mode);
  }

  async setMtime(p: string, mtimeMs: number): Promise<void> {
    const t = new Date(mtimeMs);
    await fs.utimes(this.abs(p), t, t);
  }
}
