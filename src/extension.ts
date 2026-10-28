import * as vscode from 'vscode';
import { registerHostCommands } from './commands/host';
import { registerLocalCommands, runPendingInitialDownload } from './commands/local';
import { Credentials } from './core/credentials';
import { hasIdeaConfig } from './core/ideaImport';
import { TransferLog } from './core/log';
import { Projects } from './core/project';
import { RevisionTracker } from './core/revisions';
import { Deployer } from './core/transfer';
import { AutoUploader } from './features/autoUpload';
import { DeploymentTaskProvider, registerRemoteChangeNotifier, registerUploadOnCommit } from './features/integrations';
import type { Services } from './services';
import { ConnectionPool } from './transport/pool';
import { REMOTE_SCHEME, RemoteFileSystem, SNAPSHOT_SCHEME } from './views/remoteFs';
import { SettingsPanel } from './ui/settingsPanel';
import { SyncPanel } from './ui/syncPanel';
import { RemoteHostView } from './views/remoteHost';

let services: Services | undefined;

export function activate(context: vscode.ExtensionContext): void {
  SyncPanel.extensionUri = context.extensionUri;
  SyncPanel.memento = context.globalState;
  SettingsPanel.extensionUri = context.extensionUri;
  const projects = new Projects(context.globalState);
  const credentials = new Credentials(context.secrets);
  const pool = new ConnectionPool(credentials);
  const log = new TransferLog();
  const revisions = new RevisionTracker(context.workspaceState);
  const deployer = new Deployer(pool, log, revisions);
  const remoteFs = new RemoteFileSystem(projects, pool, revisions);
  const host = new RemoteHostView(projects, pool, deployer);
  const s: Services = { context, projects, credentials, pool, log, revisions, deployer, remoteFs, host };
  services = s;

  const transferView = vscode.window.createTreeView('deploy.fileTransfer', { treeDataProvider: log });

  context.subscriptions.push(
    projects,
    pool,
    log,
    host,
    transferView,
    trackHasServers(projects),
    vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, remoteFs, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, remoteFs),
    new AutoUploader(projects, deployer),
    vscode.tasks.registerTaskProvider('deployment', new DeploymentTaskProvider(projects, deployer)),
    registerRemoteChangeNotifier(projects, deployer),
    ...registerLocalCommands(s),
    ...registerHostCommands(s),
    vscode.commands.registerCommand('deploy.log.clear', () => log.clear()),
    vscode.commands.registerCommand('deploy.log.output', () => log.output.show()),
    vscode.commands.registerCommand('deploy.log.details', (op) => op && log.showDetails(op)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === REMOTE_SCHEME && remoteFs.pending.has(doc.uri.toString())) {
        const content = remoteFs.pending.get(doc.uri.toString())!;
        void vscode.window
          .showWarningMessage(`Remote file '${doc.uri.path}' was closed, and its changes are not uploaded.`, 'Upload', 'Discard')
          .then(async (a) => {
            if (a === 'Upload') {
              await remoteFs.uploadCurrent(doc.uri, content);
            } else {
              remoteFs.refresh(doc.uri);
            }
          });
      }
    }),
  );
  void registerUploadOnCommit(projects, deployer).then((d) => context.subscriptions.push(d));

  // Offer to import an existing .idea deployment configuration once per project.
  for (const p of projects.all()) {
    const key = `deploy.ideaOffered:${p.root}`;
    if (!p.hasConfigFile() && hasIdeaConfig(p.root) && !context.workspaceState.get(key)) {
      void context.workspaceState.update(key, true);
      void vscode.window
        .showInformationMessage(`${p.name}: .idea deployment configuration found. Import it?`, 'Import')
        .then((a) => a && vscode.commands.executeCommand('deploy.importIdea'));
    }
  }
  void runPendingInitialDownload(s);
}

/** `deploy.hasServers` gates the Deployment context menu entries. */
function trackHasServers(projects: Projects): vscode.Disposable {
  const update = (): void => {
    void vscode.commands.executeCommand('setContext', 'deploy.hasServers', projects.all().some((p) => p.config.servers.length > 0));
  };
  update();
  return projects.onDidChange(update);
}

export async function deactivate(): Promise<void> {
  await services?.revisions.flush();
  await services?.pool.disconnect();
}
