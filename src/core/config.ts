// Deployment configuration (`.vscode/deployment.json`); field names follow the .idea deployment options so imports map one to one.

export type Protocol = 'sftp' | 'ftp' | 'ftps' | 'local' | 'webdav';
export type AuthType = 'password' | 'key' | 'agent' | 'openSsh';
export type AutoUpload = 'always' | 'onExplicitSave' | 'never';
export type RemoteOverwriteCheck = 'none' | 'timestamp' | 'content';
export type LogLevel = 'errors' | 'brief' | 'details';
export type FtpsProtection = 'default' | 'clear' | 'private';

export interface Mapping {
  /** Relative to the project root, or absolute. */
  local: string;
  /** Relative to the server root path. */
  deploy: string;
  /** Relative to the web server URL. */
  web: string;
}

export interface ExcludedPath {
  path: string;
  /** true = local path, false = deployment path. */
  local: boolean;
}

export interface Server {
  name: string;
  type: Protocol;
  host: string;
  port?: number;
  user: string;
  auth: AuthType;
  keyPath?: string;
  rootPath: string;
  webUrl: string;
  passive: boolean;
  ftpsExplicit: boolean;
  ftpsProtection?: FtpsProtection;
  disableTls13?: boolean;
  showHidden?: boolean;
  keepAliveSecs?: number;
  timeoutSecs: number;
  ssl: boolean;
  rsync: boolean;
  sudo: boolean;
  /** Stored in user settings instead of the project file ("Visible only for this project" off). */
  global?: boolean;
  mappings: Mapping[];
  excludedPaths: ExcludedPath[];
}

export interface Group {
  name: string;
  servers: string[];
}

export interface Options {
  autoUpload: AutoUpload;
  uploadExternalChanges: boolean;
  overwriteUpToDate: boolean;
  preserveTimestamps: boolean;
  deleteMissingItems: boolean;
  deleteRemoteOnLocalDelete: boolean;
  createEmptyFolders: boolean;
  promptOnLocalOverwrite: boolean;
  promptOnRemoteOverwrite: RemoteOverwriteCheck;
  notifyRemoteChanges: boolean;
  excludeByName: string;
  filePermissions?: string;
  folderPermissions?: string;
  useTempFile: boolean;
  confirmBeforeUploading: boolean;
  confirmBeforeDeletion: boolean;
  uploadOnCommit?: string;
  logLevel: LogLevel;
  autoUploadDebounceMs: number;
  autoUploadConfirmOver: number;
}

export interface Config {
  defaultServer?: string;
  servers: Server[];
  groups: Group[];
  options: Options;
}

export const DEFAULT_OPTIONS: Options = {
  autoUpload: 'never',
  uploadExternalChanges: false,
  overwriteUpToDate: false,
  preserveTimestamps: true,
  deleteMissingItems: false,
  deleteRemoteOnLocalDelete: false,
  createEmptyFolders: false,
  promptOnLocalOverwrite: true,
  promptOnRemoteOverwrite: 'none',
  notifyRemoteChanges: false,
  excludeByName: '.svn;.cvs;.idea;.DS_Store;.git;.hg;.vscode',
  useTempFile: false,
  confirmBeforeUploading: true,
  confirmBeforeDeletion: true,
  logLevel: 'brief',
  autoUploadDebounceMs: 400,
  autoUploadConfirmOver: 100,
};

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  sftp: 'SFTP',
  ftp: 'FTP',
  ftps: 'FTPS',
  local: 'Local or mounted folder',
  webdav: 'WebDAV',
};

export function defaultPort(server: Pick<Server, 'type' | 'ftpsExplicit' | 'ssl'>): number {
  switch (server.type) {
    case 'sftp':
      return 22;
    case 'ftp':
      return 21;
    case 'ftps':
      return server.ftpsExplicit ? 21 : 990;
    case 'webdav':
      return server.ssl ? 443 : 80;
    default:
      return 0;
  }
}

export function portOf(server: Server): number {
  return server.port || defaultPort(server);
}

export function newServer(name: string, type: Protocol = 'sftp'): Server {
  return normalizeServer({ name, type });
}

export function normalizeServer(raw: Partial<Server> & { name?: string }): Server {
  const type = (raw.type ?? 'sftp') as Protocol;
  return {
    name: String(raw.name ?? 'server'),
    type,
    host: raw.host ?? '',
    port: raw.port ? Number(raw.port) : undefined,
    user: raw.user ?? '',
    auth: (raw.auth ?? 'password') as AuthType,
    keyPath: raw.keyPath || undefined,
    rootPath: raw.rootPath ?? (type === 'local' ? '' : '/'),
    webUrl: raw.webUrl ?? '',
    passive: raw.passive ?? true,
    ftpsExplicit: raw.ftpsExplicit ?? true,
    ftpsProtection: raw.ftpsProtection,
    disableTls13: raw.disableTls13,
    showHidden: raw.showHidden ?? true,
    keepAliveSecs: raw.keepAliveSecs,
    timeoutSecs: raw.timeoutSecs ?? 30,
    ssl: raw.ssl ?? true,
    rsync: raw.rsync ?? false,
    sudo: raw.sudo ?? false,
    global: raw.global || undefined,
    mappings: (raw.mappings?.length ? raw.mappings : [{ local: '.', deploy: '/', web: '/' }]).map((m) => ({
      local: m.local ?? '.',
      deploy: m.deploy ?? '/',
      web: m.web ?? '/',
    })),
    excludedPaths: (raw.excludedPaths ?? []).map((e) => ({ path: e.path, local: !!e.local })),
  };
}

export function normalizeConfig(raw: unknown): Config {
  const r = (raw ?? {}) as Partial<Config> & { options?: Partial<Options> };
  return {
    defaultServer: r.defaultServer || undefined,
    servers: (r.servers ?? []).map(normalizeServer),
    groups: (r.groups ?? []).map((g) => ({ name: String(g.name), servers: [...(g.servers ?? [])] })),
    options: { ...DEFAULT_OPTIONS, ...(r.options ?? {}) },
  };
}

/** Strip defaults so the saved JSON stays readable and diffable. */
export function serializeServer(s: Server): Record<string, unknown> {
  const out: Record<string, unknown> = { name: s.name, type: s.type };
  const put = (k: string, v: unknown, def?: unknown): void => {
    if (v !== undefined && v !== '' && v !== def) {
      out[k] = v;
    }
  };
  put('host', s.host);
  put('port', s.port);
  put('user', s.user);
  put('auth', s.auth, 'password');
  put('keyPath', s.keyPath);
  put('rootPath', s.rootPath);
  put('webUrl', s.webUrl);
  if (s.type === 'ftp' || s.type === 'ftps') {
    put('passive', s.passive, true);
    put('showHidden', s.showHidden, true);
    put('keepAliveSecs', s.keepAliveSecs);
  }
  if (s.type === 'ftps') {
    put('ftpsExplicit', s.ftpsExplicit, true);
    put('ftpsProtection', s.ftpsProtection, 'default');
    put('disableTls13', s.disableTls13, false);
  }
  if (s.type === 'webdav') {
    put('ssl', s.ssl, true);
  }
  if (s.type === 'sftp') {
    put('rsync', s.rsync, false);
    put('sudo', s.sudo, false);
  }
  put('timeoutSecs', s.timeoutSecs, 30);
  out.mappings = s.mappings;
  if (s.excludedPaths.length) {
    out.excludedPaths = s.excludedPaths;
  }
  return out;
}

export function serializeOptions(o: Options): Partial<Options> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== '' && v !== (DEFAULT_OPTIONS as unknown as Record<string, unknown>)[k]) {
      out[k] = v;
    }
  }
  return out as Partial<Options>;
}

export function serverByName(config: Config, name: string | undefined): Server | undefined {
  return name === undefined ? undefined : config.servers.find((s) => s.name === name);
}

/** A server name or a group name, expanded to the servers it stands for. */
export function resolveTarget(config: Config, name: string | undefined): Server[] {
  if (!name) {
    return [];
  }
  const server = serverByName(config, name);
  if (server) {
    return [server];
  }
  const group = config.groups.find((g) => g.name === name);
  return group ? group.servers.map((n) => serverByName(config, n)).filter((s): s is Server => !!s) : [];
}

export function supportsSsh(server: Server): boolean {
  return server.type === 'sftp';
}

export function supportsChmod(server: Server): boolean {
  return server.type === 'sftp' || server.type === 'ftp' || server.type === 'ftps' || (server.type === 'local' && process.platform !== 'win32');
}

export function describeServer(s: Server): string {
  if (s.type === 'local') {
    return s.rootPath || '(no folder)';
  }
  const user = s.user ? `${s.user}@` : '';
  return `${s.type}://${user}${s.host}:${portOf(s)}${s.rootPath && s.rootPath !== '/' ? s.rootPath : ''}`;
}
