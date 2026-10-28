// Import an `.idea` deployment configuration: `.idea/deployment.xml` (PublishConfigData),
// `.idea/webServers.xml` (WebServers) and `sshConfigs.xml` (project + IDE options dir).
// Attribute names follow that format's serialization of the deployment settings.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuthType,
  AutoUpload,
  Config,
  DEFAULT_OPTIONS,
  ExcludedPath,
  LogLevel,
  Mapping,
  normalizeServer,
  Protocol,
  RemoteOverwriteCheck,
  Server,
} from './config';
import { projectRelative } from './paths';

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Enough XML for IDE option files: elements and attributes, text is ignored. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (!m[2]) {
      continue;
    }
    const [, closing, tag, attrText, selfClosing] = m;
    if (closing) {
      while (stack.length > 1 && stack.pop()!.tag !== tag) {
        // unwind mismatched tags
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
    }
    const node: XmlNode = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }
  return root;
}

function* descendants(n: XmlNode): Generator<XmlNode> {
  for (const c of n.children) {
    yield c;
    yield* descendants(c);
  }
}

function find(n: XmlNode, pred: (x: XmlNode) => boolean): XmlNode | undefined {
  for (const d of descendants(n)) {
    if (pred(d)) {
      return d;
    }
  }
  return undefined;
}

/** `myFooBar` -> `fooBar` */
function normKey(k: string): string {
  const s = /^my[A-Z]/.test(k) ? k.slice(2) : k;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Attributes + nested `<option name value/>` + nested advancedOptions attributes. */
function props(n: XmlNode): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(n.attrs)) {
    m.set(normKey(k), v);
  }
  for (const d of descendants(n)) {
    if (d.tag === 'option' && d.attrs.name !== undefined && d.attrs.value !== undefined) {
      const k = normKey(d.attrs.name);
      if (!m.has(k)) {
        m.set(k, d.attrs.value);
      }
    } else if (d.tag === 'advancedOptions') {
      for (const [k, v] of Object.entries(d.attrs)) {
        if (!m.has(normKey(k))) {
          m.set(normKey(k), v);
        }
      }
    }
  }
  return m;
}

function truthy(v: string | undefined): boolean | undefined {
  return v === undefined ? undefined : v.toLowerCase() === 'true';
}

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** IDE option dirs that may hold shared sshConfigs.xml / webServers.xml, newest first. */
function ideOptionDirs(): string[] {
  const bases = [
    path.join(os.homedir(), 'Library', 'Application Support', 'JetBrains'),
    path.join(os.homedir(), '.config', 'JetBrains'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'JetBrains') : '',
  ].filter(Boolean);
  const out: string[] = [];
  for (const base of bases) {
    let entries: string[];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    entries
      .filter((n) => ['phpstorm', 'intellijidea', 'webstorm', 'pycharm', 'goland', 'rubymine'].some((k) => n.toLowerCase().startsWith(k)))
      .map((n) => path.join(base, n, 'options'))
      .filter((p) => fs.existsSync(p))
      .sort()
      .reverse()
      .forEach((p) => out.includes(p) || out.push(p));
  }
  return out;
}

function expandMacros(s: string, root: string): string {
  return s.replace(/\$PROJECT_DIR\$/g, root).replace(/\$USER_HOME\$/g, os.homedir());
}

interface SshCfg {
  host: string;
  port?: number;
  user: string;
  auth?: AuthType;
  keyPath?: string;
}

function authFrom(v: string | undefined): AuthType | undefined {
  switch (v?.toUpperCase()) {
    case 'PASSWORD':
      return 'password';
    case 'KEY_PAIR':
    case 'KEY':
      return 'key';
    case 'OPEN_SSH':
    case 'OPENSSH':
    case 'AGENT':
      return 'openSsh';
    default:
      return undefined;
  }
}

function sshConfigs(root: string): Map<string, SshCfg> {
  const out = new Map<string, SshCfg>();
  const files = [path.join(root, '.idea', 'sshConfigs.xml'), ...ideOptionDirs().map((d) => path.join(d, 'sshConfigs.xml'))];
  for (const f of files) {
    const src = read(f);
    if (!src) {
      continue;
    }
    for (const n of descendants(parseXml(src))) {
      if (n.tag !== 'sshConfig' || !n.attrs.id) {
        continue;
      }
      const a = n.attrs;
      const cfg: SshCfg = {
        host: a.host ?? '',
        port: a.port ? Number(a.port) : undefined,
        user: a.username ?? a.user ?? '',
        auth: authFrom(a.authType) ?? (truthy(a.useOpenSSHConfig) ? 'openSsh' : undefined),
        keyPath: (a.keyPath ?? a.privateKey) ? expandMacros(a.keyPath ?? a.privateKey, root) : undefined,
      };
      if (!out.has(a.id)) {
        out.set(a.id, cfg);
      }
      if (a.customName && !out.has(a.customName)) {
        out.set(a.customName, cfg);
      }
    }
  }
  return out;
}

/** Legacy `sshConfig="user@host:22 password"` attribute. */
function parseLegacySsh(s: string): SshCfg {
  const [addr = '', auth] = s.trim().split(/\s+/);
  const at = addr.indexOf('@');
  const user = at >= 0 ? addr.slice(0, at) : '';
  const hostPort = at >= 0 ? addr.slice(at + 1) : addr;
  const colon = hostPort.lastIndexOf(':');
  return {
    user,
    host: colon >= 0 ? hostPort.slice(0, colon) : hostPort,
    port: colon >= 0 ? Number(hostPort.slice(colon + 1)) || undefined : undefined,
    auth: authFrom(auth === 'key_pair' ? 'KEY' : auth),
  };
}

interface WebServer {
  id: string;
  server: Server;
}

function webServers(root: string, ssh: Map<string, SshCfg>): WebServer[] {
  const out: WebServer[] = [];
  const files = [path.join(root, '.idea', 'webServers.xml'), ...ideOptionDirs().map((d) => path.join(d, 'webServers.xml'))];
  for (const f of files) {
    const src = read(f);
    if (!src) {
      continue;
    }
    for (const ws of descendants(parseXml(src))) {
      if (ws.tag !== 'webServer') {
        continue;
      }
      const name = ws.attrs.name ?? 'server';
      if (out.some((w) => w.server.name === name)) {
        continue; // project level wins over IDE level
      }
      let webUrl = (ws.attrs.url ?? '').replace(/\/+$/, '');
      if (webUrl === 'http:' || webUrl === 'https:') {
        webUrl = '';
      }
      const s = normalizeServer({ name, webUrl, mappings: [] });
      s.mappings = [];
      const ft = ws.children.find((c) => c.tag === 'fileTransfer');
      if (ft) {
        const p = props(ft);
        const access = (p.get('accessType') ?? 'SFTP').toUpperCase();
        const typeMap: Record<string, Protocol> = { FTP: 'ftp', FTPS: 'ftps', LOCAL: 'local', MOUNT: 'local', WEBDAV: 'webdav', DAV: 'webdav' };
        s.type = typeMap[access] ?? 'sftp';
        s.host = p.get('host') ?? '';
        s.port = p.get('port') ? Number(p.get('port')) : undefined;
        s.user = p.get('username') ?? p.get('user') ?? p.get('login') ?? '';
        s.passive = truthy(p.get('passiveMode')) ?? s.passive;
        s.ftpsExplicit = truthy(p.get('explicitFtps') ?? p.get('ftpsExplicit')) ?? s.ftpsExplicit;
        s.rsync = truthy(p.get('useRsync') ?? p.get('isUseRsync') ?? p.get('rsync')) ?? s.rsync;
        s.sudo = truthy(p.get('useSudo') ?? p.get('isUseSudo') ?? p.get('sudo')) ?? s.sudo;
        s.showHidden = truthy(p.get('showHiddenFiles') ?? p.get('hiddenFiles')) ?? s.showHidden;
        if (s.type === 'webdav') {
          s.ssl = !webUrl.startsWith('http://') || p.get('port') === '443';
        }
        s.rootPath =
          s.type === 'local'
            ? expandMacros(p.get('mountedRoot') ?? p.get('mountedFolder') ?? p.get('rootFolder') ?? '', root)
            : (p.get('rootFolder') ?? '/');
        if (s.type === 'sftp') {
          const id = p.get('sshConfigId');
          const cname = p.get('sshConfigName');
          const legacy = p.get('sshConfig');
          const sc: SshCfg = (id && ssh.get(id)) || (cname && ssh.get(cname)) || (legacy ? parseLegacySsh(legacy) : { host: '', user: '' });
          s.host = sc.host || s.host;
          s.port = sc.port ?? s.port;
          s.user = sc.user || s.user;
          const pk = p.get('privateKey');
          s.keyPath = sc.keyPath ?? (pk ? expandMacros(pk, root) : undefined);
          s.auth = truthy(p.get('authAgent'))
            ? 'agent'
            : truthy(p.get('keyPair')) || truthy(p.get('useKeyPair'))
              ? 'key'
              : (sc.auth ?? (s.keyPath ? 'key' : 'password'));
        }
        if (truthy(p.get('anonymous'))) {
          s.user = 'anonymous';
        }
      }
      out.push({ id: ws.attrs.id ?? '', server: s });
    }
  }
  return out;
}

function permFromDecimal(v: string | undefined): string | undefined {
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 ? n.toString(8) : undefined;
}

export function hasIdeaConfig(root: string): boolean {
  return fs.existsSync(path.join(root, '.idea', 'deployment.xml')) || fs.existsSync(path.join(root, '.idea', 'webServers.xml'));
}

export function importIdea(root: string): Config {
  const servers = webServers(root, sshConfigs(root));
  const config: Config = { servers: [], groups: [], options: { ...DEFAULT_OPTIONS } };
  const src = read(path.join(root, '.idea', 'deployment.xml'));
  if (src) {
    const pc = find(parseXml(src), (n) => n.tag === 'component' && n.attrs.name === 'PublishConfigData');
    if (pc) {
      // Only the component's own attributes/options; per-server data is handled below.
      const p = new Map<string, string>();
      for (const [k, v] of Object.entries(pc.attrs)) {
        p.set(normKey(k), v);
      }
      for (const o of pc.children) {
        if (o.tag === 'option' && o.attrs.name !== undefined && o.attrs.value !== undefined) {
          p.set(normKey(o.attrs.name), o.attrs.value);
        }
      }
      const o = config.options;
      const auto = p.get('autoUpload')?.toLowerCase();
      if (auto) {
        o.autoUpload = (auto.includes('always') ? 'always' : auto.includes('explicit') ? 'onExplicitSave' : 'never') as AutoUpload;
        // "Always" also uploads external changes unless "Skip external changes" is set.
        o.uploadExternalChanges = o.autoUpload === 'always';
      }
      const bool = (k: string, set: (v: boolean) => void): void => {
        const v = truthy(p.get(k));
        if (v !== undefined) {
          set(v);
        }
      };
      bool('autoUploadExternalChanges', (v) => (o.uploadExternalChanges = v));
      bool('preserveTimestamps', (v) => (o.preserveTimestamps = v));
      bool('deleteMissingItems', (v) => (o.deleteMissingItems = v));
      bool('createEmptyFolders', (v) => (o.createEmptyFolders = v));
      bool('createEmptyDirectories', (v) => (o.createEmptyFolders = v));
      bool('overwriteAll', (v) => (o.overwriteUpToDate = v));
      bool('promptOnLocalOverwrite', (v) => (o.promptOnLocalOverwrite = v));
      bool('notifyRemoteChanges', (v) => (o.notifyRemoteChanges = v));
      bool('confirmBeforeUploading', (v) => (o.confirmBeforeUploading = v));
      bool('confirmBeforeDeletion', (v) => (o.confirmBeforeDeletion = v));
      bool('useTempFile', (v) => (o.useTempFile = v));
      // A missing attribute keeps the safe default: deleting remote files must be opted into.
      bool('remoteFilesAllowedToDisappearOnAutoupload', (v) => (o.deleteRemoteOnLocalDelete = v));
      const pro = p.get('promptOnRemoteOverwrite')?.toUpperCase();
      if (pro) {
        o.promptOnRemoteOverwrite = (pro === 'CHECK_TIMESTAMP' ? 'timestamp' : pro === 'CHECK_CONTENT' ? 'content' : 'none') as RemoteOverwriteCheck;
      }
      const exclude = p.get('exclude') ?? p.get('excludeMask');
      if (exclude !== undefined) {
        o.excludeByName = exclude;
      }
      o.filePermissions = permFromDecimal(p.get('filePermissions'));
      o.folderPermissions = permFromDecimal(p.get('folderPermissions'));
      const trace = p.get('traceLevel')?.toUpperCase();
      if (trace) {
        o.logLevel = (trace === 'ERRORS' ? 'errors' : trace === 'DETAILS' ? 'details' : 'brief') as LogLevel;
      }
      const byIdOrName = (key: string): string | undefined => {
        const v = p.get(key);
        return v === undefined ? undefined : servers.find((w) => w.id === v || w.server.name === v)?.server.name;
      };
      config.defaultServer = byIdOrName('serverName') ?? byIdOrName('serverId');
      o.uploadOnCommit = byIdOrName('uploadOnCheckinName') ?? byIdOrName('uploadOnCheckin');

      // <serverData><paths name="..."><serverdata><mappings>/<excludedPaths>
      for (const paths of descendants(pc)) {
        if (paths.tag !== 'paths' || !paths.attrs.name) {
          continue;
        }
        const ws = servers.find((w) => w.server.name === paths.attrs.name || w.id === paths.attrs.name);
        if (!ws) {
          continue;
        }
        for (const m of descendants(paths)) {
          if (m.tag === 'mapping') {
            const local = path.normalize(expandMacros(m.attrs.local ?? root, root));
            const mapping: Mapping = { local: projectRelative(root, local), deploy: m.attrs.deploy ?? '/', web: m.attrs.web ?? '/' };
            ws.server.mappings.push(mapping);
          } else if (m.tag === 'excludedPath') {
            const local = m.attrs.local === 'true';
            const raw = m.attrs.path ?? '';
            const e: ExcludedPath = { local, path: local ? projectRelative(root, path.normalize(expandMacros(raw, root))) : raw };
            ws.server.excludedPaths.push(e);
          }
        }
      }
    }
  }
  // Keep only servers used by this project when the IDE-level list is large.
  const projectXml = read(path.join(root, '.idea', 'webServers.xml')) ?? '';
  const used = servers.map(
    (w) =>
      w.server.mappings.length > 0 ||
      config.defaultServer === w.server.name ||
      (w.id !== '' && projectXml.includes(w.id)) ||
      projectXml.includes(`name="${w.server.name}"`),
  );
  const anyUsed = used.some(Boolean);
  config.servers = servers
    .filter((_, i) => used[i] || !anyUsed)
    .map((w) => {
      if (!w.server.mappings.length) {
        w.server.mappings = [{ local: '.', deploy: '/', web: '/' }];
      }
      return w.server;
    });
  return config;
}
