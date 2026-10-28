import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  Config,
  normalizeConfig,
  normalizeServer,
  resolveTarget,
  serializeOptions,
  serializeServer,
  Server,
  serverByName,
} from './config';
import { Excluder } from './paths';

const CONFIG_FILE = path.join('.vscode', 'deployment.json');
const GLOBAL_SERVERS_KEY = 'deploy.globalServers';

/** One workspace folder with its deployment configuration. */
export class Project implements vscode.Disposable {
  config: Config = normalizeConfig({});
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private selfWrite = 0;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly globalState: vscode.Memento,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.vscode/deployment.json'));
    const reload = (): void => {
      if (Date.now() - this.selfWrite > 1000) {
        this.load();
      }
    };
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
    this.load();
  }

  get root(): string {
    return this.folder.uri.fsPath;
  }

  get name(): string {
    return this.folder.name;
  }

  get configPath(): string {
    return path.join(this.root, CONFIG_FILE);
  }

  hasConfigFile(): boolean {
    return fs.existsSync(this.configPath);
  }

  load(): void {
    let raw: unknown = {};
    try {
      raw = JSON.parse(stripJsonComments(fs.readFileSync(this.configPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        void vscode.window.showErrorMessage(`Deployment: cannot read ${this.configPath}: ${(error as Error).message}`);
      }
    }
    const config = normalizeConfig(raw);
    // Servers shared between projects keep their connection settings in global state;
    // the project file only records their mappings and excluded paths.
    const globals = this.globalServers();
    config.servers = config.servers.map((s) => {
      if (!s.global) {
        return s;
      }
      const g = globals.find((x) => x.name === s.name);
      return g ? { ...g, global: true, mappings: s.mappings, excludedPaths: s.excludedPaths } : s;
    });
    for (const g of globals) {
      if (!config.servers.some((s) => s.name === g.name)) {
        config.servers.push({ ...g, global: true, mappings: [], excludedPaths: [] });
      }
    }
    this.config = config;
    this.emitter.fire();
  }

  globalServers(): Server[] {
    return (this.globalState.get<Partial<Server>[]>(GLOBAL_SERVERS_KEY) ?? []).map(normalizeServer);
  }

  async save(config: Config = this.config): Promise<void> {
    const globals = this.globalServers().filter((g) => !config.servers.some((s) => s.name === g.name && !s.global));
    for (const s of config.servers.filter((x) => x.global)) {
      const { mappings: _m, excludedPaths: _e, ...connection } = s;
      const i = globals.findIndex((g) => g.name === s.name);
      const entry = normalizeServer({ ...connection, mappings: [], excludedPaths: [] });
      if (i >= 0) {
        globals[i] = entry;
      } else {
        globals.push(entry);
      }
    }
    await this.globalState.update(
      GLOBAL_SERVERS_KEY,
      globals.map((g) => {
        const { mappings: _m, excludedPaths: _e, ...rest } = serializeServer(g);
        return rest;
      }),
    );

    const out: Record<string, unknown> = {};
    if (config.defaultServer) {
      out.defaultServer = config.defaultServer;
    }
    out.servers = config.servers
      // A global server without project mappings does not need a project entry.
      .filter((s) => !s.global || s.mappings.length || s.excludedPaths.length)
      .map((s) => (s.global ? { name: s.name, global: true, mappings: s.mappings, excludedPaths: s.excludedPaths } : serializeServer(s)));
    if (config.groups.length) {
      out.groups = config.groups;
    }
    const options = serializeOptions(config.options);
    if (Object.keys(options).length) {
      out.options = options;
    }
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    this.selfWrite = Date.now();
    fs.writeFileSync(this.configPath, JSON.stringify(out, null, 2) + '\n');
    this.config = config;
    this.load();
  }

  async update(mutate: (config: Config) => void): Promise<void> {
    const copy = structuredClone(this.config);
    mutate(copy);
    await this.save(copy);
  }

  server(name: string | undefined): Server | undefined {
    return serverByName(this.config, name);
  }

  defaultTargets(): Server[] {
    return resolveTarget(this.config, this.config.defaultServer);
  }

  excluder(server: Server): Excluder {
    return new Excluder(this.root, server, this.config.options);
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}

export class Projects implements vscode.Disposable {
  private readonly map = new Map<string, Project>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly globalState: vscode.Memento) {
    this.sync();
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.sync()));
  }

  private sync(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const [key, project] of this.map) {
      if (!folders.some((f) => f.uri.toString() === key)) {
        project.dispose();
        this.map.delete(key);
      }
    }
    for (const folder of folders) {
      const key = folder.uri.toString();
      if (!this.map.has(key)) {
        const project = new Project(folder, this.globalState);
        project.onDidChange(() => this.emitter.fire());
        this.map.set(key, project);
      }
    }
    this.emitter.fire();
  }

  all(): Project[] {
    return [...this.map.values()];
  }

  /** Reload every project (global servers changed in another project). */
  reloadAll(): void {
    for (const p of this.map.values()) {
      p.load();
    }
  }

  forUri(uri: vscode.Uri | undefined): Project | undefined {
    if (uri) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder) {
        return this.map.get(folder.uri.toString());
      }
      // Mappings can point outside the folder: pick a project whose mapping covers it.
      for (const p of this.map.values()) {
        if (p.config.servers.some((s) => s.mappings.some((m) => uri.fsPath.startsWith(path.resolve(p.root, m.local))))) {
          return p;
        }
      }
    }
    return this.active();
  }

  active(): Project | undefined {
    const editor = vscode.window.activeTextEditor?.document.uri;
    const folder = editor && vscode.workspace.getWorkspaceFolder(editor);
    if (folder) {
      return this.map.get(folder.uri.toString());
    }
    return this.all().find((p) => p.config.servers.length) ?? this.all()[0];
  }

  async pick(placeHolder = 'Select project'): Promise<Project | undefined> {
    const all = this.all();
    if (all.length <= 1) {
      return all[0];
    }
    const picked = await vscode.window.showQuickPick(
      all.map((p) => ({ label: p.name, description: p.root, project: p })),
      { placeHolder },
    );
    return picked?.project;
  }

  dispose(): void {
    for (const p of this.map.values()) {
      p.dispose();
    }
    this.emitter.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

/** Remove // and /* *\/ comments outside strings (VS Code's JSON flavour). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
