import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client, ConnectConfig, SFTPWrapper, Stats } from 'ssh2';
import type { AuthenticationType, AnyAuthMethod } from 'ssh2';
import { portOf, Server } from '../core/config';
import type { Credentials } from '../core/credentials';
import { agentSocket, expandHome, resolveOpenSshHost, verifyHostKey } from '../core/ssh';
import { ExecResult, RemoteEntry, shellQuote, Transport, TransportError } from './types';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  config: ConnectConfig;
}

/**
 * Resolve how to reach and authenticate to an SSH server (also used by the SSH terminal).
 * Auth methods are tried in order: agent, key, password (prompting when needed).
 */
export async function sshConnectConfig(server: Server, credentials: Credentials): Promise<SshTarget> {
  let host = server.host;
  let port = portOf(server);
  let user = server.user;
  const methods: (() => Promise<AnyAuthMethod | undefined>)[] = [];
  const keyMethod = (keyPath: string) => async (): Promise<AnyAuthMethod | undefined> => {
    let key: Buffer;
    try {
      key = fs.readFileSync(expandHome(keyPath));
    } catch {
      return undefined;
    }
    const encrypted = keyIsEncrypted(key);
    const passphrase = encrypted ? await credentials.obtain({ ...server, keyPath }, 'passphrase') : undefined;
    if (encrypted && passphrase === undefined) {
      return undefined;
    }
    return { type: 'publickey', username: user, key, passphrase };
  };
  const agent = agentSocket();
  switch (server.auth) {
    case 'agent':
      if (agent) {
        methods.push(async () => ({ type: 'agent', username: user, agent }));
      }
      break;
    case 'key':
      if (server.keyPath) {
        methods.push(keyMethod(server.keyPath));
      }
      break;
    case 'openSsh': {
      const resolved = resolveOpenSshHost(server.host);
      host = resolved.hostName ?? host;
      port = server.port ?? resolved.port ?? port;
      user = server.user || resolved.user || process.env.USER || '';
      const sock = resolved.identityAgent ?? agent;
      if (sock && sock !== 'none') {
        methods.push(async () => ({ type: 'agent', username: user, agent: sock }));
      }
      for (const f of resolved.identityFiles) {
        methods.push(keyMethod(f));
      }
      break;
    }
  }
  methods.push(async () => {
    const password = await credentials.obtain(server, 'password');
    return password === undefined ? undefined : { type: 'password', username: user, password };
  });
  let passwordTried = false;
  const authHandler = (_left: AuthenticationType[], _partial: boolean, next: (m: AnyAuthMethod | false) => void): void => {
    const tryNext = async (): Promise<void> => {
      const method = methods.shift();
      if (!method) {
        next(false);
        return;
      }
      const result = await method().catch(() => undefined);
      if (!result) {
        return tryNext();
      }
      if (result.type === 'password' && !passwordTried) {
        passwordTried = true;
        // A stored password may be stale: when it is rejected, ask once more.
        methods.push(async () => {
          const again = await credentials.obtain(server, 'password', true);
          return again === undefined ? undefined : { type: 'password', username: user, password: again };
        });
      }
      next(result);
    };
    void tryNext();
  };
  const config: ConnectConfig = {
    host,
    port,
    username: user,
    readyTimeout: server.timeoutSecs * 1000,
    keepaliveInterval: (server.keepAliveSecs ?? 30) * 1000,
    authHandler: authHandler as ConnectConfig['authHandler'],
    hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
      void verifyHostKey(host, port, key).then(verify, () => verify(false));
    }) as ConnectConfig['hostVerifier'],
  };
  return { host, port, user, config };
}

function keyIsEncrypted(key: Buffer): boolean {
  const text = key.toString('latin1');
  if (text.includes('Proc-Type: 4,ENCRYPTED') || text.includes('BEGIN ENCRYPTED PRIVATE KEY')) {
    return true;
  }
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END/.exec(text);
  if (m) {
    const blob = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    // "openssh-key-v1\0" + string ciphername
    const len = blob.readUInt32BE(15);
    return blob.subarray(19, 19 + len).toString() !== 'none';
  }
  return false;
}

export class SftpTransport implements Transport {
  private client?: Client;
  private sftp?: SFTPWrapper;
  private homeDir = '/';
  connected = false;

  constructor(
    readonly server: Server,
    private readonly credentials: Credentials,
  ) {}

  async connect(): Promise<void> {
    const target = await sshConnectConfig(this.server, this.credentials);
    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', (e) => reject(new TransportError(`${this.server.name}: ${e.message}`, true)));
      client.connect(target.config);
    });
    client.on('close', () => {
      this.connected = false;
    });
    client.on('error', () => {
      this.connected = false;
    });
    this.client = client;
    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((e, s) => (e ? reject(e) : resolve(s))));
    this.homeDir = await new Promise<string>((resolve) => this.sftp!.realpath('.', (e, p) => resolve(e ? '/' : p)));
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.sftp?.end();
    this.client?.end();
    this.client = undefined;
    this.sftp = undefined;
  }

  private get s(): SFTPWrapper {
    if (!this.sftp || !this.connected) {
      throw new TransportError('Not connected', true);
    }
    return this.sftp;
  }

  private call<T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))));
  }

  async home(): Promise<string> {
    return this.homeDir;
  }

  private entry(p: string, name: string, st: Stats, linkTarget?: string): RemoteEntry {
    const type = st.mode & S_IFMT;
    return {
      name,
      path: p,
      isDir: type === S_IFDIR,
      isSymlink: type === S_IFLNK,
      size: st.size,
      mtime: st.mtime * 1000,
      mode: st.mode & 0o7777,
      linkTarget,
    };
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const items = await this.call<{ filename: string; attrs: Stats }[]>((cb) => this.s.readdir(dir, cb));
    const out: RemoteEntry[] = [];
    for (const it of items) {
      if (it.filename === '.' || it.filename === '..') {
        continue;
      }
      const p = path.posix.join(dir, it.filename);
      let e = this.entry(p, it.filename, it.attrs);
      if (e.isSymlink) {
        // Follow links so linked folders can be browsed.
        const target = await this.call<Stats>((cb) => this.s.stat(p, cb)).catch(() => undefined);
        if (target) {
          e = { ...this.entry(p, it.filename, target), isSymlink: true };
        }
      }
      out.push(e);
    }
    return out;
  }

  async stat(p: string): Promise<RemoteEntry | undefined> {
    try {
      const st = await this.call<Stats>((cb) => this.s.stat(p, cb));
      return this.entry(p, path.posix.basename(p), st);
    } catch (e) {
      if ((e as { code?: number }).code === 2) {
        return undefined;
      }
      throw e;
    }
  }

  async readFile(p: string): Promise<Buffer> {
    return this.call<Buffer>((cb) => this.s.readFile(p, cb));
  }

  async writeFile(p: string, data: Buffer): Promise<void> {
    if (this.server.sudo) {
      return this.sudoPut(p, async (tmp) => this.call<void>((cb) => this.s.writeFile(tmp, data, cb)));
    }
    await this.call<void>((cb) => this.s.writeFile(p, data, cb));
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    if (this.server.sudo) {
      return this.sudoPut(remotePath, async (tmp) => this.call<void>((cb) => this.s.fastPut(localPath, tmp, cb)));
    }
    await this.call<void>((cb) => this.s.fastPut(localPath, remotePath, cb));
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await this.call<void>((cb) => this.s.fastGet(remotePath, localPath, cb));
  }

  async mkdir(p: string): Promise<void> {
    if (this.server.sudo) {
      return this.sudo(`mkdir -p ${shellQuote(p)}`);
    }
    try {
      await this.call<void>((cb) => this.s.mkdir(p, cb));
    } catch (e) {
      const st = await this.stat(p).catch(() => undefined);
      if (!st?.isDir) {
        throw e;
      }
    }
  }

  async deleteFile(p: string): Promise<void> {
    if (this.server.sudo) {
      return this.sudo(`rm -f ${shellQuote(p)}`);
    }
    await this.call<void>((cb) => this.s.unlink(p, cb));
  }

  async deleteDir(p: string): Promise<void> {
    if (this.server.sudo) {
      return this.sudo(`rmdir ${shellQuote(p)}`);
    }
    await this.call<void>((cb) => this.s.rmdir(p, cb));
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.server.sudo) {
      return this.sudo(`mv -f ${shellQuote(from)} ${shellQuote(to)}`);
    }
    try {
      await this.call<void>((cb) => this.s.ext_openssh_rename(from, to, cb));
    } catch {
      await this.call<void>((cb) => this.s.rename(from, to, cb));
    }
  }

  async chmod(p: string, mode: number): Promise<void> {
    if (this.server.sudo) {
      return this.sudo(`chmod ${mode.toString(8)} ${shellQuote(p)}`);
    }
    await this.call<void>((cb) => this.s.chmod(p, mode, cb));
  }

  async setMtime(p: string, mtimeMs: number): Promise<void> {
    const t = Math.floor(mtimeMs / 1000);
    if (this.server.sudo) {
      return this.sudo(`touch -m -d @${t} ${shellQuote(p)}`);
    }
    await this.call<void>((cb) => this.s.utimes(p, t, t, cb));
  }

  exec(command: string): Promise<ExecResult> {
    const client = this.client;
    if (!client || !this.connected) {
      return Promise.reject(new TransportError('Not connected', true));
    }
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => (stdout += d.toString()));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        stream.on('close', (code: number | null) => resolve({ code: code ?? 0, stdout, stderr }));
      });
    });
  }

  private async sudo(command: string): Promise<void> {
    const r = await this.exec(`sudo -n ${command}`);
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() || `sudo exited with ${r.code}`);
    }
  }

  /** Write to a temp file as the login user, then move it into place with sudo (keeps the owner of an existing file). */
  private async sudoPut(dest: string, write: (tmp: string) => Promise<void>): Promise<void> {
    const tmp = `/tmp/.vscode-deploy-${process.pid}-${Date.now()}`;
    await write(tmp);
    try {
      await this.sudo(`sh -c ${shellQuote(`cat ${shellQuote(tmp)} > ${shellQuote(dest)}`)}`);
    } finally {
      await this.call<void>((cb) => this.s.unlink(tmp, cb)).catch(() => undefined);
    }
  }
}
