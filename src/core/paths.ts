import * as path from 'node:path';
import type { Mapping, Options, Server } from './config';

const posix = path.posix;

export function normalizeRemote(p: string): string {
  const n = posix.normalize(('/' + p).replace(/\\/g, '/').replace(/\/+/g, '/'));
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

export function joinRemote(...parts: string[]): string {
  return normalizeRemote(posix.join('/', ...parts.filter((p) => p !== '')));
}

/** `child` equals `parent` or lies below it (posix, already normalized). */
export function isRemoteUnder(child: string, parent: string): boolean {
  return child === parent || parent === '/' || child.startsWith(parent + '/');
}

export function isLocalUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function localMappingRoot(projectRoot: string, m: Mapping): string {
  return path.resolve(projectRoot, m.local || '.');
}

export function remoteMappingRoot(server: Server, m: Mapping): string {
  return joinRemote(server.rootPath || '/', m.deploy || '/');
}

function toSlash(p: string): string {
  return p.split(path.sep).join('/');
}

/** The deepest mapping that contains the local path. */
export function mappingForLocal(projectRoot: string, server: Server, localPath: string): Mapping | undefined {
  let best: Mapping | undefined;
  let bestLen = -1;
  for (const m of server.mappings) {
    const root = localMappingRoot(projectRoot, m);
    if (isLocalUnder(localPath, root) && root.length > bestLen) {
      best = m;
      bestLen = root.length;
    }
  }
  return best;
}

export function remoteForLocal(projectRoot: string, server: Server, localPath: string): string | undefined {
  const m = mappingForLocal(projectRoot, server, localPath);
  if (!m) {
    return undefined;
  }
  const rel = toSlash(path.relative(localMappingRoot(projectRoot, m), localPath));
  return joinRemote(remoteMappingRoot(server, m), rel);
}

export function mappingForRemote(server: Server, remotePath: string): Mapping | undefined {
  let best: Mapping | undefined;
  let bestLen = -1;
  for (const m of server.mappings) {
    const root = remoteMappingRoot(server, m);
    if (isRemoteUnder(remotePath, root) && root.length > bestLen) {
      best = m;
      bestLen = root.length;
    }
  }
  return best;
}

export function localForRemote(projectRoot: string, server: Server, remotePath: string): string | undefined {
  const m = mappingForRemote(server, remotePath);
  if (!m) {
    return undefined;
  }
  const root = remoteMappingRoot(server, m);
  const rel = remotePath === root ? '' : remotePath.slice(root === '/' ? 1 : root.length + 1);
  return path.join(localMappingRoot(projectRoot, m), ...rel.split('/').filter(Boolean));
}

export function webUrlForLocal(projectRoot: string, server: Server, localPath: string): string | undefined {
  const m = mappingForLocal(projectRoot, server, localPath);
  if (!m || !server.webUrl) {
    return undefined;
  }
  const rel = toSlash(path.relative(localMappingRoot(projectRoot, m), localPath));
  const webPath = joinRemote(m.web || '/', rel);
  return server.webUrl.replace(/\/+$/, '') + encodeURI(webPath);
}

export function webUrlForRemote(projectRoot: string, server: Server, remotePath: string): string | undefined {
  const local = localForRemote(projectRoot, server, remotePath);
  return local ? webUrlForLocal(projectRoot, server, local) : undefined;
}

/** `*` and `?` wildcards, whole-name match. */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '');
}

export class Excluder {
  private readonly names: RegExp[];
  private readonly localPaths: string[];
  private readonly remotePaths: string[];

  constructor(projectRoot: string, private readonly server: Server, options: Options) {
    this.names = options.excludeByName
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(wildcardToRegExp);
    this.localPaths = server.excludedPaths.filter((e) => e.local).map((e) => path.resolve(projectRoot, e.path));
    this.remotePaths = server.excludedPaths.filter((e) => !e.local).map((e) => joinRemote(server.rootPath || '/', e.path));
  }

  isNameExcluded(name: string): boolean {
    return this.names.some((r) => r.test(name));
  }

  /** Name masks apply to every segment below the mapping root. */
  private segmentsExcluded(rel: string): boolean {
    return rel.split(/[\\/]/).filter(Boolean).some((seg) => this.isNameExcluded(seg));
  }

  isLocalExcluded(projectRoot: string, localPath: string): boolean {
    if (this.localPaths.some((p) => isLocalUnder(localPath, p))) {
      return true;
    }
    const m = mappingForLocal(projectRoot, this.server, localPath);
    const base = m ? localMappingRoot(projectRoot, m) : projectRoot;
    if (this.segmentsExcluded(path.relative(base, localPath))) {
      return true;
    }
    const remote = remoteForLocal(projectRoot, this.server, localPath);
    return remote !== undefined && this.remotePaths.some((p) => isRemoteUnder(remote, p));
  }

  isRemoteExcluded(projectRoot: string, remotePath: string): boolean {
    if (this.remotePaths.some((p) => isRemoteUnder(remotePath, p))) {
      return true;
    }
    const m = mappingForRemote(this.server, remotePath);
    const base = m ? remoteMappingRoot(this.server, m) : normalizeRemote(this.server.rootPath || '/');
    if (isRemoteUnder(remotePath, base) && this.segmentsExcluded(remotePath.slice(base.length))) {
      return true;
    }
    const local = localForRemote(projectRoot, this.server, remotePath);
    return local !== undefined && this.localPaths.some((p) => isLocalUnder(local, p));
  }

  isRemotePathListed(remotePath: string): boolean {
    return this.remotePaths.includes(remotePath);
  }
}

/** Path relative to the project for storing in the config, or absolute when outside it. */
export function projectRelative(projectRoot: string, p: string): string {
  const rel = path.relative(projectRoot, p);
  if (rel === '') {
    return '.';
  }
  return rel.startsWith('..') || path.isAbsolute(rel) ? p : toSlash(rel);
}

export function deployRelative(server: Server, remotePath: string): string {
  const root = normalizeRemote(server.rootPath || '/');
  if (root === '/') {
    return remotePath;
  }
  return isRemoteUnder(remotePath, root) ? normalizeRemote(remotePath.slice(root.length)) : remotePath;
}

export function parseOctal(v: string | undefined): number | undefined {
  if (!v || !/^[0-7]{3,4}$/.test(v.trim())) {
    return undefined;
  }
  return parseInt(v.trim(), 8);
}

export function formatMode(mode: number): string {
  const bits = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) {
    s += mode & (1 << (8 - i)) ? bits[i] : '-';
  }
  return s;
}

export function formatSize(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} kB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
