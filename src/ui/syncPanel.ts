import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Server } from '../core/config';
import { joinRemote, remoteForLocal } from '../core/paths';
import type { Project } from '../core/project';
import { CancelledError, Ctx, Deployer, isUpToDate } from '../core/transfer';
import type { RemoteEntry } from '../transport/types';
import { browseRemoteFolder } from './settingsPanel';
import { remoteUri } from '../views/remoteFs';

export type CompareBy = 'content' | 'size' | 'timestamp';
export type SyncState = 'equal' | 'different' | 'localOnly' | 'remoteOnly' | 'conflict';
export type SyncOp = 'upload' | 'download' | 'deleteLocal' | 'deleteRemote' | 'skip' | 'none';

export interface SyncRow {
  id: number;
  /** Path relative to the compared folders, '/' separated. */
  rel: string;
  localPath: string;
  remotePath: string;
  local?: { size: number; mtime: number };
  remote?: { size: number; mtime: number };
  state: SyncState;
  /** Which side was modified last, for the default operation of different files. */
  newer?: 'local' | 'remote';
  op: SyncOp;
}

/** Operations a row cycles through with Space / click, the first one being the default. */
export function opsFor(row: Pick<SyncRow, 'state' | 'newer'>): SyncOp[] {
  switch (row.state) {
    case 'localOnly':
      return ['upload', 'deleteLocal', 'skip'];
    case 'remoteOnly':
      return ['download', 'deleteRemote', 'skip'];
    case 'different':
      return row.newer === 'remote' ? ['download', 'upload', 'skip'] : ['upload', 'download', 'skip'];
    case 'conflict':
      return ['skip', 'upload', 'download'];
    default:
      return ['none'];
  }
}

const CONTENT_COMPARE_LIMIT = 20 * 1024 * 1024;

/**
 * "Sync with Deployed": a directory diff. Local items on the left, deployed items on the
 * right, the operation in between; the selected file's diff is shown below (Monaco, in the webview).
 */
export class SyncPanel {
  static extensionUri: vscode.Uri;
  /** Remembers the last "Compare by" choice. */
  static memento: vscode.Memento;
  private static readonly open_ = new Set<SyncPanel>();
  private readonly panel: vscode.WebviewPanel;
  private rows: SyncRow[] = [];
  private compareBy: CompareBy = SyncPanel.memento?.get<CompareBy>('deploy.sync.compareBy') ?? 'content';
  private comparing?: vscode.CancellationTokenSource;

  static async open(deployer: Deployer, project: Project, server: Server, localPath: string): Promise<void> {
    const remote = remoteForLocal(project.root, server, localPath);
    if (!remote) {
      void vscode.window.showWarningMessage(`${localPath} is not mapped on ${server.name}.`);
      return;
    }
    const existing = [...SyncPanel.open_].find((p) => p.server.name === server.name && p.localRoot === localPath && p.project === project);
    if (existing) {
      existing.panel.reveal();
      await existing.compare();
      return;
    }
    const p = new SyncPanel(deployer, project, server, localPath, remote);
    SyncPanel.open_.add(p);
  }

  private constructor(
    private readonly deployer: Deployer,
    private readonly project: Project,
    private readonly server: Server,
    private localRoot: string,
    private remoteRoot: string,
  ) {
    this.panel = vscode.window.createWebviewPanel('deploy.sync', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(SyncPanel.extensionUri, 'dist', 'media')],
    });
    this.panel.iconPath = new vscode.ThemeIcon('sync');
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel.onDidDispose(() => {
      this.comparing?.cancel();
      SyncPanel.open_.delete(this);
    });
  }

  private title(): string {
    return `Sync: ${path.basename(this.localRoot)} ↔ ${this.server.name}`;
  }

  private post(m: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(m);
  }

  private header(): Record<string, unknown> {
    return { type: 'header', local: this.localRoot, remote: `${this.remoteRoot}`, server: this.server.name, compareBy: this.compareBy };
  }

  async compare(): Promise<void> {
    this.comparing?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.comparing = cts;
    const token = cts.token;
    await this.post(this.header());
    await this.post({ type: 'busy', text: 'Comparing…' });
    const rows: SyncRow[] = [];
    const excluder = this.project.excluder(this.server);
    const preserve = this.project.config.options.preserveTimestamps;
    const run = <T>(fn: Parameters<typeof this.deployer.pool.run<T>>[1]): Promise<T> => this.deployer.pool.run(this.server, fn);
    let checked = 0;

    const classify = async (rel: string, localPath: string, remotePath: string, st?: fs.Stats, re?: RemoteEntry): Promise<void> => {
      if (!st && !re) {
        return;
      }
      let state: SyncState;
      let newer: 'local' | 'remote' | undefined;
      if (st && !re) {
        state = 'localOnly';
      } else if (!st && re) {
        state = 'remoteOnly';
      } else {
        const l = st!;
        const r = re!;
        newer = l.mtimeMs >= r.mtime ? 'local' : 'remote';
        if (this.compareBy === 'size') {
          state = l.size === r.size ? 'equal' : 'different';
        } else if (this.compareBy === 'timestamp') {
          state = isUpToDate(l, r, preserve) ? 'equal' : 'different';
        } else if (l.size !== r.size) {
          state = 'different';
        } else if (l.size > CONTENT_COMPARE_LIMIT) {
          state = isUpToDate(l, r, preserve) ? 'equal' : 'different';
        } else {
          const [a, b] = await Promise.all([fsp.readFile(localPath), run((t) => t.readFile(remotePath))]);
          state = a.equals(b) ? 'equal' : 'different';
        }
        if (state === 'different') {
          // Changed on the server since our last transfer, and locally after it: a conflict.
          const rev = this.deployer.revisions.get(this.server, remotePath);
          if (rev && (rev.mtime !== r.mtime || rev.size !== r.size) && l.mtimeMs > rev.mtime + 2000) {
            state = 'conflict';
          }
        }
      }
      const row: SyncRow = {
        id: rows.length,
        rel,
        localPath,
        remotePath,
        local: st ? { size: st.size, mtime: st.mtimeMs } : undefined,
        remote: re ? { size: re.size, mtime: re.mtime } : undefined,
        state,
        newer,
        op: 'none',
      };
      row.op = opsFor(row)[0];
      rows.push(row);
      if (++checked % 25 === 0) {
        void this.post({ type: 'busy', text: `Comparing… ${checked} files` });
      }
    };

    const walk = async (rel: string): Promise<void> => {
      if (token.isCancellationRequested) {
        throw new CancelledError();
      }
      const lp = rel ? path.join(this.localRoot, ...rel.split('/')) : this.localRoot;
      const rp = rel ? joinRemote(this.remoteRoot, rel) : this.remoteRoot;
      const locals = new Map<string, fs.Stats>();
      for (const name of await fsp.readdir(lp).catch(() => [] as string[])) {
        const st = await fsp.stat(path.join(lp, name)).catch(() => undefined);
        if (st) {
          locals.set(name, st);
        }
      }
      const remotes = new Map<string, RemoteEntry>();
      for (const e of await run((t) => t.list(rp)).catch(() => [] as RemoteEntry[])) {
        remotes.set(e.name, e);
      }
      const names = [...new Set([...locals.keys(), ...remotes.keys()])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const dirs: string[] = [];
      for (const name of names) {
        const childRel = rel ? `${rel}/${name}` : name;
        const clp = path.join(lp, name);
        const crp = joinRemote(rp, name);
        if (excluder.isLocalExcluded(this.project.root, clp) || excluder.isRemoteExcluded(this.project.root, crp)) {
          continue;
        }
        const st = locals.get(name);
        const re = remotes.get(name);
        const localDir = !!st?.isDirectory();
        const remoteDir = !!re?.isDir;
        if (localDir || remoteDir) {
          // A file on one side and a folder on the other: report the file, walk the folder.
          if (st && !localDir) {
            await classify(childRel, clp, crp, st, undefined);
          }
          if (re && !remoteDir) {
            await classify(childRel, clp, crp, undefined, re);
          }
          dirs.push(childRel);
        } else {
          await classify(childRel, clp, crp, st, re);
        }
      }
      for (const d of dirs) {
        await walk(d);
      }
    };

    try {
      const st = await fsp.stat(this.localRoot).catch(() => undefined);
      if (st && !st.isDirectory()) {
        const re = await run((t) => t.stat(this.remoteRoot));
        await classify(path.basename(this.localRoot), this.localRoot, this.remoteRoot, st, re);
      } else {
        await walk('');
      }
      if (token.isCancellationRequested) {
        return;
      }
      this.rows = rows;
      await this.post({ type: 'rows', rows });
    } catch (e) {
      if (!(e instanceof CancelledError)) {
        await this.post({ type: 'error', text: (e as Error).message });
      }
    } finally {
      if (this.comparing === cts) {
        this.comparing = undefined;
      }
    }
  }

  private async onMessage(m: {
    type: string;
    id?: number;
    ids?: number[];
    ops?: Record<number, SyncOp>;
    compareBy?: CompareBy;
    text?: string;
  }): Promise<void> {
    const row = m.id !== undefined ? this.rows.find((r) => r.id === m.id) : undefined;
    switch (m.type) {
      case 'ready':
        await this.compare();
        break;
      case 'refresh':
        if (m.compareBy) {
          this.compareBy = m.compareBy;
          void SyncPanel.memento?.update('deploy.sync.compareBy', m.compareBy);
        }
        await this.compare();
        break;
      case 'select':
        if (row) {
          await this.sendDiff(row);
        }
        break;
      case 'open':
        if (row) {
          // Edit Source (F4): the local file, or the deployed one when there is no local copy.
          const uri = row.local || !row.remote ? vscode.Uri.file(row.localPath) : remoteUri(this.project, this.server, row.remotePath);
          await vscode.window.showTextDocument(uri, { preview: false }).then(undefined, (e) => vscode.window.showErrorMessage((e as Error).message));
        }
        break;
      case 'saveLocal':
        if (row && m.text !== undefined) {
          await this.saveLocal(row, m.text);
        }
        break;
      case 'saveRemote':
        if (row && m.text !== undefined) {
          await this.saveRemote(row, m.text);
        }
        break;
      case 'confirmRemote':
        if (row && m.text !== undefined) {
          const answer = await vscode.window.showWarningMessage(`Upload your changes to ${row.rel} on ${this.server.name}?`, { modal: true }, 'Upload', 'Discard');
          if (answer === 'Upload') {
            await this.saveRemote(row, m.text);
          }
        }
        break;
      case 'perform':
        await this.perform(m.ids ?? [], m.ops ?? {});
        break;
      case 'chooseLocal': {
        const picked = await vscode.window.showOpenDialog({ title: 'Local folder to compare', canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(this.localRoot) });
        if (picked) {
          this.localRoot = picked[0].fsPath;
          this.panel.title = this.title();
          await this.compare();
        }
        break;
      }
      case 'chooseRemote': {
        const picked = await browseRemoteFolder(this.deployer.pool, this.server, this.remoteRoot, `Folder on ${this.server.name} to compare`);
        if (picked) {
          this.remoteRoot = picked;
          await this.compare();
        }
        break;
      }
    }
  }

  /** Contents of both sides of a row for the diff below the table. */
  private async sendDiff(row: SyncRow): Promise<void> {
    const base = {
      type: 'diff',
      id: row.id,
      rel: row.rel,
      language: languageOf(row.rel),
      local: { exists: !!row.local, path: row.localPath } as { exists: boolean; path: string; text?: string },
      remote: { exists: !!row.remote, path: row.remotePath } as { exists: boolean; path: string; text?: string },
    };
    if ((row.local?.size ?? 0) > MAX_DIFF_SIZE || (row.remote?.size ?? 0) > MAX_DIFF_SIZE) {
      await this.post({ ...base, tooLarge: true });
      return;
    }
    try {
      const [l, r] = await Promise.all([
        row.local ? fsp.readFile(row.localPath) : Promise.resolve(Buffer.alloc(0)),
        row.remote ? this.deployer.pool.run(this.server, (t) => t.readFile(row.remotePath)) : Promise.resolve(Buffer.alloc(0)),
      ]);
      if (isBinary(l) || isBinary(r)) {
        await this.post({ ...base, binary: true, identicalBinary: l.equals(r) });
        return;
      }
      base.local.text = l.toString('utf8');
      base.remote.text = r.toString('utf8');
      await this.post(base);
    } catch (e) {
      void vscode.window.showErrorMessage(`Compare ${row.rel}: ${(e as Error).message}`);
    }
  }

  private async saveLocal(row: SyncRow, text: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(row.localPath);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === row.localPath);
      if (open?.isDirty) {
        // Keep an open, modified editor consistent: edit its buffer and save it.
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, open.lineCount, 0), text);
        await vscode.workspace.applyEdit(edit);
        await open.save();
      } else {
        await fsp.mkdir(path.dirname(row.localPath), { recursive: true });
        await fsp.writeFile(row.localPath, text, 'utf8');
      }
      await this.post({ type: 'savedLocal', id: row.id });
      await this.updateRow(row);
    } catch (e) {
      void vscode.window.showErrorMessage(`Save ${row.rel}: ${(e as Error).message}`);
    }
  }

  private async saveRemote(row: SyncRow, text: string): Promise<void> {
    try {
      await this.deployer.pool.run(this.server, async (t) => {
        await t.mkdir(path.posix.dirname(row.remotePath)).catch(() => undefined);
        await t.writeFile(row.remotePath, Buffer.from(text, 'utf8'));
        const st = await t.stat(row.remotePath);
        if (st) {
          this.deployer.revisions.set(this.server, row.remotePath, { mtime: st.mtime, size: st.size });
        }
      });
      vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded ${path.posix.basename(row.remotePath)} to ${this.server.name}`, 4000);
      await this.post({ type: 'savedRemote', id: row.id });
      await this.updateRow(row);
    } catch (e) {
      void vscode.window.showErrorMessage(`Upload ${row.rel}: ${(e as Error).message}`);
    }
  }

  /** Re-classify one row after it was edited in the diff. */
  private async updateRow(row: SyncRow): Promise<void> {
    const st = await fsp.stat(row.localPath).catch(() => undefined);
    const re = await this.deployer.pool.run(this.server, (t) => t.stat(row.remotePath)).catch(() => undefined);
    row.local = st ? { size: st.size, mtime: st.mtimeMs } : undefined;
    row.remote = re ? { size: re.size, mtime: re.mtime } : undefined;
    if (st && re) {
      row.newer = st.mtimeMs >= re.mtime ? 'local' : 'remote';
      if (st.size !== re.size) {
        row.state = 'different';
      } else {
        const [a, b] = await Promise.all([fsp.readFile(row.localPath), this.deployer.pool.run(this.server, (t) => t.readFile(row.remotePath))]);
        row.state = a.equals(b) ? 'equal' : 'different';
      }
    } else {
      row.state = st ? 'localOnly' : 'remoteOnly';
    }
    row.op = opsFor(row)[0];
    await this.post({ type: 'rowUpdate', row });
  }

  private async perform(ids: number[], ops: Record<number, SyncOp>): Promise<void> {
    const todo = ids
      .map((id) => this.rows.find((r) => r.id === id))
      .filter((r): r is SyncRow => !!r)
      .map((row) => ({ row, op: ops[row.id] ?? row.op }))
      .filter((x) => x.op !== 'none' && x.op !== 'skip');
    if (!todo.length) {
      return;
    }
    const deletes = todo.filter((x) => x.op === 'deleteLocal' || x.op === 'deleteRemote');
    if (deletes.length) {
      const ok = await vscode.window.showWarningMessage(
        `${deletes.length === 1 ? `"${deletes[0].row.rel}" will be deleted` : `${deletes.length} items will be deleted`} ${deletes.every((d) => d.op === 'deleteRemote') ? `on ${this.server.name}` : deletes.every((d) => d.op === 'deleteLocal') ? 'locally' : 'locally and on the server'}. Continue?`,
        { modal: true },
        'Synchronize',
      );
      if (!ok) {
        return;
      }
    }
    await this.post({ type: 'busy', text: `Synchronizing ${todo.length} item(s)…` });
    await this.deployer.withOperation(this.project, [this.server], `Sync ${path.basename(this.localRoot)}`, {}, async (ctx: Ctx) => {
      // Each operation was chosen explicitly: no up-to-date skipping or overwrite prompts.
      ctx.options = { ...ctx.options, overwriteUpToDate: true, promptOnRemoteOverwrite: 'none', promptOnLocalOverwrite: false };
      for (const { row, op } of todo) {
        if (ctx.token.isCancellationRequested) {
          throw new CancelledError();
        }
        try {
          switch (op) {
            case 'upload':
              await this.deployer.uploadFile(ctx, row.localPath, row.remotePath, undefined, row.remote ? undefined : null);
              break;
            case 'download': {
              const entry = await this.deployer.pool.run(this.server, (t) => t.stat(row.remotePath));
              if (entry) {
                await this.deployer.downloadFile(ctx, entry, row.localPath);
              }
              break;
            }
            case 'deleteRemote': {
              const entry = await this.deployer.pool.run(this.server, (t) => t.stat(row.remotePath));
              if (entry) {
                await this.deployer.deleteRemoteTree(ctx, entry);
              }
              break;
            }
            case 'deleteLocal':
              await vscode.workspace.fs.delete(vscode.Uri.file(row.localPath), { useTrash: true });
              this.deployer.log.count(ctx.op, 'deleted');
              break;
          }
        } catch (e) {
          if (e instanceof CancelledError) {
            throw e;
          }
          this.deployer.log.error(ctx.op, `${row.rel}: ${(e as Error).message}`, row.localPath);
        }
      }
    });
    await this.compare();
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const media = (f: string): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(SyncPanel.extensionUri, 'dist', 'media', f));
    const csp = [
      "default-src 'none'",
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
      'worker-src blob:',
    ].join('; ');
    const config = JSON.stringify({ workerUrl: media('editor.worker.js').toString(), server: this.server.name });
    return /* html */ `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${media('codicon.css')}">
<link rel="stylesheet" href="${media('sync.css')}">
<style>
  :root {
    --added: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
    --modified: var(--vscode-gitDecoration-modifiedResourceForeground, #6c9ef8);
    --conflict: var(--vscode-gitDecoration-conflictingResourceForeground, #e4676b);
    --border: var(--vscode-panel-border, rgba(128,128,128,.35));
    --cols: minmax(120px, 1fr) 80px 136px 30px 136px 80px minmax(120px, 1fr);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; padding: 0; display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; }
  .toolbar, .difftools { display: flex; align-items: center; gap: 2px; padding: 3px 6px; flex: none; user-select: none; }
  .toolbar { border-bottom: 1px solid var(--border); }
  .sep { width: 1px; height: 18px; background: var(--border); margin: 0 6px; }
  .tb { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 24px; padding: 0 4px; border: 1px solid transparent; border-radius: 4px; background: none; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; font: inherit; }
  /* Selected toggles and rows share one neutral tint derived from the theme's text color. */
  :root { --accent: var(--vscode-focusBorder, #0078d4); --ease: 120ms ease-out;
    --sel: color-mix(in srgb, var(--vscode-foreground) 13%, transparent);
    --sel-strong: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
    --sel-soft: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
  .tb { transition: background-color var(--ease), border-color var(--ease), color var(--ease), opacity var(--ease); }
  .tb:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  .tb:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
  .tb.on { background: var(--sel); border-color: var(--sel-soft); }
  .tb.on:hover:not(:disabled) { background: var(--sel-strong); }
  .tb:disabled { opacity: .35; cursor: default; }
  .tb .glyph { font-weight: 600; font-size: 14px; line-height: 1; transition: opacity var(--ease); }
  .tb[data-f] { min-width: 28px; }
  .tb[data-f]:not(.on) .glyph { opacity: .4; }
  .g-new-left, .g-new-right { color: var(--added); } .g-diff { color: var(--modified); }
  label.inline { display: inline-flex; align-items: center; gap: 6px; margin-left: 4px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--border)); border-radius: 3px; padding: 2px 4px; font: inherit; }
  .spacer { flex: 1; }
  .filter { display: inline-flex; align-items: center; gap: 4px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 3px; padding: 0 6px; width: 260px; height: 24px; }
  .filter input { flex: 1; border: none; outline: none; background: transparent; color: var(--vscode-input-foreground); font: inherit; min-width: 0; }
  .filter:focus-within { border-color: var(--vscode-focusBorder); }
  .paths { display: grid; grid-template-columns: 1fr 1fr; flex: none; border-bottom: 1px solid var(--border); }
  .path { display: flex; align-items: center; gap: 6px; padding: 3px 6px; min-width: 0; }
  .path + .path { border-left: 1px solid var(--border); }
  .path .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); padding: 2px 6px; border-radius: 3px; direction: rtl; text-align: left; }
  #main { flex: 1; display: flex; flex-direction: column; min-height: 0; --top: 40%; }
  .table { flex: none; height: var(--top); display: flex; flex-direction: column; min-height: 0; outline: none; position: relative; user-select: none; }
  .row { display: grid; grid-template-columns: var(--cols); align-items: center; height: 22px; white-space: nowrap; }
  .row > div { overflow: hidden; text-overflow: ellipsis; padding: 0 6px; }
  .head { flex: none; font-weight: 600; border-bottom: 1px solid var(--border); }
  .head > div { border-right: 1px solid var(--border); height: 100%; display: flex; align-items: center; }
  .head > div:last-child { border-right: none; }
  #body { flex: 1; overflow-y: auto; overflow-x: hidden; }
  /* Selection: the neutral tint with a 2px edge on the current row, keeping the status colors readable. */
  #body .row { transition: background-color var(--ease), box-shadow var(--ease); }
  #body .row:hover { background: var(--vscode-list-hoverBackground); }
  #body .row.sel, #body .row.sel:hover { background: var(--sel-soft); }
  .table:focus-within #body .row.sel, .table:focus-within #body .row.sel:hover { background: var(--sel); }
  #body .row.cursor { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
  .table:focus-within #body .row.cursor { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--vscode-foreground) 55%, transparent); }
  @media (prefers-reduced-motion: reduce) { .tb, .tb .glyph, #body .row { transition: none; } }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .date { font-variant-numeric: tabular-nums; }
  .op { text-align: center; padding: 0 !important; cursor: pointer; font-weight: 700; border-left: 1px solid var(--border); border-right: 1px solid var(--border); height: 100%; display: flex; align-items: center; justify-content: center; }
  .op:hover { background: var(--vscode-toolbar-hoverBackground); }
  .name { display: flex; align-items: center; gap: 5px; }
  .name .codicon { flex: none; opacity: .85; }
  .name .dir { opacity: .6; }
  .st-different .name { color: var(--modified); }
  .st-conflict .name { color: var(--conflict); }
  .st-localOnly .lname, .st-remoteOnly .rname { color: var(--added); }
  .op-upload, .op-download { color: var(--vscode-textLink-foreground); }
  .op-deleteLocal, .op-deleteRemote { color: var(--vscode-errorForeground); }
  .op-skip { color: var(--conflict); }
  .op-none { opacity: .55; }
  #status { position: absolute; top: 60px; left: 0; right: 0; text-align: center; opacity: .75; pointer-events: none; }
  .error { color: var(--vscode-errorForeground); }
  .hint { flex: none; text-align: center; font-size: 11px; opacity: .7; padding: 2px; border-top: 1px solid var(--border); display: flex; justify-content: center; gap: 12px; user-select: none; }
  #splitter { flex: none; height: 5px; cursor: ns-resize; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--vscode-editorGroupHeader-tabsBackground, transparent); }
  #splitter:hover { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); }
  .diffpane { flex: 1; display: flex; flex-direction: column; min-height: 0; position: relative; }
  .difftools { border-bottom: 1px solid var(--border); }
  #diffCount { margin-right: 8px; opacity: .9; }
  .titles { display: grid; grid-template-columns: 1fr 1fr; flex: none; font-size: 12px; border-bottom: 1px solid var(--border); }
  body.unified .titles .t-remote { display: none; }
  body.unified .titles { grid-template-columns: 1fr; }
  .titles > div { display: flex; align-items: center; gap: 6px; padding: 2px 8px; min-width: 0; }
  .titles > div + div { border-left: 1px solid var(--border); }
  .titles .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; flex: 1; direction: rtl; text-align: left; }
  .dirty { color: var(--vscode-editorWarning-foreground, #cca700); white-space: nowrap; }
  #diff { flex: 1; min-height: 0; }
  #diffMessage { position: absolute; top: 90px; left: 0; right: 0; text-align: center; opacity: .75; }
  .menu { position: absolute; right: 6px; top: 30px; z-index: 10; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, inherit); border: 1px solid var(--vscode-menu-border, var(--border)); border-radius: 4px; padding: 4px 0; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.4)); }
  .menu label { display: flex; gap: 8px; align-items: center; padding: 4px 12px; cursor: pointer; white-space: nowrap; }
  .menu label:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
  /* Copy arrows: a small round chip centred in the decorations column, with breathing room on both sides. */
  .monaco-editor .arrow-accept, .monaco-editor .arrow-push { display: flex !important; align-items: center; justify-content: center; cursor: pointer; }
  .monaco-editor .arrow-accept::before, .monaco-editor .arrow-push::before {
    font: normal normal normal 12px/16px codicon; width: 16px; height: 16px; border-radius: 50%; text-align: center;
    color: var(--vscode-textLink-foreground, #4daafc);
    background: color-mix(in srgb, var(--vscode-textLink-foreground, #4daafc) 16%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-textLink-foreground, #4daafc) 28%, transparent);
    transition: background-color 140ms ease-out, color 140ms ease-out, transform 140ms ease-out;
  }
  .monaco-editor .arrow-accept::before { content: '\\ea9b'; }
  .monaco-editor .arrow-push::before { content: '\\ea9c'; }
  .monaco-editor .arrow-accept:hover::before, .monaco-editor .arrow-push:hover::before {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-textLink-foreground, #4daafc);
    transform: scale(1.12);
  }
  @media (prefers-reduced-motion: reduce) { .monaco-editor .arrow-accept::before, .monaco-editor .arrow-push::before { transition: none; } }
</style></head><body>
<div class="toolbar">
  <button class="tb" id="refresh" title="Refresh (Ctrl+R)"><i class="codicon codicon-refresh"></i></button>
  <span class="sep"></span>
  <button class="tb on" data-f="localOnly" title="Show new files on left side"><span class="glyph g-new-left">→</span></button>
  <button class="tb on" data-f="different" title="Show difference"><span class="glyph g-diff">≠</span></button>
  <button class="tb" data-f="equal" title="Show equal files"><span class="glyph">=</span></button>
  <button class="tb on" data-f="remoteOnly" title="Show new files on right side"><span class="glyph g-new-right">←</span></button>
  <span class="sep"></span>
  <label class="inline">Compare by:
    <select id="compareBy">
      <option value="content">Binary Content</option>
      <option value="size">Size</option>
      <option value="timestamp">Size and Timestamp</option>
    </select>
  </label>
  <span class="sep"></span>
  <button class="tb" id="syncSel" title="Synchronize Selected (Enter)"><i class="codicon codicon-debug-continue"></i></button>
  <button class="tb" id="syncAll" title="Synchronize All"><i class="codicon codicon-run-all"></i></button>
  <span class="spacer"></span>
  <label class="inline">Filter:
    <span class="filter"><i class="codicon codicon-search"></i><input id="filter" placeholder="name, * and ? wildcards"></span>
  </label>
</div>
<div class="paths">
  <div class="path"><i class="codicon codicon-folder"></i><span class="text" id="localPath"></span><button class="tb" id="chooseLocal" title="Choose local folder"><i class="codicon codicon-folder-opened"></i></button></div>
  <div class="path"><i class="codicon codicon-remote"></i><span class="text" id="remotePath"></span><button class="tb" id="chooseRemote" title="Choose folder on server"><i class="codicon codicon-folder-opened"></i></button></div>
</div>
<div id="main">
  <div class="table" id="table" tabindex="0">
    <div class="row head"><div>Name</div><div class="num">Size</div><div>Date</div><div class="op" style="cursor:default">*</div><div>Date</div><div class="num">Size</div><div>Name</div></div>
    <div id="body"></div>
    <div id="status"></div>
    <div class="hint"><span>Use Space button or mouse click to change operation for the selected elements. Enter to perform.</span><span id="summary"></span></div>
  </div>
  <div id="splitter" title="Drag to resize"></div>
  <div class="diffpane">
    <div class="difftools">
      <button class="tb" id="prevDiff" title="Previous Difference (Shift+F7)"><i class="codicon codicon-arrow-up"></i></button>
      <button class="tb" id="nextDiff" title="Next Difference (F7)"><i class="codicon codicon-arrow-down"></i></button>
      <span class="sep"></span>
      <button class="tb" id="editSource" title="Edit Source (F4)"><i class="codicon codicon-edit"></i></button>
      <span class="sep"></span>
      <button class="tb" id="prevFile" title="Compare Previous File"><i class="codicon codicon-arrow-left"></i></button>
      <button class="tb" id="nextFile" title="Compare Next File"><i class="codicon codicon-arrow-right"></i></button>
      <span class="sep"></span>
      <button class="tb" id="collapse" title="Collapse Unchanged Fragments"><i class="codicon codicon-fold"></i></button>
      <span class="spacer"></span>
      <span id="diffCount"></span>
      <button class="tb" id="sideBySide" title="Side-by-side viewer"><i class="codicon codicon-split-horizontal"></i></button>
      <button class="tb" id="unified" title="Unified viewer"><i class="codicon codicon-file"></i></button>
      <span class="sep"></span>
      <button class="tb" id="settings" title="Settings"><i class="codicon codicon-gear"></i></button>
      <div class="menu" id="settingsMenu" hidden>
        <label><input type="checkbox" id="optIgnoreWs"> Ignore whitespace</label>
        <label><input type="checkbox" id="optWrap"> Soft-wrap</label>
      </div>
    </div>
    <div class="titles">
      <div class="t-local"><i class="codicon codicon-folder"></i><span class="p" id="localTitle"></span><span class="dirty" id="localDirty"></span></div>
      <div class="t-remote"><button class="tb" id="lock"><i class="codicon codicon-lock"></i></button><span class="p" id="remoteTitle"></span><span class="dirty" id="remoteDirty"></span></div>
    </div>
    <div id="diff"></div>
    <div id="diffMessage">Select a file to compare.</div>
  </div>
</div>
<script nonce="${nonce}">window.__DEPLOY__ = ${config};</script>
<script nonce="${nonce}" src="${media('sync.js')}"></script>
</body></html>`;
  }
}

const MAX_DIFF_SIZE = 5 * 1024 * 1024;

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0);
}

const LANGUAGES: Record<string, string> = {
  php: 'php', phtml: 'php', inc: 'php', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'javascript', html: 'html', htm: 'html', vue: 'html', css: 'css', scss: 'scss', less: 'less', xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml',
  md: 'markdown', py: 'python', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell', ini: 'ini', env: 'ini', conf: 'ini', twig: 'twig', go: 'go',
  java: 'java', rb: 'ruby', rs: 'rust', cs: 'csharp', c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', kt: 'kotlin', swift: 'swift', hbs: 'handlebars',
  pug: 'pug', graphql: 'graphql', gql: 'graphql', ps1: 'powershell', bat: 'bat', cmd: 'bat',
};

function languageOf(rel: string): string {
  const base = rel.split('/').pop()!.toLowerCase();
  if (base === 'dockerfile') {
    return 'dockerfile';
  }
  if (base.endsWith('.blade.php')) {
    return 'html';
  }
  if (base.startsWith('.env')) {
    return 'ini';
  }
  return LANGUAGES[base.split('.').pop() ?? ''] ?? 'plaintext';
}
