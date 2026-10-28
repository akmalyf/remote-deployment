import * as path from 'node:path';
import * as vscode from 'vscode';
import { supportsSsh } from '../core/config';
import { joinRemote, localForRemote, mappingForRemote, deployRelative, webUrlForRemote } from '../core/paths';
import { startSshSession } from '../features/sshTerminal';
import type { Services } from '../services';
import { pickPermissions } from '../ui/pickers';
import { SettingsPanel } from '../ui/settingsPanel';
import { SyncPanel } from '../ui/syncPanel';
import { REMOTE_SCHEME, remoteUri, SNAPSHOT_SCHEME } from '../views/remoteFs';
import type { EntryNode, HostNode, ServerNode } from '../views/remoteHost';

function selection(s: Services, node: unknown, nodes: unknown): HostNode[] {
  if (Array.isArray(nodes) && nodes.length) {
    return nodes as HostNode[];
  }
  if (node && typeof node === 'object' && 'kind' in node) {
    return [node as HostNode];
  }
  return [...s.host.view.selection];
}

function entries(list: HostNode[]): EntryNode[] {
  return list.filter((n): n is EntryNode => n.kind === 'entry');
}

/** The folder a node stands for: the folder itself, a file's parent, or the server's view root. */
function dirOf(s: Services, n: ServerNode | EntryNode): string {
  if (n.kind === 'server') {
    return s.host.viewRoot(n.server, n.project);
  }
  return n.entry.isDir ? n.entry.path : path.posix.dirname(n.entry.path);
}

function first(s: Services, node: unknown, nodes: unknown): ServerNode | EntryNode | undefined {
  return selection(s, node, nodes).find((n): n is ServerNode | EntryNode => n.kind !== 'message');
}

async function openRemote(n: EntryNode): Promise<void> {
  await vscode.window.showTextDocument(remoteUri(n.project, n.server, n.entry.path), { preview: true });
}

export function registerHostCommands(s: Services): vscode.Disposable[] {
  const reg = (id: string, fn: (node?: unknown, nodes?: unknown) => unknown): vscode.Disposable => vscode.commands.registerCommand(id, fn);
  const { host, deployer, pool } = s;

  return [
    reg('deploy.host.open', async (node) => openRemote(node as EntryNode)),
    reg('deploy.host.refresh', (node) => host.refresh(node && (node as HostNode).kind ? (node as HostNode) : undefined)),
    reg('deploy.host.collapse', () => vscode.commands.executeCommand('workbench.actions.treeView.deploy.remoteHost.collapseAll')),
    reg('deploy.host.toggleSize', () => {
      host.showSize = !host.showSize;
      host.refresh();
    }),
    reg('deploy.host.goTo', async (node, nodes) => {
      let n = first(s, node, nodes);
      if (!n) {
        const all = s.projects.all().flatMap((p) => p.config.servers.map((server) => ({ label: server.name, description: p.name, node: { kind: 'server', project: p, server } as ServerNode })));
        n = (await vscode.window.showQuickPick(all, { title: 'Go to path on' }))?.node;
      }
      if (!n) {
        return;
      }
      const target = await vscode.window.showInputBox({ title: `Go to path on ${n.server.name}`, value: dirOf(s, n), prompt: 'Absolute path on the server; "~" = deployment root' });
      if (!target) {
        return;
      }
      if (target === '~') {
        host.setViewRoot(n.project, n.server, n.server.rootPath || '/');
        return;
      }
      const st = await pool.run(n.server, (t) => t.stat(target)).catch(() => undefined);
      if (!st) {
        void vscode.window.showWarningMessage(`${target} does not exist on ${n.server.name}`);
      } else if (st.isDir) {
        host.setViewRoot(n.project, n.server, target);
      } else {
        await host.reveal(n.project, n.server, target);
      }
    }),
    reg('deploy.host.newFile', async (node, nodes) => {
      const n = first(s, node, nodes);
      if (!n) {
        return;
      }
      const dir = dirOf(s, n);
      const name = await vscode.window.showInputBox({ title: `New file in ${dir}`, prompt: 'File name (may include sub folders)' });
      if (!name) {
        return;
      }
      const p = joinRemote(dir, name);
      await pool.run(n.server, async (t) => {
        await t.mkdir(path.posix.dirname(p)).catch(() => undefined);
        await t.writeFile(p, Buffer.alloc(0));
      });
      host.refresh(n.kind === 'entry' && n.entry.isDir ? n : undefined);
      await vscode.window.showTextDocument(remoteUri(n.project, n.server, p));
    }),
    reg('deploy.host.newFolder', async (node, nodes) => {
      const n = first(s, node, nodes);
      if (!n) {
        return;
      }
      const dir = dirOf(s, n);
      const name = await vscode.window.showInputBox({ title: `New directory in ${dir}` });
      if (!name) {
        return;
      }
      let current = dir;
      for (const seg of name.split('/').filter(Boolean)) {
        current = joinRemote(current, seg);
        const c = current;
        await pool.run(n.server, (t) => t.mkdir(c));
      }
      host.refresh(n.kind === 'entry' && n.entry.isDir ? n : undefined);
    }),
    reg('deploy.host.rename', async (node, nodes) => {
      const [n] = entries(selection(s, node, nodes));
      if (!n) {
        return;
      }
      const name = await vscode.window.showInputBox({ title: `Rename ${n.entry.path}`, value: n.entry.name, valueSelection: [0, n.entry.name.lastIndexOf('.') > 0 ? n.entry.name.lastIndexOf('.') : n.entry.name.length] });
      if (!name || name === n.entry.name) {
        return;
      }
      const to = name.startsWith('/') ? name : joinRemote(path.posix.dirname(n.entry.path), name);
      try {
        await pool.run(n.server, (t) => t.rename(n.entry.path, to));
        s.revisions.delete(n.server, n.entry.path);
      } catch (e) {
        void vscode.window.showErrorMessage(`Rename failed: ${(e as Error).message}`);
      }
      host.refresh();
    }),
    reg('deploy.host.delete', async (node, nodes) => {
      const list = entries(selection(s, node, nodes));
      if (!list.length) {
        return;
      }
      const n = list[0];
      const ok = await vscode.window.showWarningMessage(
        `Delete ${list.length === 1 ? `"${n.entry.path}"` : `${list.length} items`} on ${n.server.name}?${list.some((x) => x.entry.isDir) ? ' Folders are deleted with their contents.' : ''}`,
        { modal: true },
        'Delete',
      );
      if (ok) {
        await deployer.deleteRemote(n.project, n.server, list.map((x) => x.entry.path));
        host.refresh();
      }
    }),
    reg('deploy.host.cut', (node, nodes) => {
      host.clipboard = { nodes: entries(selection(s, node, nodes)), move: true };
    }),
    reg('deploy.host.copy', (node, nodes) => {
      host.clipboard = { nodes: entries(selection(s, node, nodes)), move: false };
    }),
    reg('deploy.host.paste', async (node, nodes) => {
      const n = first(s, node, nodes);
      const clip = host.clipboard;
      if (!n || !clip?.nodes.length) {
        return;
      }
      const src = clip.nodes.filter((x) => x.server.name === n.server.name && x.project === n.project);
      if (src.length !== clip.nodes.length) {
        void vscode.window.showWarningMessage('Items can only be pasted on the server they come from.');
      }
      if (src.length) {
        await deployer.copyRemote(n.project, n.server, src.map((x) => x.entry), dirOf(s, n), clip.move);
        if (clip.move) {
          host.clipboard = undefined;
        }
        host.refresh();
      }
    }),
    reg('deploy.host.chmod', async (node, nodes) => {
      const list = entries(selection(s, node, nodes));
      if (!list.length) {
        return;
      }
      const mode = await pickPermissions(list[0].entry.mode, list.length === 1 ? list[0].entry.name : `${list.length} items`);
      if (mode === undefined) {
        return;
      }
      for (const n of list) {
        try {
          await pool.run(n.server, async (t) => {
            if (!t.chmod) {
              throw new Error('Not supported by this server type');
            }
            await t.chmod(n.entry.path, mode & 0o7777);
          });
        } catch (e) {
          void vscode.window.showErrorMessage(`Change permissions of ${n.entry.path}: ${(e as Error).message}`);
        }
      }
      host.refresh();
    }),
    reg('deploy.host.copyPaths', async (node, nodes) => {
      const list = entries(selection(s, node, nodes));
      await vscode.env.clipboard.writeText(list.map((n) => n.entry.path).join('\n'));
    }),
    reg('deploy.host.copyWebUrl', async (node, nodes) => {
      const list = entries(selection(s, node, nodes));
      const urls = list.map((n) => webUrlForRemote(n.project.root, n.server, n.entry.path)).filter(Boolean);
      if (urls.length) {
        await vscode.env.clipboard.writeText(urls.join('\n'));
      } else {
        void vscode.window.showWarningMessage('Web server URL is not configured.');
      }
    }),
    reg('deploy.host.openInBrowser', async (node, nodes) => {
      const [n] = entries(selection(s, node, nodes));
      const url = n && webUrlForRemote(n.project.root, n.server, n.entry.path);
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        void vscode.window.showWarningMessage('Web server URL is not configured.');
      }
    }),
    reg('deploy.host.toggleExclusion', async (node, nodes) => {
      const list = entries(selection(s, node, nodes));
      if (!list.length) {
        return;
      }
      const { project, server } = list[0];
      await project.update((c) => {
        const srv = c.servers.find((x) => x.name === server.name)!;
        for (const n of list) {
          const rel = deployRelative(server, n.entry.path);
          const i = srv.excludedPaths.findIndex((e) => !e.local && e.path === rel);
          if (i >= 0) {
            srv.excludedPaths.splice(i, 1);
          } else {
            srv.excludedPaths.push({ path: rel, local: false });
          }
        }
      });
      host.refresh();
    }),
    reg('deploy.host.editLocal', async (node, nodes) => {
      const [n] = entries(selection(s, node, nodes));
      const local = n && localForRemote(n.project.root, n.server, n.entry.path);
      if (!local) {
        void vscode.window.showWarningMessage('Not mapped to a local path.');
        return;
      }
      if (n.entry.isDir) {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(local));
      } else {
        await vscode.window.showTextDocument(vscode.Uri.file(local));
      }
    }),
    reg('deploy.host.editRemote', async (node, nodes) => {
      for (const n of entries(selection(s, node, nodes)).filter((x) => !x.entry.isDir)) {
        await openRemote(n);
      }
    }),
    reg('deploy.host.download', async (node, nodes) => {
      const sel = selection(s, node, nodes);
      const server = sel.find((n): n is ServerNode => n.kind === 'server');
      if (server) {
        const local = server.server.mappings.map((m) => path.resolve(server.project.root, m.local));
        await deployer.download(server.project, server.server, local);
        return;
      }
      const list = entries(sel);
      if (!list.length) {
        return;
      }
      const { project, server: srv } = list[0];
      let targetDir: string | undefined;
      if (list.some((n) => !mappingForRemote(srv, n.entry.path))) {
        const picked = await vscode.window.showOpenDialog({ title: 'Download to', canSelectFolders: true, canSelectFiles: false, defaultUri: project.folder.uri });
        if (!picked) {
          return;
        }
        targetDir = picked[0].fsPath;
      }
      await deployer.downloadRemote(project, srv, list.map((n) => n.entry), targetDir);
    }),
    reg('deploy.host.upload', async (node, nodes) => {
      const n = first(s, node, nodes);
      if (!n) {
        return;
      }
      const list = entries(selection(s, node, nodes));
      const mappedLocals = list.map((x) => localForRemote(x.project.root, x.server, x.entry.path)).filter((l): l is string => !!l);
      if (list.length && mappedLocals.length === list.length) {
        // "Upload Here" on mapped items uploads their local counterparts.
        await deployer.upload(n.project, [n.server], mappedLocals);
      } else {
        const picked = await vscode.window.showOpenDialog({ title: `Upload to ${dirOf(s, n)}`, canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: n.project.folder.uri });
        if (!picked) {
          return;
        }
        await deployer.uploadInto(n.project, n.server, picked.map((u) => u.fsPath), dirOf(s, n));
      }
      host.refresh(n.kind === 'entry' && n.entry.isDir ? n : undefined);
    }),
    reg('deploy.host.compare', async (node, nodes) => {
      const [n] = entries(selection(s, node, nodes));
      const local = n && localForRemote(n.project.root, n.server, n.entry.path);
      if (local) {
        await vscode.commands.executeCommand('vscode.diff', remoteUri(n.project, n.server, n.entry.path), vscode.Uri.file(local), `${n.entry.name} (${n.server.name} ↔ Local)`);
      }
    }),
    reg('deploy.host.sync', async (node, nodes) => {
      const n = first(s, node, nodes);
      if (!n) {
        return;
      }
      const local =
        n.kind === 'server'
          ? n.server.mappings[0] && path.resolve(n.project.root, n.server.mappings[0].local)
          : localForRemote(n.project.root, n.server, n.entry.path);
      if (local) {
        await SyncPanel.open(deployer, n.project, n.server, local);
      } else {
        void vscode.window.showWarningMessage('Not mapped to a local path.');
      }
    }),
    reg('deploy.host.serverMenu', async (node, nodes) => {
      const n = first(s, node, nodes);
      if (!n) {
        return;
      }
      const server = n.server;
      const isDefault = n.project.config.defaultServer === server.name;
      const items: (vscode.QuickPickItem & { command?: string })[] = [
        ...(supportsSsh(server) ? [{ label: '$(terminal) Start SSH Session', command: 'deploy.host.ssh' }] : []),
        { label: '$(edit) Edit Server…', command: 'deploy.host.edit' },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(plug) Test Connection', command: 'deploy.host.test' },
        ...(isDefault ? [] : [{ label: '$(star-empty) Use as Default Server', command: 'deploy.host.setDefault' }]),
        { label: '$(refresh) Refresh', command: 'deploy.host.refresh' },
        ...(pool.isConnected(server) ? [{ label: '$(debug-disconnect) Disconnect', command: 'deploy.host.disconnect' }] : []),
      ];
      const picked = await vscode.window.showQuickPick(items, { title: server.name, placeHolder: 'Choose an action' });
      if (picked?.command) {
        await vscode.commands.executeCommand(picked.command, n);
      }
    }),
    reg('deploy.host.ssh', (node, nodes) => {
      const n = first(s, node, nodes);
      if (n) {
        startSshSession(n.server, s.credentials, dirOf(s, n));
      }
    }),
    reg('deploy.host.test', (node, nodes) => {
      const n = first(s, node, nodes);
      return n && vscode.commands.executeCommand('deploy.testConnection', n.server);
    }),
    reg('deploy.host.setDefault', async (node, nodes) => {
      const n = first(s, node, nodes);
      if (n) {
        await n.project.update((c) => (c.defaultServer = n.server.name));
        host.refresh();
      }
    }),
    reg('deploy.host.edit', (node, nodes) => {
      const n = first(s, node, nodes);
      if (n) {
        SettingsPanel.show(n.project, s, 'servers', n.server.name);
      }
    }),
    reg('deploy.host.disconnect', async (node, nodes) => {
      const n = first(s, node, nodes);
      if (n) {
        await pool.disconnect(n.server);
      }
    }),

    // ------------------------------------------------------------ remote edit
    vscode.commands.registerCommand('deploy.remote.uploadCurrent', async (uri?: vscode.Uri) => {
      const doc = uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : vscode.window.activeTextEditor?.document;
      if (!doc || doc.uri.scheme !== REMOTE_SCHEME) {
        return;
      }
      if (doc.isDirty) {
        await doc.save();
      }
      try {
        await s.remoteFs.uploadCurrent(doc.uri, Buffer.from(doc.getText(), 'utf8'));
      } catch (e) {
        void vscode.window.showErrorMessage(`Failed to upload content of remote file: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('deploy.remote.refreshCurrent', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || doc.uri.scheme !== REMOTE_SCHEME) {
        return;
      }
      if (doc.isDirty || s.remoteFs.pending.has(doc.uri.toString())) {
        const ok = await vscode.window.showWarningMessage('Discard local changes and reload the file from the server?', { modal: true }, 'Reload');
        if (!ok) {
          return;
        }
      }
      s.remoteFs.refresh(doc.uri);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }),
    vscode.commands.registerCommand('deploy.remote.compareLastUploaded', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || doc.uri.scheme !== REMOTE_SCHEME) {
        return;
      }
      await vscode.commands.executeCommand('vscode.diff', doc.uri.with({ scheme: SNAPSHOT_SCHEME }), doc.uri, `${path.posix.basename(doc.uri.path)} (Last uploaded ↔ Current content)`);
    }),
    vscode.commands.registerCommand('deploy.remote.revertLastUploaded', async () => {
      const editor = vscode.window.activeTextEditor;
      const doc = editor?.document;
      const snapshot = doc && s.remoteFs.snapshot(doc.uri);
      if (!doc || !snapshot) {
        return;
      }
      const ok = await vscode.window.showWarningMessage('Revert Edited Remote File to the last uploaded version?', { modal: true }, 'Revert');
      if (!ok) {
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), Buffer.from(snapshot).toString('utf8'));
      await vscode.workspace.applyEdit(edit);
    }),
  ];
}
