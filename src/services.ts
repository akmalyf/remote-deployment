import type * as vscode from 'vscode';
import type { Credentials } from './core/credentials';
import type { TransferLog } from './core/log';
import type { Projects } from './core/project';
import type { RevisionTracker } from './core/revisions';
import type { Deployer } from './core/transfer';
import type { ConnectionPool } from './transport/pool';
import type { RemoteFileSystem } from './views/remoteFs';
import type { RemoteHostView } from './views/remoteHost';

export interface Services {
  context: vscode.ExtensionContext;
  projects: Projects;
  credentials: Credentials;
  pool: ConnectionPool;
  log: TransferLog;
  revisions: RevisionTracker;
  deployer: Deployer;
  remoteFs: RemoteFileSystem;
  host: RemoteHostView;
}
