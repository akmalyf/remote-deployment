import { createHash, createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export interface OpenSshHost {
  hostName?: string;
  port?: number;
  user?: string;
  identityFiles: string[];
  identityAgent?: string;
}

/** Minimal `~/.ssh/config` reader: the first value of each keyword wins, like OpenSSH. */
export function resolveOpenSshHost(alias: string, file = path.join(os.homedir(), '.ssh', 'config')): OpenSshHost {
  const result: OpenSshHost = { identityFiles: [] };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return result;
  }
  let active = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const m = /^(\S+)\s*=?\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      active = value.split(/\s+/).some((pattern) => {
        const negate = pattern.startsWith('!');
        const re = new RegExp('^' + pattern.replace(/^!/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        return re.test(alias) !== negate;
      });
      continue;
    }
    if (key === 'match') {
      active = false;
      continue;
    }
    if (!active) {
      continue;
    }
    switch (key) {
      case 'hostname':
        result.hostName ??= value.replace(/%h/g, alias);
        break;
      case 'port':
        result.port ??= Number(value);
        break;
      case 'user':
        result.user ??= value;
        break;
      case 'identityfile':
        result.identityFiles.push(expandHome(value));
        break;
      case 'identityagent':
        result.identityAgent ??= expandHome(value);
        break;
    }
  }
  if (!result.identityFiles.length) {
    for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      const p = path.join(os.homedir(), '.ssh', name);
      if (fs.existsSync(p)) {
        result.identityFiles.push(p);
      }
    }
  }
  return result;
}

export function agentSocket(): string | undefined {
  if (process.platform === 'win32') {
    return 'pageant';
  }
  return process.env.SSH_AUTH_SOCK;
}

const KNOWN_HOSTS = path.join(os.homedir(), '.ssh', 'known_hosts');

function hostPatterns(host: string, port: number): string[] {
  return port === 22 ? [host] : [`[${host}]:${port}`];
}

function matchesHost(entry: string, candidates: string[]): boolean {
  return entry.split(',').some((h) => {
    if (h.startsWith('|1|')) {
      const [, , salt, hash] = h.split('|');
      return candidates.some((c) => createHmac('sha1', Buffer.from(salt, 'base64')).update(c).digest('base64') === hash);
    }
    return candidates.includes(h);
  });
}

export function fingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** The key type name embedded in an SSH public key blob. */
function keyType(key: Buffer): string {
  const len = key.readUInt32BE(0);
  return key.subarray(4, 4 + len).toString();
}

/**
 * Check a host key against ~/.ssh/known_hosts. Unknown hosts are trusted on first use after
 * confirmation and appended; a changed key for a known host is refused.
 */
export async function verifyHostKey(host: string, port: number, key: Buffer): Promise<boolean> {
  const candidates = hostPatterns(host, port);
  const type = keyType(key);
  const b64 = key.toString('base64');
  let text = '';
  try {
    text = fs.readFileSync(KNOWN_HOSTS, 'utf8');
  } catch {
    // no known_hosts yet
  }
  let mismatch = false;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || parts[0].startsWith('#')) {
      continue;
    }
    const [hosts, ktype, kdata] = parts[0].startsWith('@') ? parts.slice(1) : parts;
    if (parts[0] === '@revoked' || !matchesHost(hosts, candidates)) {
      continue;
    }
    if (kdata === b64) {
      return true;
    }
    if (ktype === type) {
      mismatch = true;
    }
  }
  if (mismatch) {
    void vscode.window.showErrorMessage(
      `HOST KEY MISMATCH for ${candidates[0]}: the server presented ${type} ${fingerprint(key)}, which differs from ~/.ssh/known_hosts. Connection refused.`,
      { modal: true },
    );
    return false;
  }
  const answer = await vscode.window.showWarningMessage(
    `The authenticity of host '${candidates[0]}' can't be established.\n${type} key fingerprint is ${fingerprint(key)}.\nTrust it and add it to ~/.ssh/known_hosts?`,
    { modal: true },
    'Trust',
  );
  if (answer !== 'Trust') {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(KNOWN_HOSTS), { recursive: true, mode: 0o700 });
    const prefix = text && !text.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(KNOWN_HOSTS, `${prefix}${candidates[0]} ${type} ${b64}\n`, { mode: 0o600 });
  } catch {
    // trusted for this session only
  }
  return true;
}
