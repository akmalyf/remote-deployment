// Minimal vscode API stub for running extension modules under plain Node.
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const answers: { warning: (msg: string, items: string[]) => string | undefined; input: () => string | undefined } = {
  warning: (_m, items) => items[0],
  input: () => undefined,
};
export const messages: string[] = [];

export class EventEmitter<T> {
  private l: ((e: T) => void)[] = [];
  event = (fn: (e: T) => void) => { this.l.push(fn); return { dispose: () => { this.l = this.l.filter((x) => x !== fn); } }; };
  fire(e: T) { for (const f of this.l) f(e); }
  dispose() { this.l = []; }
}
export class Disposable {
  constructor(private fn: () => void) {}
  static from(...d: { dispose(): unknown }[]) { return new Disposable(() => d.forEach((x) => x.dispose())); }
  dispose() { this.fn(); }
}
export class Uri {
  constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '', readonly fragment = '') {}
  static file(p: string) { return new Uri('file', '', path.resolve(p)); }
  static parse(s: string) { const u = new URL(s); return u.protocol === 'file:' ? Uri.file(fileURLToPath(u)) : new Uri(u.protocol.slice(0, -1), u.host, decodeURIComponent(u.pathname), u.search.slice(1)); }
  static from(c: { scheme: string; authority?: string; path?: string; query?: string }) { return new Uri(c.scheme, c.authority ?? '', c.path ?? '/', c.query ?? ''); }
  get fsPath() { return this.path; }
  with(c: Partial<{ scheme: string; path: string }>) { return new Uri(c.scheme ?? this.scheme, this.authority, c.path ?? this.path, this.query); }
  toString() { return this.scheme === 'file' ? pathToFileURL(this.path).toString() : `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}`; }
}
export class CancellationTokenSource { token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }; cancel() { this.token.isCancellationRequested = true; } }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum TreeItemCollapsibleState { None, Collapsed, Expanded }
export enum QuickPickItemKind { Separator = -1, Default = 0 }
export class ThemeIcon { constructor(readonly id: string, readonly color?: unknown) {} }
export class ThemeColor { constructor(readonly id: string) {} }
export class TreeItem { constructor(readonly label: string, readonly collapsibleState?: number) {} }
export class MarkdownString { isTrusted = false; constructor(readonly value: string) {} }
export class RelativePattern { constructor(readonly base: unknown, readonly pattern: string) {} }
export class FileSystemError extends Error { static FileNotFound(u?: unknown) { return new FileSystemError(`not found ${u}`); } static NoPermissions(m?: string) { return new FileSystemError(m); } static Unavailable(m?: string) { return new FileSystemError(m); } }
const watcher = () => ({ onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} });
const log = (level: string) => (m: string) => messages.push(`${level}: ${m}`);
export const window = {
  showWarningMessage: async (m: string, ...rest: unknown[]) => { const items = rest.filter((x) => typeof x === 'string') as string[]; messages.push(`WARN ${m}`); return answers.warning(m, items); },
  showInformationMessage: async (m: string) => { messages.push(`INFO ${m}`); return undefined; },
  showErrorMessage: async (m: string) => { messages.push(`ERROR ${m}`); return undefined; },
  showInputBox: async () => answers.input(),
  showQuickPick: async () => undefined,
  setStatusBarMessage: (m: string) => { messages.push(`STATUS ${m}`); return { dispose() {} }; },
  withProgress: async (_o: unknown, fn: (p: unknown, t: unknown) => Promise<unknown>) => fn({ report() {} }, new CancellationTokenSource().token),
  createOutputChannel: () => ({ info: log('info'), warn: log('warn'), error: log('error'), show() {}, dispose() {} }),
  activeTextEditor: undefined,
};
export const workspace = {
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  createFileSystemWatcher: watcher,
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  getWorkspaceFolder: () => undefined,
  workspaceFolders: [] as unknown[],
  fs: { delete: async (u: Uri) => fsp.rm(u.fsPath, { recursive: true, force: true }) },
};
export const commands = { executeCommand: async () => undefined };
export const env = { clipboard: { writeText: async () => undefined } };
