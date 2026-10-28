import * as vscode from 'vscode';
import { Server } from '../core/config';
import { Credentials } from '../core/credentials';
import { FtpTransport } from './ftp';
import { LocalTransport } from './local';
import { SftpTransport } from './sftp';
import { isConnectionError, Transport } from './types';
import { WebdavTransport } from './webdav';

export function createTransport(server: Server, credentials: Credentials): Transport {
  switch (server.type) {
    case 'sftp':
      return new SftpTransport(server, credentials);
    case 'ftp':
    case 'ftps':
      return new FtpTransport(server, credentials);
    case 'webdav':
      return new WebdavTransport(server, credentials);
    case 'local':
      return new LocalTransport(server);
  }
}

function connectionKey(server: Server): string {
  const { mappings: _m, excludedPaths: _e, name: _n, global: _g, webUrl: _w, ...connection } = server;
  return JSON.stringify(connection);
}

/** A connection with its calls serialized (FTP cannot run two commands at once). */
export class Session {
  private queue: Promise<unknown> = Promise.resolve();
  private connecting?: Promise<void>;
  lastUsed = Date.now();

  constructor(readonly transport: Transport) {}

  get server(): Server {
    return this.transport.server;
  }

  private async ensure(): Promise<void> {
    if (this.transport.connected) {
      return;
    }
    this.connecting ??= this.transport.connect().finally(() => (this.connecting = undefined));
    await this.connecting;
  }

  /** Run `fn` exclusively; on a dropped connection reconnect once and retry. */
  run<T>(fn: (t: Transport) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      this.lastUsed = Date.now();
      await this.ensure();
      try {
        return await fn(this.transport);
      } catch (e) {
        if (!isConnectionError(e)) {
          throw e;
        }
        await this.transport.close().catch(() => undefined);
        await this.ensure();
        return fn(this.transport);
      } finally {
        this.lastUsed = Date.now();
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

export class ConnectionPool implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly credentials: Credentials) {
    this.timer = setInterval(() => this.closeIdle(), 30_000);
  }

  get(server: Server): Session {
    const key = connectionKey(server);
    let s = this.sessions.get(key);
    if (!s) {
      s = new Session(createTransport(server, this.credentials));
      this.sessions.set(key, s);
      this.emitter.fire();
    }
    return s;
  }

  run<T>(server: Server, fn: (t: Transport) => Promise<T>): Promise<T> {
    return this.get(server).run(fn);
  }

  isConnected(server: Server): boolean {
    return this.sessions.get(connectionKey(server))?.transport.connected ?? false;
  }

  /** A fresh, unpooled connection for parallel transfers or a connection test. */
  fresh(server: Server): Session {
    return new Session(createTransport(server, this.credentials));
  }

  async disconnect(server?: Server): Promise<void> {
    for (const [key, s] of this.sessions) {
      if (!server || key === connectionKey(server)) {
        this.sessions.delete(key);
        await s.close().catch(() => undefined);
      }
    }
    this.emitter.fire();
  }

  private closeIdle(): void {
    const idle = vscode.workspace.getConfiguration('remoteDeployment').get<number>('connectionIdleTimeout', 300) * 1000;
    for (const [key, s] of this.sessions) {
      if (Date.now() - s.lastUsed > idle) {
        this.sessions.delete(key);
        void s.close().catch(() => undefined);
        this.emitter.fire();
      }
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    void this.disconnect();
    this.emitter.dispose();
  }
}
