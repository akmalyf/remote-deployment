import * as vscode from 'vscode';
import type { LogLevel } from './config';

export type OpStatus = 'running' | 'ok' | 'warning' | 'error' | 'cancelled';

export interface LogLine {
  time: Date;
  level: 'info' | 'warn' | 'error' | 'detail';
  text: string;
  path?: string;
}

export interface Operation {
  id: number;
  title: string;
  server: string;
  started: Date;
  finished?: Date;
  status: OpStatus;
  summary?: string;
  lines: LogLine[];
  counts: Record<string, number>;
}

const COUNT_LABELS: Record<string, [string, string]> = {
  transferred: ['file transferred', 'files transferred'],
  foldersCreated: ['folder created', 'folders created'],
  deleted: ['item deleted', 'items deleted'],
  upToDate: ['file is up to date', 'files are up to date'],
  excluded: ['item excluded', 'items excluded'],
  skippedByUser: ['file skipped by user', 'files skipped by user'],
  failed: ['failed', 'failed'],
  moved: ['item moved', 'items moved'],
  copied: ['item copied', 'items copied'],
};

/** The "File Transfer" tool window: one node per operation, and a log output channel. */
export class TransferLog implements vscode.TreeDataProvider<Operation | LogLine>, vscode.Disposable {
  private readonly ops: Operation[] = [];
  private nextId = 1;
  readonly output = vscode.window.createOutputChannel('Deployment', { log: true });
  private readonly emitter = new vscode.EventEmitter<Operation | LogLine | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly parents = new WeakMap<LogLine, Operation>();
  level: LogLevel = 'brief';

  start(title: string, server: string): Operation {
    const op: Operation = { id: this.nextId++, title, server, started: new Date(), status: 'running', lines: [], counts: {} };
    this.ops.unshift(op);
    if (this.ops.length > 200) {
      this.ops.pop();
    }
    this.output.info(`[${server}] ${title}`);
    this.emitter.fire();
    return op;
  }

  private add(op: Operation, line: LogLine): void {
    op.lines.push(line);
    this.parents.set(line, op);
    if (line.level === 'error') {
      this.output.error(`[${op.server}] ${line.text}`);
    } else if (line.level === 'warn') {
      this.output.warn(`[${op.server}] ${line.text}`);
    } else if (this.level === 'details' || line.level === 'info') {
      this.output.info(`[${op.server}] ${line.text}`);
    }
    this.emitter.fire(op);
  }

  detail(op: Operation, text: string, path?: string): void {
    if (this.level === 'details') {
      this.add(op, { time: new Date(), level: 'detail', text, path });
    }
  }

  info(op: Operation, text: string, path?: string): void {
    if (this.level !== 'errors') {
      this.add(op, { time: new Date(), level: 'info', text, path });
    }
  }

  warn(op: Operation, text: string, path?: string): void {
    this.add(op, { time: new Date(), level: 'warn', text, path });
  }

  error(op: Operation, text: string, path?: string): void {
    op.counts.failed = (op.counts.failed ?? 0) + 1;
    this.add(op, { time: new Date(), level: 'error', text, path });
  }

  count(op: Operation, key: keyof typeof COUNT_LABELS, n = 1): void {
    op.counts[key] = (op.counts[key] ?? 0) + n;
  }

  finish(op: Operation, status?: OpStatus): void {
    op.finished = new Date();
    op.status = status ?? (op.counts.failed ? 'error' : op.lines.some((l) => l.level === 'warn') ? 'warning' : 'ok');
    const parts = Object.entries(op.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => {
        const [one, many] = COUNT_LABELS[k] ?? [k, k];
        return `${n} ${n === 1 ? one : many}`;
      });
    const secs = ((op.finished.getTime() - op.started.getTime()) / 1000).toFixed(1);
    op.summary = `${parts.join(', ') || 'nothing to do'} in ${secs}s`;
    if (status === 'cancelled') {
      op.summary = `cancelled: ${op.summary}`;
    }
    const line = `[${op.server}] ${op.title}: ${op.summary}`;
    if (op.status === 'error') {
      this.output.error(line);
    } else {
      this.output.info(line);
    }
    this.emitter.fire();
  }

  clear(): void {
    this.ops.splice(0, this.ops.length, ...this.ops.filter((o) => o.status === 'running'));
    this.emitter.fire();
  }

  getTreeItem(e: Operation | LogLine): vscode.TreeItem {
    if ('id' in e) {
      const item = new vscode.TreeItem(e.title, e.lines.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.description = `${e.server} · ${e.started.toLocaleTimeString()}${e.summary ? ' · ' + e.summary : ''}`;
      const icons: Record<OpStatus, vscode.ThemeIcon> = {
        running: new vscode.ThemeIcon('sync~spin'),
        ok: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
        warning: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')),
        error: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
        cancelled: new vscode.ThemeIcon('circle-slash'),
      };
      item.iconPath = icons[e.status];
      item.contextValue = 'transfer';
      item.tooltip = `${e.title}\n${e.server}\n${e.summary ?? 'running…'}`;
      if (e.status === 'error') {
        item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      }
      return item;
    }
    const item = new vscode.TreeItem(e.text);
    item.description = e.time.toLocaleTimeString();
    item.tooltip = e.path ? `${e.text}\n${e.path}` : e.text;
    item.iconPath = new vscode.ThemeIcon(e.level === 'error' ? 'error' : e.level === 'warn' ? 'warning' : e.level === 'info' ? 'info' : 'debug-stackframe-dot');
    if (e.path && !e.path.startsWith('/')) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(e.path)] };
    }
    return item;
  }

  getChildren(e?: Operation | LogLine): (Operation | LogLine)[] {
    if (!e) {
      return this.ops;
    }
    return 'id' in e ? e.lines.slice(-500) : [];
  }

  getParent(e: Operation | LogLine): Operation | undefined {
    return 'id' in e ? undefined : this.parents.get(e);
  }

  async showDetails(op: Operation): Promise<void> {
    const text = [
      `${op.title}`,
      `Server: ${op.server}`,
      `Started: ${op.started.toLocaleString()}`,
      op.finished ? `Finished: ${op.finished.toLocaleString()}` : 'Running',
      op.summary ? `Result: ${op.summary}` : '',
      '',
      ...op.lines.map((l) => `${l.time.toLocaleTimeString()} ${l.level.toUpperCase().padEnd(6)} ${l.text}${l.path ? `  (${l.path})` : ''}`),
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose(): void {
    this.output.dispose();
    this.emitter.dispose();
  }
}
