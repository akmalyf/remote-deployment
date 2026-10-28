import type { Server } from '../core/config';

export interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  /** Milliseconds since epoch, 0 when unknown. */
  mtime: number;
  /** Unix permission bits, when the protocol reports them. */
  mode?: number;
  linkTarget?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * One connection to a deployment server. Paths are absolute posix paths on the server.
 * Implementations are not required to support concurrent calls; the pool serializes them.
 */
export interface Transport {
  readonly server: Server;
  readonly connected: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Initial directory after login, used to autodetect the root path. */
  home(): Promise<string>;
  list(dir: string): Promise<RemoteEntry[]>;
  /** undefined when the path does not exist. */
  stat(p: string): Promise<RemoteEntry | undefined>;
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  /** Create one directory level; succeeds when it already exists. */
  mkdir(p: string): Promise<void>;
  deleteFile(p: string): Promise<void>;
  /** Remove an empty directory. */
  deleteDir(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod?(p: string, mode: number): Promise<void>;
  setMtime?(p: string, mtimeMs: number): Promise<void>;
  exec?(command: string): Promise<ExecResult>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly connectionLost = false,
  ) {
    super(message);
  }
}

const CONNECTION_ERRORS = /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTCONN|socket hang up|Not connected|Client is closed|No response from server|connection lost|Connection closed|Timeout/i;

export function isConnectionError(error: unknown): boolean {
  if (error instanceof TransportError) {
    return error.connectionLost;
  }
  const e = error as { code?: string; message?: string };
  return CONNECTION_ERRORS.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
