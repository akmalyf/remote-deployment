import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeServer, Protocol, PROTOCOL_LABELS, resolveTarget, Server, serializeServer, supportsSsh } from '../core/config';
import { hasIdeaConfig, importIdea } from '../core/ideaImport';
import { mappingForLocal, projectRelative, remoteForLocal, webUrlForLocal } from '../core/paths';
import type { Project } from '../core/project';
import { startSshSession } from '../features/sshTerminal';
import type { Services } from '../services';
import { defaultTargets, pickServer, pickTarget } from '../ui/pickers';
import { browseRemoteFolder, SettingsPanel } from '../ui/settingsPanel';
import { SyncPanel } from '../ui/syncPanel';
import { remoteUri } from '../views/remoteFs';

const PENDING_DOWNLOAD_KEY = 'deploy.pendingInitialDownload';

/** Explorer passes (uri, uris), editor (uri), SCM (...resourceStates), palette nothing. */
export function resolveLocals(args: unknown[]): vscode.Uri[] {
  const [first, second] = args;
  if (Array.isArray(second) && second.length && second[0] instanceof vscode.Uri) {
    return second as vscode.Uri[];
  }
  if (first instanceof vscode.Uri) {
    return [first];
  }
  const states = args.filter((a): a is { resourceUri: vscode.Uri } => !!a && typeof a === 'object' && (a as { resourceUri?: unknown }).resourceUri instanceof vscode.Uri);
  if (states.length) {
    return states.map((s) => s.resourceUri);
  }
  const doc = vscode.window.activeTextEditor?.document.uri;
  return doc ? [doc] : [];
}

function fileUris(args: unknown[]): vscode.Uri[] {
  return resolveLocals(args).filter((u) => u.scheme === 'file');
}

function projectFor(s: Services, uris: vscode.Uri[]): Project | undefined {
  const p = s.projects.forUri(uris[0]);
  if (!p) {
    void vscode.window.showWarningMessage('Open a folder to use deployment.');
  }
  return p;
}

/** A single server from the default target (first of a group). */
async function defaultServer(project: Project): Promise<Server | undefined> {
  return (await defaultTargets(project))?.[0];
}

async function saveDirty(uris: vscode.Uri[]): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && uris.some((u) => doc.uri.fsPath === u.fsPath || doc.uri.fsPath.startsWith(u.fsPath + path.sep))) {
      await doc.save();
    }
  }
}

export async function compareWithServer(s: Services, project: Project, server: Server, local: vscode.Uri): Promise<void> {
  if (fs.existsSync(local.fsPath) && fs.statSync(local.fsPath).isDirectory()) {
    await SyncPanel.open(s.deployer, project, server, local.fsPath);
    return;
  }
  const remote = remoteForLocal(project.root, server, local.fsPath);
  if (!remote) {
    void vscode.window.showWarningMessage(`${path.basename(local.fsPath)} is not mapped on ${server.name}.`);
    return;
  }
  const exists = await s.pool.run(server, (t) => t.stat(remote));
  if (!exists) {
    void vscode.window.showWarningMessage(`${remote} does not exist on ${server.name}.`);
    return;
  }
  await vscode.commands.executeCommand('vscode.diff', remoteUri(project, server, remote), local, `${path.basename(local.fsPath)} (${server.name} ↔ Local)`);
}

function openTabUris(): vscode.Uri[] {
  const out: vscode.Uri[] = [];
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      const input = t.input;
      if (input instanceof vscode.TabInputText && input.uri.scheme === 'file' && !out.some((u) => u.fsPath === input.uri.fsPath)) {
        out.push(input.uri);
      }
    }
  }
  return out;
}

async function pickSingleOfTargets(project: Project, title: string, servers: Server[] | undefined): Promise<Server | undefined> {
  if (!servers?.length) {
    return undefined;
  }
  if (servers.length === 1) {
    return servers[0];
  }
  const picked = await vscode.window.showQuickPick(servers.map((x) => ({ label: x.name, server: x })), { title, placeHolder: 'Choose a server of the group' });
  return picked?.server;
}

export function registerLocalCommands(s: Services): vscode.Disposable[] {
  const reg = (id: string, fn: (...args: unknown[]) => unknown): vscode.Disposable => vscode.commands.registerCommand(id, fn);
  const { deployer, projects } = s;

  return [
    reg('deploy.upload', async (...args) => {
      const uris = fileUris(args);
      const project = projectFor(s, uris);
      const targets = project && uris.length ? await defaultTargets(project) : undefined;
      if (project && targets) {
        await saveDirty(uris);
        await deployer.upload(project, targets, uris.map((u) => u.fsPath));
        s.host.refresh();
      }
    }),
    reg('deploy.uploadTo', async (...args) => {
      const uris = fileUris(args);
      const project = projectFor(s, uris);
      const targets = project && uris.length ? await pickTarget(project, `Upload to`) : undefined;
      if (project && targets) {
        await saveDirty(uris);
        await deployer.upload(project, targets, uris.map((u) => u.fsPath));
        s.host.refresh();
      }
    }),
    reg('deploy.uploadAllOpen', async () => {
      const uris = openTabUris();
      const project = projectFor(s, uris);
      const targets = project && uris.length ? await defaultTargets(project) : undefined;
      if (project && targets) {
        await vscode.workspace.saveAll(false);
        await deployer.upload(project, targets, uris.map((u) => u.fsPath), { title: 'Upload all open files' });
      }
    }),
    reg('deploy.uploadAllOpenTo', async () => {
      const uris = openTabUris();
      const project = projectFor(s, uris);
      const targets = project && uris.length ? await pickTarget(project, 'Upload all open files to') : undefined;
      if (project && targets) {
        await vscode.workspace.saveAll(false);
        await deployer.upload(project, targets, uris.map((u) => u.fsPath), { title: 'Upload all open files' });
      }
    }),
    reg('deploy.download', async (...args) => {
      const uris = fileUris(args);
      const project = projectFor(s, uris);
      const server = project && uris.length ? await defaultServer(project) : undefined;
      if (project && server) {
        await deployer.download(project, server, uris.map((u) => u.fsPath));
      }
    }),
    reg('deploy.downloadFrom', async (...args) => {
      const uris = fileUris(args);
      const project = projectFor(s, uris);
      const server = project && uris.length ? await pickServer(project, 'Download from') : undefined;
      if (project && server) {
        await deployer.download(project, server, uris.map((u) => u.fsPath));
      }
    }),
    reg('deploy.compare', async (...args) => {
      const [uri] = fileUris(args);
      const project = uri && projectFor(s, [uri]);
      const server = project ? await defaultServer(project) : undefined;
      if (project && server) {
        await compareWithServer(s, project, server, uri);
      }
    }),
    reg('deploy.compareWith', async (...args) => {
      const [uri] = fileUris(args);
      const project = uri && projectFor(s, [uri]);
      if (!project) {
        return;
      }
      const named = typeof args[2] === 'string' ? project.server(args[2]) : undefined;
      const server = named ?? (await pickServer(project, 'Compare with deployed version on'));
      if (server) {
        await compareWithServer(s, project, server, uri);
      }
    }),
    reg('deploy.sync', async (...args) => {
      const [uri] = fileUris(args);
      const target = uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      const project = target && projectFor(s, [target]);
      const server = project ? await pickSingleOfTargets(project, 'Sync with', await defaultTargets(project)) : undefined;
      if (project && server && target) {
        await SyncPanel.open(deployer, project, server, target.fsPath);
      }
    }),
    reg('deploy.syncWith', async (...args) => {
      const [uri] = fileUris(args);
      const target = uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      const project = target && projectFor(s, [target]);
      const server = project ? await pickServer(project, 'Sync with deployed to') : undefined;
      if (project && server && target) {
        await SyncPanel.open(deployer, project, server, target.fsPath);
      }
    }),
    reg('deploy.editRemoteFile', async (...args) => {
      const [uri] = fileUris(args);
      const project = uri && projectFor(s, [uri]);
      const server = project ? await defaultServer(project) : undefined;
      const remote = project && server ? remoteForLocal(project.root, server, uri.fsPath) : undefined;
      if (project && server && remote) {
        await vscode.window.showTextDocument(remoteUri(project, server, remote));
      } else if (project && server) {
        void vscode.window.showWarningMessage(`Not mapped on ${server.name}.`);
      }
    }),
    reg('deploy.deleteRemote', async (...args) => {
      const uris = fileUris(args);
      const project = projectFor(s, uris);
      const server = project && uris.length ? await pickSingleOfTargets(project, 'Delete from', await defaultTargets(project)) : undefined;
      if (!project || !server) {
        return;
      }
      const remotes = uris.map((u) => remoteForLocal(project.root, server, u.fsPath)).filter((r): r is string => !!r);
      if (!remotes.length) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(`Delete ${remotes.length === 1 ? remotes[0] : `${remotes.length} items`} on ${server.name}?`, { modal: true }, 'Delete');
      if (ok) {
        await deployer.deleteRemote(project, server, remotes);
        s.host.refresh();
      }
    }),
    reg('deploy.copyRemotePath', async (...args) => {
      const uris = fileUris(args);
      const project = projectFor(s, uris);
      const server = project && uris.length ? await defaultServer(project) : undefined;
      if (project && server) {
        const paths = uris.map((u) => remoteForLocal(project.root, server, u.fsPath)).filter(Boolean);
        await vscode.env.clipboard.writeText(paths.join('\n'));
        vscode.window.setStatusBarMessage(`Copied ${paths.length} path(s)`, 3000);
      }
    }),
    reg('deploy.openInBrowser', async (...args) => {
      const [uri] = fileUris(args);
      const project = uri && projectFor(s, [uri]);
      const server = project ? await defaultServer(project) : undefined;
      const url = project && server ? webUrlForLocal(project.root, server, uri.fsPath) : undefined;
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (server) {
        void vscode.window.showWarningMessage(`Web server URL or web path is not configured for ${server.name}.`);
      }
    }),
    reg('deploy.toggleLocalExclusion', async (...args) => {
      const uris = fileUris(args);
      const project = projectFor(s, uris);
      const server = project && uris.length ? await pickSingleOfTargets(project, 'Exclude on', await defaultTargets(project)) : undefined;
      if (!project || !server) {
        return;
      }
      await project.update((c) => {
        const srv = c.servers.find((x) => x.name === server.name)!;
        for (const u of uris) {
          const rel = projectRelative(project.root, u.fsPath);
          const i = srv.excludedPaths.findIndex((e) => e.local && e.path === rel);
          if (i >= 0) {
            srv.excludedPaths.splice(i, 1);
          } else {
            srv.excludedPaths.push({ path: rel, local: true });
          }
        }
      });
      s.host.refresh();
    }),
    reg('deploy.selectInRemoteHost', async (...args) => {
      const [uri] = fileUris(args);
      const project = uri && projectFor(s, [uri]);
      const server = project ? await defaultServer(project) : undefined;
      const remote = project && server ? remoteForLocal(project.root, server, uri.fsPath) : undefined;
      if (project && server && remote) {
        await s.host.reveal(project, server, remote);
      }
    }),
    reg('deploy.configuration', async (arg?: unknown, serverName?: unknown) => {
      const project = (arg as Project)?.folder ? (arg as Project) : await projects.pick();
      if (project) {
        SettingsPanel.show(project, s, 'servers', typeof serverName === 'string' ? serverName : undefined);
      }
    }),
    reg('deploy.options', async () => {
      const project = projects.active() ?? (await projects.pick());
      if (project) {
        SettingsPanel.show(project, s, 'options');
      }
    }),
    reg('deploy.toggleAutoUpload', async () => {
      const project = projects.active();
      if (!project) {
        return;
      }
      const last = s.context.workspaceState.get<'always' | 'onExplicitSave'>('deploy.lastAutoUpload', 'always');
      const current = project.config.options.autoUpload;
      if (current !== 'never') {
        await s.context.workspaceState.update('deploy.lastAutoUpload', current);
      }
      const next = current === 'never' ? last : 'never';
      await project.update((c) => (c.options.autoUpload = next));
      if (next !== 'never' && !project.defaultTargets().length) {
        void vscode.window.showWarningMessage('Default server or group of servers is not configured. Files will not be uploaded automatically.', 'Choose Default Server').then((a) => a && vscode.commands.executeCommand('deploy.selectDefaultServer', project));
      }
      vscode.window.setStatusBarMessage(`Automatic upload: ${next === 'never' ? 'off' : next === 'always' ? 'always' : 'on explicit save'}`, 3000);
    }),
    reg('deploy.browse', () => vscode.commands.executeCommand('deploy.remoteHost.focus')),
    reg('deploy.selectDefaultServer', async (arg?: unknown) => {
      const project = (arg as Project)?.folder ? (arg as Project) : (projects.active() ?? (await projects.pick()));
      if (!project) {
        return;
      }
      const items: (vscode.QuickPickItem & { value?: string })[] = [
        ...project.config.servers.map((x) => ({ label: `$(server) ${x.name}`, description: PROTOCOL_LABELS[x.type], value: x.name, picked: x.name === project.config.defaultServer })),
        ...project.config.groups.map((g) => ({ label: `$(server-environment) ${g.name}`, description: `group: ${g.servers.join(', ')}`, value: g.name })),
        { label: '$(close) No default server', value: '' },
      ];
      const picked = await vscode.window.showQuickPick(items, { title: 'Choose Default Server or Group of Them for Actions' });
      if (picked) {
        await project.update((c) => (c.defaultServer = picked.value || undefined));
        s.host.refresh();
      }
    }),
    reg('deploy.testConnection', async (arg?: unknown) => {
      const project = projects.active();
      const server = (arg as Server)?.type ? (arg as Server) : project ? await pickServer(project, 'Test connection') : undefined;
      if (!server) {
        return;
      }
      const session = s.pool.fresh(server);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${server.name}…` }, async () => {
        try {
          const home = await session.run((t) => t.home());
          const root = server.rootPath || home;
          const st = await session.run((t) => t.stat(root));
          void vscode.window.showInformationMessage(`Successfully connected to ${server.name}.${st ? '' : ` Root path ${root} does not exist.`}`);
        } catch (e) {
          void vscode.window.showErrorMessage(`Connection to '${server.name}' failed.\n${(e as Error).message}`);
        } finally {
          await session.close().catch(() => undefined);
        }
      });
    }),
    reg('deploy.startSsh', async () => {
      const project = projects.active();
      const server = project ? await pickServer(project, 'Start SSH session', supportsSsh) : undefined;
      if (server) {
        startSshSession(server, s.credentials, server.rootPath || undefined);
      }
    }),
    reg('deploy.importIdea', async () => {
      const project = await projects.pick('Import into project');
      if (!project) {
        return;
      }
      if (!hasIdeaConfig(project.root)) {
        void vscode.window.showWarningMessage('No .idea/deployment.xml or .idea/webServers.xml in this project.');
        return;
      }
      const imported = importIdea(project.root);
      if (!imported.servers.length) {
        void vscode.window.showWarningMessage('No deployment servers found in the .idea configuration.');
        return;
      }
      if (project.config.servers.length) {
        const ok = await vscode.window.showWarningMessage(`Replace the ${project.config.servers.length} configured server(s) with ${imported.servers.length} from .idea?`, { modal: true }, 'Replace', 'Merge');
        if (!ok) {
          return;
        }
        if (ok === 'Merge') {
          const names = new Set(imported.servers.map((x) => x.name));
          imported.servers.push(...project.config.servers.filter((x) => !names.has(x.name)));
          imported.groups.push(...project.config.groups);
          imported.defaultServer ??= project.config.defaultServer;
        }
      }
      await project.save(imported);
      void vscode.window.showInformationMessage(`Imported ${imported.servers.length} server(s) from .idea. Passwords are not imported; you will be asked on first connect.`);
      SettingsPanel.show(project, s);
    }),
    reg('deploy.newProjectFromServer', () => newProjectFromServer(s)),
    reg('deploy.setPassword', async () => {
      const project = projects.active();
      const server = project ? await pickServer(project, 'Set password') : undefined;
      if (server) {
        const kind = server.type === 'sftp' && server.auth === 'key' ? 'passphrase' : 'password';
        const v = await vscode.window.showInputBox({ prompt: `${kind} for ${server.name}`, password: true, ignoreFocusOut: true });
        if (v !== undefined) {
          await s.credentials.set(server, kind, v, true);
        }
      }
    }),
    reg('deploy.forgetPassword', async () => {
      const project = projects.active();
      const server = project ? await pickServer(project, 'Forget saved password') : undefined;
      if (server) {
        await s.credentials.forget(server, 'password');
        await s.credentials.forget(server, 'passphrase');
        await s.pool.disconnect(server);
        vscode.window.setStatusBarMessage(`Forgot password for ${server.name}`, 3000);
      }
    }),
    reg('deploy.disconnectAll', () => s.pool.disconnect()),
  ];
}

/** "New Project from Existing Files…": choose server and remote folder, download into a new local folder. */
async function newProjectFromServer(s: Services): Promise<void> {
  const type = await vscode.window.showQuickPick(
    (['sftp', 'ftp', 'ftps', 'webdav'] as Protocol[]).map((t) => ({ label: PROTOCOL_LABELS[t], value: t })),
    { title: 'New Project from Existing Files: connection type' },
  );
  if (!type) {
    return;
  }
  const hostInput = await vscode.window.showInputBox({ title: 'Host', prompt: 'host, host:port or user@host:port', ignoreFocusOut: true });
  if (!hostInput) {
    return;
  }
  const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(hostInput.trim());
  if (!m) {
    void vscode.window.showErrorMessage('Invalid host');
    return;
  }
  let user = m[1];
  if (!user) {
    user = (await vscode.window.showInputBox({ title: 'Username', ignoreFocusOut: true })) ?? '';
  }
  const server = normalizeServer({ name: m[2], type: type.value, host: m[2], port: m[3] ? Number(m[3]) : undefined, user, auth: type.value === 'sftp' ? 'password' : undefined });
  if (type.value === 'sftp') {
    const auth = await vscode.window.showQuickPick(
      [
        { label: 'Password', value: 'password' as const },
        { label: 'OpenSSH config and authentication agent', value: 'openSsh' as const },
        { label: 'Key pair', value: 'key' as const },
      ],
      { title: 'Authentication' },
    );
    if (!auth) {
      return;
    }
    server.auth = auth.value;
    if (auth.value === 'key') {
      const key = await vscode.window.showOpenDialog({ title: 'Private key file', canSelectMany: false });
      if (!key) {
        return;
      }
      server.keyPath = key[0].fsPath;
    }
  }
  const remoteRoot = await browseRemoteFolder(s.pool, server, undefined, 'Choose the project folder on the server');
  if (!remoteRoot) {
    return;
  }
  const target = await vscode.window.showOpenDialog({ title: 'Local folder for the project', canSelectFolders: true, canSelectFiles: false, openLabel: 'Create Project Here' });
  if (!target) {
    return;
  }
  const local = path.join(target[0].fsPath, path.posix.basename(remoteRoot) || server.host);
  fs.mkdirSync(path.join(local, '.vscode'), { recursive: true });
  server.rootPath = remoteRoot;
  server.mappings = [{ local: '.', deploy: '/', web: '/' }];
  fs.writeFileSync(path.join(local, '.vscode', 'deployment.json'), JSON.stringify({ defaultServer: server.name, servers: [serializeServer(server)] }, null, 2) + '\n');
  await s.context.globalState.update(PENDING_DOWNLOAD_KEY, local);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(local), { forceNewWindow: true });
}

/** Second half of "New Project from Existing Files…", run in the new window. */
export async function runPendingInitialDownload(s: Services): Promise<void> {
  const pending = s.context.globalState.get<string>(PENDING_DOWNLOAD_KEY);
  const project = pending ? s.projects.all().find((p) => p.root === pending) : undefined;
  if (!project) {
    return;
  }
  await s.context.globalState.update(PENDING_DOWNLOAD_KEY, undefined);
  const servers = resolveTarget(project.config, project.config.defaultServer);
  if (servers[0] && mappingForLocal(project.root, servers[0], project.root)) {
    await s.deployer.download(project, servers[0], [project.root], { title: 'Download project' });
  }
}
