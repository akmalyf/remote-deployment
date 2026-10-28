import * as vscode from 'vscode';
import type { Server } from './config';
import { Credentials } from './credentials';

export interface Revision {
  /** Remote state right after our last upload/download. */
  mtime: number;
  size: number;
}

const KEY = 'deploy.revisions';
const MAX = 20_000;

/**
 * Remembers the remote state of files we transferred, so a later upload can tell whether the
 * server copy was changed by someone else ("Warn when uploading over newer file") and opening a
 * file can report remote changes.
 */
export class RevisionTracker {
  private data: Record<string, Revision>;
  private dirty = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly state: vscode.Memento) {
    this.data = state.get<Record<string, Revision>>(KEY) ?? {};
  }

  private key(server: Server, remotePath: string): string {
    return `${Credentials.account(server)}${remotePath}`;
  }

  get(server: Server, remotePath: string): Revision | undefined {
    return this.data[this.key(server, remotePath)];
  }

  set(server: Server, remotePath: string, rev: Revision): void {
    const k = this.key(server, remotePath);
    delete this.data[k]; // re-insert to keep recency order
    this.data[k] = rev;
    this.schedule();
  }

  delete(server: Server, remotePath: string): void {
    const prefix = this.key(server, remotePath);
    for (const k of Object.keys(this.data)) {
      if (k === prefix || k.startsWith(prefix + '/')) {
        delete this.data[k];
      }
    }
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    this.timer ??= setTimeout(() => void this.flush(), 2000);
  }

  async flush(): Promise<void> {
    this.timer = undefined;
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    const keys = Object.keys(this.data);
    if (keys.length > MAX) {
      for (const k of keys.slice(0, keys.length - MAX)) {
        delete this.data[k];
      }
    }
    await this.state.update(KEY, this.data);
  }
}
