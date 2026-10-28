import * as vscode from 'vscode';
import { mappingForLocal, remoteForLocal } from '../core/paths';
import type { Project, Projects } from '../core/project';
import type { Deployer } from '../core/transfer';

interface Batch {
  uploads: Set<string>;
  deletes: Set<string>;
  first: number;
  timer?: NodeJS.Timeout;
}

/**
 * Automatic upload to the default server or group: "Always" (every change, including external ones
 * unless "Skip external changes"), "On explicit save action" (Ctrl+S / Save All), or "Never".
 * Events are batched per project and uploaded after `autoUploadDebounceMs` without new events.
 */
export class AutoUploader implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly explicitSaves = new Set<string>();
  private readonly editorSaves = new Map<string, number>();
  private readonly batches = new Map<Project, Batch>();
  private running = Promise.resolve();

  constructor(
    private readonly projects: Projects,
    private readonly deployer: Deployer,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.reason === vscode.TextDocumentSaveReason.Manual) {
          this.explicitSaves.add(e.document.uri.toString());
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
      watcher.onDidChange((uri) => this.onExternal(uri)),
      watcher.onDidCreate((uri) => this.onExternal(uri)),
      watcher.onDidDelete((uri) => this.onDelete(uri)),
    );
  }

  private onSave(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const explicit = this.explicitSaves.delete(key);
    if (doc.uri.scheme !== 'file') {
      return;
    }
    this.editorSaves.set(key, Date.now());
    const project = this.projects.forUri(doc.uri);
    const mode = project?.config.options.autoUpload;
    if (project && (mode === 'always' || (mode === 'onExplicitSave' && explicit))) {
      this.enqueue(project, doc.uri.fsPath, false);
    }
  }

  private onExternal(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    // Saves from the editor are handled by onSave; the watcher fires for them too.
    const saved = this.editorSaves.get(uri.toString());
    if (saved && Date.now() - saved < 3000) {
      return;
    }
    const project = this.projects.forUri(uri);
    const o = project?.config.options;
    if (project && o?.autoUpload === 'always' && o.uploadExternalChanges) {
      this.enqueue(project, uri.fsPath, false);
    }
  }

  private onDelete(uri: vscode.Uri): void {
    const project = this.projects.forUri(uri);
    const o = project?.config.options;
    if (project && o && o.autoUpload !== 'never' && o.deleteRemoteOnLocalDelete) {
      this.enqueue(project, uri.fsPath, true);
    }
  }

  private enqueue(project: Project, file: string, deleted: boolean): void {
    const targets = project.defaultTargets();
    if (!targets.some((s) => mappingForLocal(project.root, s, file))) {
      return;
    }
    let b = this.batches.get(project);
    if (!b) {
      b = { uploads: new Set(), deletes: new Set(), first: Date.now() };
      this.batches.set(project, b);
    }
    (deleted ? b.deletes : b.uploads).add(file);
    (deleted ? b.uploads : b.deletes).delete(file);
    clearTimeout(b.timer);
    const debounce = project.config.options.autoUploadDebounceMs;
    const wait = Math.max(0, Math.min(debounce, b.first + debounce * 10 - Date.now()));
    b.timer = setTimeout(() => this.flush(project), wait);
  }

  private flush(project: Project): void {
    const b = this.batches.get(project);
    if (!b) {
      return;
    }
    this.batches.delete(project);
    this.running = this.running.then(() => this.run(project, [...b.uploads], [...b.deletes])).catch(() => undefined);
  }

  private async run(project: Project, uploads: string[], deletes: string[]): Promise<void> {
    const targets = project.defaultTargets();
    if (!targets.length) {
      return;
    }
    const over = project.config.options.autoUploadConfirmOver;
    if (over > 0 && uploads.length + deletes.length > over) {
      const ok = await vscode.window.showWarningMessage(
        `Automatic upload: ${uploads.length + deletes.length} changed files. Upload them to ${targets.map((t) => t.name).join(', ')}?`,
        'Upload',
      );
      if (!ok) {
        return;
      }
    }
    if (uploads.length) {
      await this.deployer.upload(project, targets, uploads, { explicit: false, quiet: true, title: 'Automatic upload' });
    }
    for (const server of targets) {
      const remotes = deletes
        .filter((f) => !project.excluder(server).isLocalExcluded(project.root, f))
        .map((f) => remoteForLocal(project.root, server, f))
        .filter((r): r is string => !!r);
      if (remotes.length) {
        await this.deployer.deleteRemote(project, server, remotes, { explicit: false, quiet: true, title: 'Automatic upload: delete' });
      }
    }
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      clearTimeout(b.timer);
    }
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
