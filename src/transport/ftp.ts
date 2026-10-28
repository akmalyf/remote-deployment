import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Client, FileInfo, FileType } from 'basic-ftp';
import * as vscode from 'vscode';
import { portOf, Server } from '../core/config';
import type { Credentials } from '../core/credentials';
import { RemoteEntry, Transport, TransportError } from './types';

function modeOf(info: FileInfo): number | undefined {
  const p = info.permissions;
  return p ? (p.user << 6) | (p.group << 3) | p.world : undefined;
}

const CERT_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/;
/** Hosts whose untrusted TLS certificate the user accepted in this session. */
const trustedHosts = new Set<string>();

async function confirmCertificate(s: Server, code: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `The TLS certificate of ${s.host}:${portOf(s)} is not trusted (${code}). Connect anyway for this session?`,
    { modal: true },
    'Connect',
  );
  if (answer === 'Connect') {
    trustedHosts.add(`${s.host}:${portOf(s)}`);
    return true;
  }
  return false;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** FTP and FTPS (explicit AUTH TLS or implicit). basic-ftp only supports passive data connections. */
export class FtpTransport implements Transport {
  private client?: Client;
  private homeDir = '/';
  private features = new Map<string, string>();
  connected = false;

  constructor(
    readonly server: Server,
    private readonly credentials: Credentials,
  ) {}

  async connect(): Promise<void> {
    const s = this.server;
    const client = new Client(s.timeoutSecs * 1000);
    const secure = s.type === 'ftps' ? (s.ftpsExplicit ? true : 'implicit') : false;
    let password = s.user === 'anonymous' ? 'anonymous@' : await this.credentials.obtain(s, 'password');
    if (password === undefined) {
      throw new TransportError('Password required');
    }
    let passwordRetried = false;
    for (;;) {
      try {
        await client.access({
          host: s.host,
          port: portOf(s),
          user: s.user || 'anonymous',
          password,
          secure,
          secureOptions: {
            rejectUnauthorized: !trustedHosts.has(`${s.host}:${portOf(s)}`),
            maxVersion: s.disableTls13 ? 'TLSv1.2' : undefined,
          },
        });
        break;
      } catch (e) {
        const code = (e as { code?: number | string }).code;
        if (typeof code === 'string' && CERT_ERRORS.test(code) && (await confirmCertificate(s, code))) {
          continue;
        }
        if (code === 530 && !passwordRetried && s.user !== 'anonymous') {
          passwordRetried = true;
          password = await this.credentials.obtain(s, 'password', true);
          if (password !== undefined) {
            continue;
          }
        }
        client.close();
        throw new TransportError(`${s.name}: ${(e as Error).message}`, code === undefined);
      }
    }
    if (s.type === 'ftps' && s.ftpsProtection === 'clear') {
      await client.send('PROT C').catch(() => undefined);
    }
    this.features = await client.features().catch(() => new Map());
    this.homeDir = await client.pwd().catch(() => '/');
    if (s.showHidden !== false) {
      // Ask the server for dot files where LIST is used; MLSD lists them anyway.
      client.availableListCommands = ['MLSD', 'LIST -a', 'LIST'];
    }
    this.client = client;
    this.connected = true;
    if (s.passive === false) {
      console.warn(`[deployment] ${s.name}: active FTP mode is not supported, using passive mode`);
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    this.client?.close();
    this.client = undefined;
  }

  private get c(): Client {
    if (!this.client || this.client.closed || !this.connected) {
      this.connected = false;
      throw new TransportError('Not connected', true);
    }
    return this.client;
  }

  async home(): Promise<string> {
    return this.homeDir;
  }

  private toEntry(dir: string, info: FileInfo): RemoteEntry {
    return {
      name: info.name,
      path: path.posix.join(dir, info.name),
      isDir: info.type === FileType.Directory,
      isSymlink: info.type === FileType.SymbolicLink,
      size: info.size,
      mtime: info.modifiedAt?.getTime() ?? 0,
      mode: modeOf(info),
      linkTarget: info.link || undefined,
    };
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const items = await this.c.list(dir);
    const out: RemoteEntry[] = [];
    for (const info of items) {
      if (info.name === '.' || info.name === '..') {
        continue;
      }
      const e = this.toEntry(dir, info);
      if (e.isSymlink) {
        // Treat links to folders as folders when the server lets us enter them.
        const isDir = await this.c
          .cd(e.path)
          .then(() => true)
          .catch(() => false);
        e.isDir = isDir;
      }
      out.push(e);
    }
    return out;
  }

  async stat(p: string): Promise<RemoteEntry | undefined> {
    if (p === '/') {
      return { name: '/', path: '/', isDir: true, isSymlink: false, size: 0, mtime: 0 };
    }
    if (this.features.has('MLST')) {
      try {
        const res = await this.c.send(`MLST ${p}`);
        const line = res.message.split(/\r?\n/).find((l) => /^\s.*;\s/.test(l) || /type=/i.test(l));
        if (line) {
          const facts = new Map<string, string>();
          const [factText] = line.trim().split(/; /);
          for (const f of factText.split(';')) {
            const [k, v] = f.split('=');
            if (k) {
              facts.set(k.toLowerCase(), v ?? '');
            }
          }
          const type = facts.get('type')?.toLowerCase() ?? 'file';
          const modify = facts.get('modify');
          return {
            name: path.posix.basename(p),
            path: p,
            isDir: type === 'dir' || type === 'cdir' || type === 'pdir',
            isSymlink: type.includes('link'),
            size: Number(facts.get('size') ?? 0),
            mtime: modify ? parseFtpTime(modify) : 0,
            // Some servers write the mode as "0o644".
            mode: facts.get('unix.mode') ? parseInt(facts.get('unix.mode')!.replace(/^0o/i, ''), 8) : undefined,
          };
        }
      } catch (e) {
        if ((e as { code?: number }).code === 550) {
          return undefined;
        }
      }
    }
    // Fallback: list the parent folder.
    const parent = path.posix.dirname(p);
    const name = path.posix.basename(p);
    try {
      const items = await this.list(parent);
      return items.find((i) => i.name === name);
    } catch (e) {
      if ((e as { code?: number }).code === 550) {
        return undefined;
      }
      throw e;
    }
  }

  async readFile(p: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => chunks.push(c));
    await this.c.downloadTo(sink, p);
    return Buffer.concat(chunks);
  }

  async writeFile(p: string, data: Buffer): Promise<void> {
    await this.c.uploadFrom(Readable.from(data), p);
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.c.uploadFrom(localPath, remotePath);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await this.c.downloadTo(localPath, remotePath);
  }

  async mkdir(p: string): Promise<void> {
    try {
      await this.c.send(`MKD ${p}`);
    } catch (e) {
      const st = await this.stat(p).catch(() => undefined);
      if (!st?.isDir) {
        throw e;
      }
    }
  }

  async deleteFile(p: string): Promise<void> {
    await this.c.remove(p);
  }

  async deleteDir(p: string): Promise<void> {
    await this.c.send(`RMD ${p}`);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.c.rename(from, to);
  }

  async chmod(p: string, mode: number): Promise<void> {
    await this.c.send(`SITE CHMOD ${mode.toString(8)} ${p}`);
  }

  async setMtime(p: string, mtimeMs: number): Promise<void> {
    const d = new Date(mtimeMs);
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    if (this.features.has('MFMT')) {
      await this.c.send(`MFMT ${stamp} ${p}`);
      return;
    }
    // Many servers accept MDTM with a timestamp argument, others SITE UTIME.
    await this.c.send(`MDTM ${stamp} ${p}`).catch(() => this.c.send(`SITE UTIME ${p} ${stamp} ${stamp} ${stamp} UTC`));
  }
}

export function parseFtpTime(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?/.exec(s);
  if (!m) {
    return 0;
  }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0);
}
