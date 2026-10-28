import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionPool } from '../transport/pool';
import { RemoteEntry, Transport } from '../transport/types';
import { Options, Server } from './config';
import { Operation, TransferLog } from './log';
import { Excluder, joinRemote, localForRemote, parseOctal, remoteForLocal } from './paths';
import type { Project } from './project';
import { RevisionTracker } from './revisions';
import { canUseRsync, rsyncTransfer } from './rsync';

export interface Ctx {
  project: Project;
  server: Server;
  op: Operation;
  token: vscode.CancellationToken;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
  excluder: Excluder;
  options: Options;
  /** Explicit user action (not automatic upload): enables deleteMissingItems. */
  explicit: boolean;
  /** "for all" answers to conflict prompts in this operation. */
  decisions: Map<string, boolean>;
  knownDirs: Set<string>;
}

export interface TransferOptions {
  explicit?: boolean;
  /** Override options.deleteMissingItems. */
  deleteMissing?: boolean;
  /** Do not show a notification progress (automatic upload). */
  quiet?: boolean;
  title?: string;
}

const TIME_SLACK = 2000;

export function isUpToDate(local: fs.Stats, remote: RemoteEntry, preserveTimestamps: boolean): boolean {
  if (remote.isDir || local.size !== remote.size || !remote.mtime) {
    return false;
  }
  const diff = remote.mtime - local.mtimeMs;
  return Math.abs(diff) < TIME_SLACK || (!preserveTimestamps && diff > 0);
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

export class Deployer {
  constructor(
    readonly pool: ConnectionPool,
    readonly log: TransferLog,
    readonly revisions: RevisionTracker,
  ) {}

  private t<T>(ctx: Ctx, fn: (t: Transport) => Promise<T>): Promise<T> {
    if (ctx.token.isCancellationRequested) {
      throw new CancelledError();
    }
    return this.pool.run(ctx.server, fn);
  }

  /** Run `body` for each server with a progress notification and a File Transfer entry. */
  async withOperation(
    project: Project,
    servers: Server[],
    title: string,
    opts: TransferOptions,
    body: (ctx: Ctx) => Promise<void>,
  ): Promise<boolean> {
    let allOk = true;
    this.log.level = project.config.options.logLevel;
    for (const server of servers) {
      const op = this.log.start(title, server.name);
      const run = async (
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken,
      ): Promise<void> => {
        const ctx: Ctx = {
          project,
          server,
          op,
          token,
          progress,
          excluder: project.excluder(server),
          options: project.config.options,
          explicit: opts.explicit ?? true,
          decisions: new Map(),
          knownDirs: new Set(),
        };
        try {
          await body(ctx);
          this.log.finish(op);
        } catch (e) {
          if (e instanceof CancelledError || token.isCancellationRequested) {
            this.log.finish(op, 'cancelled');
          } else {
            this.log.error(op, (e as Error).message);
            this.log.finish(op, 'error');
          }
        }
        if (op.status === 'error') {
          allOk = false;
        }
      };
      if (opts.quiet) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `$(cloud-upload) ${server.name}` },
          (progress) => run(progress, new vscode.CancellationTokenSource().token),
        );
      } else {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `${title} — ${server.name}`, cancellable: true },
          run,
        );
      }
      if (op.status === 'error') {
        const show = await vscode.window.showErrorMessage(`Deployment: ${title} on ${server.name}: ${op.summary}`, 'Show Details');
        if (show) {
          await vscode.commands.executeCommand('deploy.fileTransfer.focus');
        }
      } else if (!opts.quiet && op.status === 'ok') {
        vscode.window.setStatusBarMessage(`$(check) ${server.name}: ${op.summary}`, 5000);
      }
    }
    return allOk;
  }

  // ---------------------------------------------------------------- prompts

  private async ask(ctx: Ctx, kind: string, message: string, yes: string, no: string): Promise<boolean> {
    const remembered = ctx.decisions.get(kind);
    if (remembered !== undefined) {
      return remembered;
    }
    const yesAll = `${yes} All`;
    const noAll = `${no} All`;
    const answer = await vscode.window.showWarningMessage(message, { modal: true }, yes, yesAll, no, noAll);
    if (answer === undefined) {
      throw new CancelledError();
    }
    if (answer === yesAll || answer === noAll) {
      ctx.decisions.set(kind, answer === yesAll);
    }
    return answer === yes || answer === yesAll;
  }

  // ---------------------------------------------------------------- remote helpers

  async ensureRemoteDir(ctx: Ctx, dir: string): Promise<void> {
    if (dir === '/' || ctx.knownDirs.has(dir)) {
      return;
    }
    const st = await this.t(ctx, (t) => t.stat(dir));
    if (st?.isDir) {
      ctx.knownDirs.add(dir);
      return;
    }
    await this.ensureRemoteDir(ctx, path.posix.dirname(dir));
    await this.t(ctx, (t) => t.mkdir(dir));
    const mode = parseOctal(ctx.options.folderPermissions);
    if (mode !== undefined) {
      await this.t(ctx, async (t) => t.chmod?.(dir, mode)).catch((e) => this.log.warn(ctx.op, `chmod ${dir}: ${e.message}`));
    }
    ctx.knownDirs.add(dir);
    this.log.count(ctx.op, 'foldersCreated');
    this.log.detail(ctx.op, `Created folder ${dir}`, dir);
  }

  async deleteRemoteTree(ctx: Ctx, entry: RemoteEntry): Promise<void> {
    if (entry.isDir && !entry.isSymlink) {
      const children = await this.t(ctx, (t) => t.list(entry.path));
      for (const c of children) {
        await this.deleteRemoteTree(ctx, c);
      }
      await this.t(ctx, (t) => t.deleteDir(entry.path));
    } else {
      await this.t(ctx, (t) => t.deleteFile(entry.path));
    }
    this.revisions.delete(ctx.server, entry.path);
    this.log.count(ctx.op, 'deleted');
    this.log.detail(ctx.op, `Deleted ${entry.path}`, entry.path);
  }

  // ---------------------------------------------------------------- upload

  async uploadFile(ctx: Ctx, local: string, remote: string, stat?: fs.Stats, remoteEntry?: RemoteEntry | null): Promise<void> {
    const st = stat ?? (await fsp.stat(local));
    ctx.progress.report({ message: path.basename(local) });
    const existing = remoteEntry === null ? undefined : (remoteEntry ?? (await this.t(ctx, (t) => t.stat(remote))));
    if (existing?.isDir) {
      throw new Error(`${remote} is a folder on the server`);
    }
    if (existing && !ctx.options.overwriteUpToDate && isUpToDate(st, existing, ctx.options.preserveTimestamps)) {
      this.log.count(ctx.op, 'upToDate');
      this.log.detail(ctx.op, `Up to date: ${remote}`, local);
      return;
    }
    if (existing && ctx.options.promptOnRemoteOverwrite !== 'none') {
      const rev = this.revisions.get(ctx.server, remote);
      let changed = rev ? rev.mtime !== existing.mtime || rev.size !== existing.size : existing.mtime > st.mtimeMs + TIME_SLACK;
      if (changed && ctx.options.promptOnRemoteOverwrite === 'content') {
        const [a, b] = await Promise.all([fsp.readFile(local), this.t(ctx, (t) => t.readFile(remote))]);
        if (a.equals(b)) {
          this.log.count(ctx.op, 'upToDate');
          this.revisions.set(ctx.server, remote, { mtime: existing.mtime, size: existing.size });
          return;
        }
        changed = true;
      }
      if (
        changed &&
        !(await this.ask(
          ctx,
          'remoteNewer',
          `"${remote}" on ${ctx.server.name} was modified since it was last uploaded or downloaded (${new Date(existing.mtime).toLocaleString()}). Overwrite it?`,
          'Overwrite',
          'Skip',
        ))
      ) {
        this.log.count(ctx.op, 'skippedByUser');
        this.log.info(ctx.op, `Skipped (remote is newer): ${remote}`, local);
        return;
      }
    }
    await this.ensureRemoteDir(ctx, path.posix.dirname(remote));
    if (ctx.options.useTempFile) {
      const tmp = path.posix.join(path.posix.dirname(remote), `.${path.posix.basename(remote)}.${Date.now()}.tmp`);
      await this.t(ctx, (t) => t.uploadFile(local, tmp));
      if (existing && ctx.server.type === 'ftp') {
        await this.t(ctx, (t) => t.deleteFile(remote)).catch(() => undefined);
      }
      await this.t(ctx, (t) => t.rename(tmp, remote));
    } else {
      await this.t(ctx, (t) => t.uploadFile(local, remote));
    }
    await this.afterUpload(ctx, remote, st);
    this.log.count(ctx.op, 'transferred');
    this.log.detail(ctx.op, `Uploaded ${remote}`, local);
  }

  private async afterUpload(ctx: Ctx, remote: string, st: fs.Stats): Promise<void> {
    const mode = parseOctal(ctx.options.filePermissions);
    if (mode !== undefined) {
      await this.t(ctx, async (t) => t.chmod?.(remote, mode)).catch((e) => this.log.warn(ctx.op, `chmod ${remote}: ${e.message}`));
    }
    if (ctx.options.preserveTimestamps) {
      await this.t(ctx, async (t) => t.setMtime?.(remote, st.mtimeMs)).catch((e) => this.log.detail(ctx.op, `Timestamp of ${remote}: ${e.message}`));
    }
    const after = await this.t(ctx, (t) => t.stat(remote)).catch(() => undefined);
    if (after) {
      this.revisions.set(ctx.server, remote, { mtime: after.mtime, size: after.size });
    }
  }

  /** Upload a local file or folder to an explicit remote path. */
  async uploadTree(ctx: Ctx, local: string, remote: string, deleteMissing: boolean): Promise<void> {
    if (ctx.excluder.isLocalExcluded(ctx.project.root, local) || ctx.excluder.isRemoteExcluded(ctx.project.root, remote)) {
      this.log.count(ctx.op, 'excluded');
      this.log.detail(ctx.op, `Excluded ${local}`, local);
      return;
    }
    let st: fs.Stats;
    try {
      st = await fsp.stat(local);
    } catch {
      this.log.warn(ctx.op, `Local item does not exist: ${local}`, local);
      return;
    }
    if (!st.isDirectory()) {
      await this.uploadFile(ctx, local, remote, st);
      return;
    }
    if (canUseRsync(ctx.server)) {
      const ok = await rsyncTransfer(this, ctx, 'upload', local, remote, deleteMissing);
      if (ok) {
        return;
      }
    }
    await this.uploadDir(ctx, local, remote, deleteMissing);
  }

  private async uploadDir(ctx: Ctx, local: string, remote: string, deleteMissing: boolean): Promise<void> {
    const entries = await fsp.readdir(local, { withFileTypes: true });
    const remoteList = await this.t(ctx, (t) => t.list(remote)).catch(() => undefined);
    const remoteByName = new Map((remoteList ?? []).map((e) => [e.name, e]));
    if (remoteList) {
      ctx.knownDirs.add(remote);
    } else if (ctx.options.createEmptyFolders || entries.length) {
      // Created lazily by the first file; created now only when empty folders are wanted.
      if (ctx.options.createEmptyFolders) {
        await this.ensureRemoteDir(ctx, remote);
      }
    }
    const localNames = new Set<string>();
    for (const e of entries) {
      if (ctx.token.isCancellationRequested) {
        throw new CancelledError();
      }
      const lp = path.join(local, e.name);
      const rp = joinRemote(remote, e.name);
      localNames.add(e.name);
      if (ctx.excluder.isLocalExcluded(ctx.project.root, lp) || ctx.excluder.isRemoteExcluded(ctx.project.root, rp)) {
        this.log.count(ctx.op, 'excluded');
        continue;
      }
      let st: fs.Stats;
      try {
        st = await fsp.stat(lp);
      } catch {
        continue; // dangling link
      }
      try {
        if (st.isDirectory()) {
          await this.uploadDir(ctx, lp, rp, deleteMissing);
        } else {
          await this.uploadFile(ctx, lp, rp, st, remoteByName.get(e.name) ?? (remoteList ? null : undefined));
        }
      } catch (err) {
        if (err instanceof CancelledError) {
          throw err;
        }
        this.log.error(ctx.op, `${rp}: ${(err as Error).message}`, lp);
      }
    }
    if (deleteMissing && remoteList) {
      for (const r of remoteList) {
        if (!localNames.has(r.name) && !ctx.excluder.isRemoteExcluded(ctx.project.root, r.path)) {
          if (ctx.options.confirmBeforeDeletion && !(await this.ask(ctx, 'deleteRemote', `Delete "${r.path}" on ${ctx.server.name}? It does not exist locally.`, 'Delete', 'Keep'))) {
            continue;
          }
          await this.deleteRemoteTree(ctx, r).catch((e) => this.log.error(ctx.op, `${r.path}: ${e.message}`, r.path));
        }
      }
    }
  }

  /** Upload local items through the server mappings. Items outside every mapping are reported. */
  async upload(project: Project, servers: Server[], locals: string[], opts: TransferOptions = {}): Promise<boolean> {
    const options = project.config.options;
    if (opts.explicit !== false && !(await confirmUpload(project, servers, locals))) {
      return false;
    }
    return this.withOperation(project, servers, opts.title ?? uploadTitle(locals), opts, async (ctx) => {
      const deleteMissing = (opts.deleteMissing ?? options.deleteMissingItems) && ctx.explicit;
      for (const local of locals) {
        const remote = remoteForLocal(project.root, ctx.server, local);
        if (!remote) {
          this.log.warn(ctx.op, `No mapping for ${local}`, local);
          continue;
        }
        try {
          await this.uploadTree(ctx, local, remote, deleteMissing);
        } catch (e) {
          if (e instanceof CancelledError) {
            throw e;
          }
          this.log.error(ctx.op, `${remote}: ${(e as Error).message}`, local);
        }
      }
    });
  }

  // ---------------------------------------------------------------- download

  async downloadFile(ctx: Ctx, remote: RemoteEntry, local: string): Promise<void> {
    ctx.progress.report({ message: remote.name });
    const st = await fsp.stat(local).catch(() => undefined);
    if (st?.isDirectory()) {
      throw new Error(`${local} is a folder`);
    }
    if (st && !ctx.options.overwriteUpToDate && isUpToDate(st, remote, ctx.options.preserveTimestamps)) {
      this.log.count(ctx.op, 'upToDate');
      return;
    }
    if (
      st &&
      ctx.options.promptOnLocalOverwrite &&
      !(await this.ask(ctx, 'overwriteLocal', `Overwrite local file "${local}" with the version from ${ctx.server.name}?`, 'Overwrite', 'Skip'))
    ) {
      this.log.count(ctx.op, 'skippedByUser');
      return;
    }
    await fsp.mkdir(path.dirname(local), { recursive: true });
    const tmp = `${local}.${process.pid}.download`;
    try {
      await this.t(ctx, (t) => t.downloadFile(remote.path, tmp));
      await fsp.rename(tmp, local);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw e;
    }
    if (ctx.options.preserveTimestamps && remote.mtime) {
      const t = new Date(remote.mtime);
      await fsp.utimes(local, t, t).catch(() => undefined);
    }
    this.revisions.set(ctx.server, remote.path, { mtime: remote.mtime, size: remote.size });
    this.log.count(ctx.op, 'transferred');
    this.log.detail(ctx.op, `Downloaded ${remote.path}`, local);
  }

  async downloadTree(ctx: Ctx, remote: RemoteEntry, local: string, deleteMissing: boolean): Promise<void> {
    if (ctx.excluder.isRemoteExcluded(ctx.project.root, remote.path) || ctx.excluder.isLocalExcluded(ctx.project.root, local)) {
      this.log.count(ctx.op, 'excluded');
      return;
    }
    if (!remote.isDir) {
      await this.downloadFile(ctx, remote, local);
      return;
    }
    if (canUseRsync(ctx.server)) {
      const ok = await rsyncTransfer(this, ctx, 'download', local, remote.path, deleteMissing);
      if (ok) {
        return;
      }
    }
    const children = await this.t(ctx, (t) => t.list(remote.path));
    if (children.length || ctx.options.createEmptyFolders) {
      if (!fs.existsSync(local)) {
        await fsp.mkdir(local, { recursive: true });
        this.log.count(ctx.op, 'foldersCreated');
      }
    }
    const names = new Set<string>();
    for (const c of children) {
      if (ctx.token.isCancellationRequested) {
        throw new CancelledError();
      }
      names.add(c.name);
      try {
        await this.downloadTree(ctx, c, path.join(local, c.name), deleteMissing);
      } catch (e) {
        if (e instanceof CancelledError) {
          throw e;
        }
        this.log.error(ctx.op, `${c.path}: ${(e as Error).message}`, c.path);
      }
    }
    if (deleteMissing && fs.existsSync(local)) {
      for (const name of await fsp.readdir(local)) {
        const lp = path.join(local, name);
        if (names.has(name) || ctx.excluder.isLocalExcluded(ctx.project.root, lp)) {
          continue;
        }
        if (ctx.options.promptOnLocalOverwrite && !(await this.ask(ctx, 'deleteLocal', `Delete local "${lp}"? It does not exist on ${ctx.server.name}.`, 'Delete', 'Keep'))) {
          continue;
        }
        await vscode.workspace.fs.delete(vscode.Uri.file(lp), { recursive: true, useTrash: true });
        this.log.count(ctx.op, 'deleted');
      }
    }
  }

  async download(project: Project, server: Server, locals: string[], opts: TransferOptions = {}): Promise<boolean> {
    return this.withOperation(project, [server], opts.title ?? downloadTitle(locals.map((l) => path.basename(l))), opts, async (ctx) => {
      const deleteMissing = (opts.deleteMissing ?? ctx.options.deleteMissingItems) && ctx.explicit;
      for (const local of locals) {
        const remote = remoteForLocal(project.root, server, local);
        if (!remote) {
          this.log.warn(ctx.op, `No mapping for ${local}`, local);
          continue;
        }
        const entry = await this.t(ctx, (t) => t.stat(remote));
        if (!entry) {
          this.log.warn(ctx.op, `Not found on server: ${remote}`, local);
          continue;
        }
        await this.downloadTree(ctx, entry, local, deleteMissing);
      }
    });
  }

  /** Remote Host "Download from Here": to the mapped local path, or a chosen folder when unmapped. */
  async downloadRemote(project: Project, server: Server, entries: RemoteEntry[], targetDir?: string): Promise<boolean> {
    return this.withOperation(project, [server], downloadTitle(entries.map((e) => e.name)), {}, async (ctx) => {
      for (const e of entries) {
        const local = targetDir ? path.join(targetDir, e.name) : localForRemote(project.root, server, e.path);
        if (!local) {
          this.log.warn(ctx.op, `No mapping for ${e.path}`, e.path);
          continue;
        }
        await this.downloadTree(ctx, e, local, ctx.options.deleteMissingItems);
      }
    });
  }

  /** Remote Host "Upload Here" / drop: local items into a remote folder regardless of mappings. */
  async uploadInto(project: Project, server: Server, locals: string[], remoteDir: string): Promise<boolean> {
    if (!(await confirmUpload(project, [server], locals, remoteDir))) {
      return false;
    }
    return this.withOperation(project, [server], uploadTitle(locals), {}, async (ctx) => {
      for (const l of locals) {
        await this.uploadTree(ctx, l, joinRemote(remoteDir, path.basename(l)), false);
      }
    });
  }

  async deleteRemote(project: Project, server: Server, remotePaths: string[], opts: TransferOptions = {}): Promise<boolean> {
    return this.withOperation(project, [server], opts.title ?? `Delete ${remotePaths.length === 1 ? path.posix.basename(remotePaths[0]) : `${remotePaths.length} items`}`, opts, async (ctx) => {
      for (const p of remotePaths) {
        const entry = await this.t(ctx, (t) => t.stat(p));
        if (entry) {
          await this.deleteRemoteTree(ctx, entry).catch((e) => this.log.error(ctx.op, `${p}: ${e.message}`, p));
        }
      }
    });
  }

  /** Remote-to-remote copy/move on one server (Remote Host cut/copy/paste and drag and drop). */
  async copyRemote(project: Project, server: Server, sources: RemoteEntry[], targetDir: string, move: boolean): Promise<boolean> {
    return this.withOperation(project, [server], `${move ? 'Move' : 'Copy'} ${sources.length === 1 ? sources[0].name : `${sources.length} items`}`, {}, async (ctx) => {
      for (const src of sources) {
        let dest = joinRemote(targetDir, src.name);
        if (dest === src.path || dest.startsWith(src.path + '/')) {
          if (move) {
            continue;
          }
          dest = joinRemote(targetDir, `${src.name} copy`);
        }
        if (move) {
          await this.t(ctx, (t) => t.rename(src.path, dest));
          this.revisions.delete(server, src.path);
          this.log.count(ctx.op, 'moved');
          continue;
        }
        const viaShell = await this.t(ctx, async (t) => {
          if (!t.exec) {
            return false;
          }
          const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
          // Servers restricted to SFTP refuse exec channels: fall back to copying through the client.
          const r = await t.exec(`${server.sudo ? 'sudo -n ' : ''}cp -Rp ${q(src.path)} ${q(dest)}`).catch(() => undefined);
          return r?.code === 0;
        });
        if (!viaShell) {
          await this.copyViaClient(ctx, src, dest);
        }
        this.log.count(ctx.op, 'copied');
      }
    });
  }

  private async copyViaClient(ctx: Ctx, src: RemoteEntry, dest: string): Promise<void> {
    if (src.isDir) {
      await this.ensureRemoteDir(ctx, dest);
      for (const c of await this.t(ctx, (t) => t.list(src.path))) {
        await this.copyViaClient(ctx, c, joinRemote(dest, c.name));
      }
    } else {
      const data = await this.t(ctx, (t) => t.readFile(src.path));
      await this.t(ctx, (t) => t.writeFile(dest, data));
    }
  }
}

/** "Confirm before uploading": a modal naming the items and where they go. */
async function confirmUpload(project: Project, servers: Server[], locals: string[], remoteDir?: string): Promise<boolean> {
  if (!project.config.options.confirmBeforeUploading) {
    return true;
  }
  const what = locals.length === 1 ? `"${path.basename(locals[0])}"` : `${locals.length} items`;
  const where = servers.map((s) => s.name).join(', ');
  const shown = locals.slice(0, 8).map((l) => `• ${path.relative(project.root, l) || path.basename(l)}`);
  if (locals.length > 8) {
    shown.push(`… and ${locals.length - 8} more`);
  }
  const target = remoteDir ? `Into ${remoteDir} on ${where}` : `Through the mappings of ${where}`;
  const ok = await vscode.window.showWarningMessage(`Upload ${what} to ${where}?`, { modal: true, detail: `${shown.join('\n')}\n\n${target}.` }, 'Upload');
  return ok === 'Upload';
}

export function uploadTitle(locals: string[]): string {
  return locals.length === 1 ? `Upload ${path.basename(locals[0])}` : `Upload ${locals.length} items`;
}

export function downloadTitle(names: string[]): string {
  return names.length === 1 ? `Download ${names[0]}` : `Download ${names.length} items`;
}
