import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Server } from '../core/config';
import type { Project, Projects } from '../core/project';
import type { RevisionTracker } from '../core/revisions';
import type { ConnectionPool } from '../transport/pool';
import type { RemoteEntry } from '../transport/types';

export const REMOTE_SCHEME = 'deploy-remote';
export const SNAPSHOT_SCHEME = 'deploy-snapshot';

/**
 * deploy-remote://<server slug>/<abs path>?server=<name>&project=<folder uri>
 *
 * The server name lives in the query: VS Code lower-cases the authority when a uri is
 * serialized, and names with spaces or ":" are not valid authorities. The authority only
 * keeps a readable slug for tooltips.
 */
export function remoteUri(project: Project, server: Server, remotePath: string): vscode.Uri {
  const query = new URLSearchParams({ server: server.name, project: project.folder.uri.toString() });
  return vscode.Uri.from({ scheme: REMOTE_SCHEME, authority: serverSlug(server.name), path: remotePath, query: query.toString() });
}

function serverSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

export interface RemoteRef {
  project: Project;
  server: Server;
  path: string;
}

export function parseRemoteUri(projects: Projects, uri: vscode.Uri): RemoteRef | undefined {
  let serverName = uri.authority;
  let folder = uri.query;
  if (uri.query.includes('=')) {
    const q = new URLSearchParams(uri.query);
    serverName = q.get('server') ?? serverName;
    folder = q.get('project') ?? folder;
  }
  const all = projects.all();
  const project = all.find((p) => p.folder.uri.toString() === folder) ?? all.find((p) => p.server(serverName)) ?? all[0];
  // Older uris carried the name in the authority, which VS Code lower-cases: fall back to a case-insensitive match.
  const server = project?.server(serverName) ?? project?.config.servers.find((s) => s.name.toLowerCase() === serverName.toLowerCase());
  return project && server ? { project, server, path: uri.path || '/' } : undefined;
}

/**
 * Remote files opened for editing ("Edit Remote File"). Saving uploads the file (unless
 * `remoteDeployment.remoteEdit.uploadOnSave` is off, then it stays pending until Upload Current Remote File).
 * The content last read from / written to the server is kept for Compare/Revert to Last Uploaded Version.
 */
export class RemoteFileSystem implements vscode.FileSystemProvider, vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly snapshotEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.snapshotEmitter.event;
  /** Last uploaded/downloaded content per uri. */
  private readonly snapshots = new Map<string, Uint8Array>();
  /** Saved but not uploaded content per uri. */
  readonly pending = new Map<string, Uint8Array>();
  private readonly pendingEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangePending = this.pendingEmitter.event;

  constructor(
    private readonly projects: Projects,
    private readonly pool: ConnectionPool,
    private readonly revisions: RevisionTracker,
  ) {}

  private ref(uri: vscode.Uri): RemoteRef {
    const r = parseRemoteUri(this.projects, uri);
    if (!r) {
      throw vscode.FileSystemError.Unavailable(`Unknown deployment server "${uri.authority}"`);
    }
    return r;
  }

  private toStat(e: RemoteEntry): vscode.FileStat {
    return {
      type: (e.isDir ? vscode.FileType.Directory : vscode.FileType.File) | (e.isSymlink ? vscode.FileType.SymbolicLink : 0),
      ctime: e.mtime,
      mtime: e.mtime,
      size: e.size,
    };
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { server, path: p } = this.ref(uri);
    const pending = this.pending.get(uri.toString());
    const e = await this.pool.run(server, (t) => t.stat(p));
    if (!e) {
      if (pending) {
        return { type: vscode.FileType.File, ctime: Date.now(), mtime: Date.now(), size: pending.length };
      }
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return pending ? { ...this.toStat(e), size: pending.length, mtime: Math.max(e.mtime, Date.now()) } : this.toStat(e);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { server, path: p } = this.ref(uri);
    const items = await this.pool.run(server, (t) => t.list(p));
    return items.map((e) => [e.name, e.isDir ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const key = uri.toString();
    const pending = this.pending.get(key);
    if (pending) {
      return pending;
    }
    const { server, path: p } = this.ref(uri);
    const [data, st] = await this.pool.run(server, async (t) => [await t.readFile(p), await t.stat(p)] as const);
    this.snapshots.set(key, data);
    if (st) {
      this.revisions.set(server, p, { mtime: st.mtime, size: st.size });
    }
    return data;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const { server, path: p } = this.ref(uri);
    const key = uri.toString();
    const uploadOnSave = vscode.workspace.getConfiguration('remoteDeployment').get<boolean>('remoteEdit.uploadOnSave', true);
    if (!uploadOnSave && this.snapshots.has(key) && !options.create) {
      this.pending.set(key, content);
      this.pendingEmitter.fire();
      return;
    }
    await this.upload(uri, server, p, content);
  }

  /** Upload the pending (or given) content of a remote file. */
  async uploadCurrent(uri: vscode.Uri, content?: Uint8Array): Promise<boolean> {
    const { server, path: p } = this.ref(uri);
    const data = content ?? this.pending.get(uri.toString());
    if (!data) {
      return false;
    }
    const snapshot = this.snapshots.get(uri.toString());
    if (snapshot && Buffer.from(snapshot).equals(Buffer.from(data))) {
      this.pending.delete(uri.toString());
      this.pendingEmitter.fire();
      void vscode.window.showInformationMessage('The file is identical to remote one.');
      return true;
    }
    await this.upload(uri, server, p, data);
    return true;
  }

  private async upload(uri: vscode.Uri, server: Server, p: string, content: Uint8Array): Promise<void> {
    const key = uri.toString();
    const rev = this.revisions.get(server, p);
    const current = await this.pool.run(server, (t) => t.stat(p));
    if (rev && current && (current.mtime !== rev.mtime || current.size !== rev.size)) {
      const answer = await vscode.window.showWarningMessage(
        `"${p}" was changed on ${server.name} after you opened it. Overwrite it?`,
        { modal: true },
        'Overwrite',
      );
      if (answer !== 'Overwrite') {
        throw vscode.FileSystemError.NoPermissions('Upload cancelled: the remote file was changed');
      }
    } else if (rev && !current && this.snapshots.has(key)) {
      const answer = await vscode.window.showWarningMessage(
        `File "${p}" was deleted on "${server.name}" server. Do you want to upload edited version?`,
        { modal: true },
        'Upload',
      );
      if (answer !== 'Upload') {
        throw vscode.FileSystemError.NoPermissions('Upload cancelled');
      }
    }
    await this.pool.run(server, async (t) => {
      await t.mkdir(path.posix.dirname(p)).catch(() => undefined);
      await t.writeFile(p, Buffer.from(content));
      const after = await t.stat(p);
      if (after) {
        this.revisions.set(server, p, { mtime: after.mtime, size: after.size });
      }
    });
    this.snapshots.set(key, content);
    if (this.pending.delete(key)) {
      this.pendingEmitter.fire();
    }
    this.snapshotEmitter.fire(this.snapshotUri(uri));
    vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded ${path.posix.basename(p)} to ${server.name}`, 4000);
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  /** Drop local state and re-read from the server. */
  refresh(uri: vscode.Uri): void {
    this.pending.delete(uri.toString());
    this.snapshots.delete(uri.toString());
    this.pendingEmitter.fire();
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  snapshot(uri: vscode.Uri): Uint8Array | undefined {
    return this.snapshots.get(uri.toString());
  }

  snapshotUri(uri: vscode.Uri): vscode.Uri {
    return uri.with({ scheme: SNAPSHOT_SCHEME });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const data = this.snapshots.get(uri.with({ scheme: REMOTE_SCHEME }).toString());
    return data ? Buffer.from(data).toString('utf8') : '';
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { server, path: p } = this.ref(uri);
    await this.pool.run(server, (t) => t.mkdir(p));
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const { server, path: p } = this.ref(uri);
    const rm = async (e: RemoteEntry): Promise<void> => {
      if (e.isDir && !e.isSymlink) {
        for (const c of await this.pool.run(server, (t) => t.list(e.path))) {
          await rm(c);
        }
        await this.pool.run(server, (t) => t.deleteDir(e.path));
      } else {
        await this.pool.run(server, (t) => t.deleteFile(e.path));
      }
    };
    const e = await this.pool.run(server, (t) => t.stat(p));
    if (!e) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    await rm(e);
    this.revisions.delete(server, p);
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    const a = this.ref(from);
    const b = this.ref(to);
    if (a.server.name !== b.server.name) {
      throw vscode.FileSystemError.NoPermissions('Cannot move between servers');
    }
    await this.pool.run(a.server, (t) => t.rename(a.path, b.path));
    this.revisions.delete(a.server, a.path);
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: from },
      { type: vscode.FileChangeType.Created, uri: to },
    ]);
  }

  fireChanged(uri: vscode.Uri): void {
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
}
