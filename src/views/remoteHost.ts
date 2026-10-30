import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeServer, PROTOCOL_LABELS, Server, supportsChmod, supportsSsh } from '../core/config';
import { formatMode, formatSize, isRemoteUnder, localForRemote, mappingForRemote, normalizeRemote } from '../core/paths';
import type { Project, Projects } from '../core/project';
import type { Deployer } from '../core/transfer';
import type { ConnectionPool } from '../transport/pool';
import type { RemoteEntry } from '../transport/types';
import { parseRemoteUri, REMOTE_SCHEME, remoteUri } from './remoteFs';

export interface ServerNode {
  kind: 'server';
  project: Project;
  server: Server;
}

export interface EntryNode {
  kind: 'entry';
  project: Project;
  server: Server;
  entry: RemoteEntry;
}

export interface MessageNode {
  kind: 'message';
  text: string;
  icon: string;
}

export type HostNode = ServerNode | EntryNode | MessageNode;

const DND_MIME = 'application/vnd.code.tree.deploy.remotehost';

function nodeId(n: ServerNode | EntryNode): string {
  const base = `${n.project.folder.uri.toString()}|${n.server.name}`;
  return n.kind === 'server' ? base : `${base}|${n.entry.path}`;
}

const SERVER_SCHEME = 'deploy-server';

/** Identifies a server row for its decoration (the default-server star). */
function serverUri(project: Project, server: Server): vscode.Uri {
  return vscode.Uri.from({ scheme: SERVER_SCHEME, path: '/' + encodeURIComponent(server.name), query: project.folder.uri.toString() });
}

export function viewRootOf(server: Server): string {
  return normalizeRemote(server.rootPath || '/');
}

/** The Remote Host tool window: servers and their file trees. */
export class RemoteHostView implements vscode.TreeDataProvider<HostNode>, vscode.TreeDragAndDropController<HostNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<HostNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decoEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decoEmitter.event;
  readonly dropMimeTypes = [DND_MIME, 'text/uri-list'];
  readonly dragMimeTypes = [DND_MIME];
  readonly view: vscode.TreeView<HostNode>;
  private readonly cache = new Map<string, EntryNode[]>();
  private readonly nodes = new Map<string, ServerNode | EntryNode>();
  /** Per-server folder shown at the top level ("Go to Path"). */
  private readonly viewRoots = new Map<string, string>();
  showSize = false;
  clipboard?: { nodes: EntryNode[]; move: boolean };
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly projects: Projects,
    private readonly pool: ConnectionPool,
    private readonly deployer: Deployer,
  ) {
    this.view = vscode.window.createTreeView('deploy.remoteHost', {
      treeDataProvider: this,
      dragAndDropController: this,
      canSelectMany: true,
      showCollapseAll: false,
    });
    this.disposables.push(
      this.view,
      vscode.window.registerFileDecorationProvider(this),
      projects.onDidChange(() => this.refresh()),
      pool.onDidChange(() => this.emitter.fire()),
    );
  }

  refresh(node?: HostNode): void {
    if (!node) {
      this.cache.clear();
    } else if (node.kind !== 'message') {
      const key = nodeId(node);
      for (const k of [...this.cache.keys()]) {
        if (k === key || k.startsWith(key + '|') || k.startsWith(key + '/')) {
          this.cache.delete(k);
        }
      }
    }
    this.emitter.fire(node?.kind === 'entry' && !node.entry.isDir ? undefined : node);
    this.decoEmitter.fire(undefined);
  }

  /** Refresh the folder that contains a remote path. */
  refreshPath(project: Project, server: Server, remotePath: string): void {
    const parent = path.posix.dirname(remotePath);
    const node = this.nodes.get(`${project.folder.uri.toString()}|${server.name}|${parent}`);
    if (node) {
      this.refresh(node);
    } else {
      this.refresh();
    }
  }

  viewRoot(server: Server, project: Project): string {
    return this.viewRoots.get(`${project.folder.uri.toString()}|${server.name}`) ?? viewRootOf(server);
  }

  setViewRoot(project: Project, server: Server, p: string): void {
    this.viewRoots.set(`${project.folder.uri.toString()}|${server.name}`, normalizeRemote(p));
    this.refresh();
  }

  // ------------------------------------------------------------ tree data

  getTreeItem(n: HostNode): vscode.TreeItem {
    if (n.kind === 'message') {
      const item = new vscode.TreeItem(n.text);
      item.iconPath = new vscode.ThemeIcon(n.icon);
      return item;
    }
    if (n.kind === 'server') {
      const s = n.server;
      const isDefault = n.project.config.defaultServer === s.name;
      const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = nodeId(n);
      const multi = this.projects.all().length > 1;
      const connected = this.pool.isConnected(s);
      // Icon and name; the default star is a right-aligned decoration badge, details live in the tooltip.
      item.resourceUri = serverUri(n.project, s);
      item.description = multi ? n.project.name : undefined;
      item.tooltip = new vscode.MarkdownString(
        `**${s.name}**${isDefault ? ' (default)' : ''}\n\n${PROTOCOL_LABELS[s.type]} · ${describeServer(s)}\n\nBrowsing: ${this.viewRoot(s, n.project)}\n\n${s.webUrl ? `Web: ${s.webUrl}\n\n` : ''}${connected ? '$(plug) connected' : 'not connected'}`,
        true,
      );
      item.iconPath = new vscode.ThemeIcon(
        s.type === 'local' ? 'folder-library' : 'server',
        connected ? new vscode.ThemeColor('testing.iconPassed') : undefined,
      );
      item.contextValue = `server${supportsSsh(s) ? '.ssh' : ''}${isDefault ? '.isdefault' : '.nondefault'}`;
      return item;
    }
    const e = n.entry;
    const item = new vscode.TreeItem(e.name, e.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = nodeId(n);
    item.resourceUri = remoteUri(n.project, n.server, e.path);
    const mapped = !!mappingForRemote(n.server, e.path) && isRemoteUnder(e.path, viewRootOf(n.server));
    const excluded = n.project.excluder(n.server).isRemoteExcluded(n.project.root, e.path);
    const desc: string[] = [];
    if (this.showSize && !e.isDir) {
      desc.push(formatSize(e.size));
    }
    if (e.isSymlink) {
      desc.push(`→ ${e.linkTarget ?? 'link'}`);
    }
    item.description = desc.join(' ');
    item.tooltip = [
      e.path,
      e.isDir ? 'Folder' : formatSize(e.size),
      e.mtime ? `Modified: ${new Date(e.mtime).toLocaleString()}` : '',
      e.mode !== undefined ? `Permissions: ${formatMode(e.mode)} (${e.mode.toString(8).padStart(3, '0')})` : '',
      mapped ? `Local: ${localForRemote(n.project.root, n.server, e.path)}` : 'Not mapped',
      excluded ? 'Excluded' : '',
    ]
      .filter(Boolean)
      .join('\n');
    item.contextValue = `${e.isDir ? 'remoteDir' : 'remoteFile'}${mapped ? '.mapped' : ''}${excluded ? '.excluded' : ''}${supportsChmod(n.server) ? '.chmod' : ''}`;
    if (!e.isDir) {
      item.command = { command: 'deploy.host.open', title: 'Open', arguments: [n] };
    }
    return item;
  }

  async getChildren(n?: HostNode): Promise<HostNode[]> {
    if (!n) {
      const out: ServerNode[] = [];
      for (const project of this.projects.all()) {
        for (const server of project.config.servers) {
          const node: ServerNode = { kind: 'server', project, server };
          this.nodes.set(nodeId(node), node);
          out.push(node);
        }
      }
      void vscode.commands.executeCommand('setContext', 'deploy.hasServers', out.length > 0);
      return out;
    }
    if (n.kind === 'message' || (n.kind === 'entry' && !n.entry.isDir)) {
      return [];
    }
    const key = nodeId(n);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const dir = n.kind === 'server' ? this.viewRoot(n.server, n.project) : n.entry.path;
    try {
      const entries = await this.pool.run(n.server, (t) => t.list(dir));
      entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1));
      const hidden = n.server.showHidden === false;
      const children = entries
        .filter((e) => !hidden || !e.name.startsWith('.'))
        .map((entry) => {
          const node: EntryNode = { kind: 'entry', project: n.project, server: n.server, entry };
          this.nodes.set(nodeId(node), node);
          return node;
        });
      this.cache.set(key, children);
      this.emitter.fire(n.kind === 'server' ? n : undefined);
      return children.length ? children : [{ kind: 'message', text: 'Empty folder', icon: 'circle-slash' }];
    } catch (e) {
      return [{ kind: 'message', text: (e as Error).message, icon: 'error' }];
    }
  }

  getParent(n: HostNode): HostNode | undefined {
    if (n.kind !== 'entry') {
      return undefined;
    }
    const root = this.viewRoot(n.server, n.project);
    const parent = path.posix.dirname(n.entry.path);
    if (n.entry.path === root || parent === n.entry.path || !isRemoteUnder(parent, root) || parent === root) {
      return this.nodes.get(`${n.project.folder.uri.toString()}|${n.server.name}`);
    }
    return this.nodes.get(`${n.project.folder.uri.toString()}|${n.server.name}|${parent}`) ?? {
      kind: 'entry',
      project: n.project,
      server: n.server,
      entry: { name: path.posix.basename(parent), path: parent, isDir: true, isSymlink: false, size: 0, mtime: 0 },
    };
  }

  /** Expand the tree down to a remote path and select it. */
  async reveal(project: Project, server: Server, remotePath: string): Promise<void> {
    const root = this.viewRoot(server, project);
    if (!isRemoteUnder(remotePath, root)) {
      this.setViewRoot(project, server, path.posix.dirname(remotePath));
    }
    const st = await this.pool.run(server, (t) => t.stat(remotePath));
    if (!st) {
      void vscode.window.showWarningMessage(`${remotePath} does not exist on ${server.name}`);
      return;
    }
    // Load each folder on the way so the nodes exist.
    const segments = remotePath.slice(this.viewRoot(server, project).length).split('/').filter(Boolean);
    let current: HostNode = this.nodes.get(`${project.folder.uri.toString()}|${server.name}`) ?? { kind: 'server', project, server };
    for (const seg of segments) {
      const children: HostNode[] = await this.getChildren(current);
      const next = children.find((c) => c.kind === 'entry' && c.entry.name === seg);
      if (!next) {
        break;
      }
      current = next;
    }
    await vscode.commands.executeCommand('deploy.remoteHost.focus');
    await this.view.reveal(current, { select: true, focus: true, expand: st.isDir });
  }

  // ------------------------------------------------------------ decorations

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === SERVER_SCHEME) {
      const p = this.projects.all().find((x) => x.folder.uri.toString() === uri.query);
      const name = decodeURIComponent(uri.path.slice(1));
      return p && p.config.defaultServer === name ? { badge: '★', tooltip: 'Default server' } : undefined;
    }
    if (uri.scheme !== REMOTE_SCHEME) {
      return undefined;
    }
    const ref = parseRemoteUri(this.projects, uri);
    if (!ref) {
      return undefined;
    }
    const { project, server } = ref;
    if (project.excluder(server).isRemoteExcluded(project.root, uri.path)) {
      return { color: new vscode.ThemeColor('disabledForeground'), badge: 'E', tooltip: 'Excluded' };
    }
    if (mappingForRemote(server, uri.path)) {
      return { color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), tooltip: 'Mapped' };
    }
    return undefined;
  }

  // ------------------------------------------------------------ drag and drop

  handleDrag(source: readonly HostNode[], data: vscode.DataTransfer): void {
    const entries = source.filter((n): n is EntryNode => n.kind === 'entry');
    if (entries.length) {
      data.set(DND_MIME, new vscode.DataTransferItem(entries));
    }
  }

  async handleDrop(target: HostNode | undefined, data: vscode.DataTransfer): Promise<void> {
    if (!target || target.kind === 'message') {
      return;
    }
    const dir = target.kind === 'server' ? this.viewRoot(target.server, target.project) : target.entry.isDir ? target.entry.path : path.posix.dirname(target.entry.path);
    const internal = data.get(DND_MIME)?.value as EntryNode[] | undefined;
    if (internal?.length) {
      const sameServer = internal.filter((n) => n.server.name === target.server.name && n.project === target.project);
      if (sameServer.length !== internal.length) {
        void vscode.window.showWarningMessage('Items can only be moved within one server.');
      }
      if (sameServer.length) {
        const answer = await vscode.window.showInformationMessage(
          `Move ${sameServer.length === 1 ? `"${sameServer[0].entry.name}"` : `${sameServer.length} items`} to ${dir}?`,
          { modal: true },
          'Move',
          'Copy',
        );
        if (answer) {
          await this.deployer.copyRemote(target.project, target.server, sameServer.map((n) => n.entry), dir, answer === 'Move');
          this.refresh();
        }
      }
      return;
    }
    const uriList = await data.get('text/uri-list')?.asString();
    if (!uriList) {
      return;
    }
    const locals = uriList
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
      .map((s) => vscode.Uri.parse(s))
      .filter((u) => u.scheme === 'file')
      .map((u) => u.fsPath);
    if (locals.length) {
      await this.deployer.uploadInto(target.project, target.server, locals, dir);
      this.refresh(target.kind === 'entry' && target.entry.isDir ? target : undefined);
    }
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this.emitter.dispose();
    this.decoEmitter.dispose();
  }
}

export function describeEntryPaths(nodes: EntryNode[]): string {
  return nodes.map((n) => n.entry.path).join('\n');
}
