import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileStat, WebDAVClient } from 'webdav' with { 'resolution-mode': 'import' };
import { portOf, Server } from '../core/config';
import type { Credentials } from '../core/credentials';
import { RemoteEntry, Transport, TransportError } from './types';

/** WebDAV over HTTP(S). chmod and timestamps are not supported by the protocol. */
export class WebdavTransport implements Transport {
  private client?: WebDAVClient;
  connected = false;

  constructor(
    readonly server: Server,
    private readonly credentials: Credentials,
  ) {}

  private baseUrl(): string {
    const s = this.server;
    if (/^https?:\/\//.test(s.host)) {
      return s.host.replace(/\/+$/, '');
    }
    const scheme = s.ssl ? 'https' : 'http';
    const port = portOf(s);
    const defaultPort = s.ssl ? 443 : 80;
    return `${scheme}://${s.host}${port === defaultPort ? '' : `:${port}`}`;
  }

  async connect(): Promise<void> {
    const { createClient } = await import('webdav');
    const s = this.server;
    let password = s.user ? await this.credentials.obtain(s, 'password') : undefined;
    for (let attempt = 0; ; attempt++) {
      const client = createClient(this.baseUrl(), s.user ? { username: s.user, password: password ?? '' } : {});
      try {
        await client.getDirectoryContents(s.rootPath || '/');
        this.client = client;
        this.connected = true;
        return;
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 401 && attempt === 0 && s.user) {
          password = await this.credentials.obtain(s, 'password', true);
          if (password !== undefined) {
            continue;
          }
        }
        throw new TransportError(`${s.name}: ${(e as Error).message}`, status === undefined);
      }
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    this.client = undefined;
  }

  private get c(): WebDAVClient {
    if (!this.client) {
      throw new TransportError('Not connected', true);
    }
    return this.client;
  }

  async home(): Promise<string> {
    return '/';
  }

  private toEntry(st: FileStat): RemoteEntry {
    const p = st.filename.replace(/\/+$/, '') || '/';
    return {
      name: st.basename || path.posix.basename(p),
      path: p,
      isDir: st.type === 'directory',
      isSymlink: false,
      size: st.size,
      mtime: st.lastmod ? Date.parse(st.lastmod) || 0 : 0,
    };
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const items = (await this.c.getDirectoryContents(dir)) as FileStat[];
    return items.map((i) => this.toEntry(i));
  }

  async stat(p: string): Promise<RemoteEntry | undefined> {
    try {
      return this.toEntry((await this.c.stat(p)) as FileStat);
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        return undefined;
      }
      throw e;
    }
  }

  async readFile(p: string): Promise<Buffer> {
    const data = await this.c.getFileContents(p, { format: 'binary' });
    return Buffer.from(data as ArrayBuffer);
  }

  async writeFile(p: string, data: Buffer): Promise<void> {
    await this.c.putFileContents(p, data, { overwrite: true });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const size = fs.statSync(localPath).size;
    await this.c.putFileContents(remotePath, fs.createReadStream(localPath), { overwrite: true, contentLength: size });
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await pipeline(this.c.createReadStream(remotePath) as unknown as NodeJS.ReadableStream, fs.createWriteStream(localPath));
  }

  async mkdir(p: string): Promise<void> {
    try {
      await this.c.createDirectory(p);
    } catch (e) {
      const st = await this.stat(p).catch(() => undefined);
      if (!st?.isDir) {
        throw e;
      }
    }
  }

  async deleteFile(p: string): Promise<void> {
    await this.c.deleteFile(p);
  }

  async deleteDir(p: string): Promise<void> {
    await this.c.deleteFile(p);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.c.moveFile(from, to, { overwrite: true });
  }
}
