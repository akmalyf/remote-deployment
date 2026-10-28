import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveTarget } from '../core/config';
import { remoteForLocal } from '../core/paths';
import type { Projects } from '../core/project';
import type { Deployer } from '../core/transfer';

// ------------------------------------------------------------------ upload on commit

interface GitChange {
  uri: vscode.Uri;
  originalUri: vscode.Uri;
  renameUri?: vscode.Uri;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: { commit?: string } };
  onDidCommit?: vscode.Event<void>;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

/** Upload the files of each new commit to `options.uploadOnCommit` (as a check-in handler). */
export async function registerUploadOnCommit(projects: Projects, deployer: Deployer): Promise<vscode.Disposable> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
  if (!ext) {
    return new vscode.Disposable(() => undefined);
  }
  const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  const disposables: vscode.Disposable[] = [];
  const watch = (repo: GitRepository): void => {
    if (!repo.onDidCommit) {
      return;
    }
    let head = repo.state.HEAD?.commit;
    disposables.push(
      repo.onDidCommit(async () => {
        const before = head;
        // HEAD is updated asynchronously after the commit event.
        await new Promise((r) => setTimeout(r, 500));
        const after = repo.state.HEAD?.commit;
        head = after;
        const project = projects.forUri(repo.rootUri);
        const target = project?.config.options.uploadOnCommit;
        if (!project || !target || !after) {
          return;
        }
        const servers = resolveTarget(project.config, target);
        if (!servers.length) {
          return;
        }
        const changes = before ? await repo.diffBetween(before, after) : [];
        const uploads: string[] = [];
        const deletes: string[] = [];
        for (const c of changes) {
          const p = c.uri.fsPath;
          if (fs.existsSync(p)) {
            uploads.push(p);
          } else {
            deletes.push(p);
          }
          if (c.renameUri && c.originalUri.fsPath !== p) {
            deletes.push(c.originalUri.fsPath);
          }
        }
        if (uploads.length) {
          await deployer.upload(project, servers, uploads, { explicit: false, title: 'Upload committed files' });
        }
        if (deletes.length && project.config.options.deleteRemoteOnLocalDelete) {
          for (const s of servers) {
            const remotes = deletes.map((d) => remoteForLocal(project.root, s, d)).filter((r): r is string => !!r);
            if (remotes.length) {
              await deployer.deleteRemote(project, s, remotes, { explicit: false, title: 'Delete committed deletions' });
            }
          }
        }
      }),
    );
  };
  api.repositories.forEach(watch);
  disposables.push(api.onDidOpenRepository(watch));
  return vscode.Disposable.from(...disposables);
}

// ------------------------------------------------------------------ "Upload before launch" task

interface DeploymentTaskDefinition extends vscode.TaskDefinition {
  server?: string;
  paths?: string[];
  direction?: 'upload' | 'download';
}

/**
 * Task type `deployment` — use it as `preLaunchTask` or in `dependsOn` to upload before running
 * (an "upload files to the default server" before-launch step).
 */
export class DeploymentTaskProvider implements vscode.TaskProvider {
  constructor(
    private readonly projects: Projects,
    private readonly deployer: Deployer,
  ) {}

  provideTasks(): vscode.Task[] {
    return this.projects
      .all()
      .filter((p) => p.config.servers.length)
      .flatMap((p) => [
        this.build({ type: 'deployment', direction: 'upload' }, p.folder, 'Upload project to default server'),
        this.build({ type: 'deployment', direction: 'download' }, p.folder, 'Download project from default server'),
      ]);
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const folder = task.scope && typeof task.scope === 'object' ? (task.scope as vscode.WorkspaceFolder) : vscode.workspace.workspaceFolders?.[0];
    return folder ? this.build(task.definition as DeploymentTaskDefinition, folder, task.name) : undefined;
  }

  private build(def: DeploymentTaskDefinition, folder: vscode.WorkspaceFolder, name: string): vscode.Task {
    const exec = new vscode.CustomExecution(async () => {
      const write = new vscode.EventEmitter<string>();
      const close = new vscode.EventEmitter<number>();
      return {
        onDidWrite: write.event,
        onDidClose: close.event,
        open: () => {
          void (async () => {
            const project = this.projects.forUri(folder.uri);
            if (!project) {
              write.fire('No deployment configuration.\r\n');
              close.fire(1);
              return;
            }
            const servers = def.server ? resolveTarget(project.config, def.server) : project.defaultTargets();
            if (!servers.length) {
              write.fire(`Server or group "${def.server ?? '(default)'}" is not configured.\r\n`);
              close.fire(1);
              return;
            }
            const locals = def.paths?.length
              ? def.paths.map((p) => path.resolve(project.root, p))
              : [...new Set(servers.flatMap((s) => s.mappings.map((m) => path.resolve(project.root, m.local))))];
            write.fire(`${def.direction === 'download' ? 'Downloading' : 'Uploading'} ${locals.join(', ')} ${def.direction === 'download' ? 'from' : 'to'} ${servers.map((s) => s.name).join(', ')}…\r\n`);
            let ok = true;
            if (def.direction === 'download') {
              for (const s of servers) {
                ok = (await this.deployer.download(project, s, locals, { explicit: false })) && ok;
              }
            } else {
              ok = await this.deployer.upload(project, servers, locals, { explicit: false });
            }
            write.fire(ok ? 'Done.\r\n' : 'Finished with errors, see File Transfer.\r\n');
            close.fire(ok ? 0 : 1);
          })();
        },
        close: () => undefined,
      };
    });
    return new vscode.Task(def, folder, name, 'deployment', exec);
  }
}

// ------------------------------------------------------------------ notify of remote changes

/** When a file is opened, warn if its deployed copy changed since our last upload/download. */
export function registerRemoteChangeNotifier(projects: Projects, deployer: Deployer): vscode.Disposable {
  const checked = new Map<string, number>();
  return vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    const uri = editor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      return;
    }
    const project = projects.forUri(uri);
    if (!project?.config.options.notifyRemoteChanges) {
      return;
    }
    const last = checked.get(uri.toString());
    if (last && Date.now() - last < 60_000) {
      return;
    }
    checked.set(uri.toString(), Date.now());
    for (const server of project.defaultTargets()) {
      const remote = remoteForLocal(project.root, server, uri.fsPath);
      const rev = remote && deployer.revisions.get(server, remote);
      if (!remote || !rev) {
        continue;
      }
      const st = await deployer.pool.run(server, (t) => t.stat(remote)).catch(() => undefined);
      if (st && (st.mtime !== rev.mtime || st.size !== rev.size)) {
        const answer = await vscode.window.showWarningMessage(
          `${path.basename(uri.fsPath)} was changed on ${server.name} (${new Date(st.mtime).toLocaleString()}).`,
          'Compare',
          'Download',
        );
        if (answer === 'Compare') {
          await vscode.commands.executeCommand('deploy.compareWith', uri, undefined, server.name);
        } else if (answer === 'Download') {
          await deployer.download(project, server, [uri.fsPath]);
        }
      }
    }
  });
}
