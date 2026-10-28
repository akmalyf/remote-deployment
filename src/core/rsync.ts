import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { portOf, Server } from './config';
import { parseOctal } from './paths';
import { expandHome } from './ssh';
import type { Ctx, Deployer } from './transfer';
import { CancelledError } from './transfer';

let rsyncAvailable: boolean | undefined;
let isOpenRsync = false;

function detect(): boolean {
  if (rsyncAvailable === undefined) {
    const r = spawnSync('rsync', ['--version'], { encoding: 'utf8' });
    rsyncAvailable = r.status === 0;
    isOpenRsync = /openrsync/i.test(`${r.stdout}${r.stderr}`);
  }
  return rsyncAvailable;
}

/**
 * rsync runs the system ssh, which cannot receive a password from us: it is used only for
 * agent, key-without-prompt and OpenSSH-config authentication, otherwise transfers fall back to SFTP.
 */
export function canUseRsync(server: Server): boolean {
  return server.type === 'sftp' && server.rsync && server.auth !== 'password' && process.platform !== 'win32' && detect();
}

function sshCommand(server: Server): string {
  const args = ['ssh', '-o', 'BatchMode=yes', '-p', String(portOf(server))];
  if (server.auth === 'key' && server.keyPath) {
    args.push('-i', expandHome(server.keyPath));
  }
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

function filters(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const name of ctx.options.excludeByName.split(';').map((s) => s.trim()).filter(Boolean)) {
    out.push(`--exclude=${name}`);
  }
  return out;
}

/** Transfer a folder with rsync. Returns false when rsync could not be used (caller falls back). */
export async function rsyncTransfer(
  deployer: Deployer,
  ctx: Ctx,
  direction: 'upload' | 'download',
  localDir: string,
  remoteDir: string,
  deleteMissing: boolean,
): Promise<boolean> {
  const s = ctx.server;
  // With OpenSSH auth the host is an alias that the system ssh resolves itself.
  const host = s.user ? `${s.user}@${s.host}` : s.host;
  const remoteSpec = `${host}:${remoteDir.replace(/ /g, '\\ ')}/`;
  const localSpec = localDir.endsWith(path.sep) ? localDir : localDir + path.sep;
  const args = ['-rlz', '--itemize-changes', '-e', sshCommand(s)];
  if (ctx.options.preserveTimestamps) {
    args.push('-t');
  }
  if (!ctx.options.overwriteUpToDate) {
    args.push('--update');
  }
  if (deleteMissing) {
    args.push('--delete');
  }
  if (s.sudo) {
    args.push('--rsync-path=sudo -n rsync');
  }
  const fileMode = parseOctal(ctx.options.filePermissions);
  const dirMode = parseOctal(ctx.options.folderPermissions);
  if (!isOpenRsync && (fileMode !== undefined || dirMode !== undefined)) {
    const parts = [];
    if (fileMode !== undefined) {
      parts.push(`F${fileMode.toString(8)}`);
    }
    if (dirMode !== undefined) {
      parts.push(`D${dirMode.toString(8)}`);
    }
    args.push(`--chmod=${parts.join(',')}`);
  }
  // Local excluded paths below this folder.
  for (const e of s.excludedPaths) {
    const abs = e.local ? path.resolve(ctx.project.root, e.path) : undefined;
    if (abs && abs.startsWith(localSpec)) {
      args.push(`--exclude=/${path.relative(localDir, abs).split(path.sep).join('/')}`);
    }
  }
  args.push(...filters(ctx));
  args.push(...(direction === 'upload' ? [localSpec, remoteSpec] : [remoteSpec, localSpec]));

  await deployer.ensureRemoteDir(ctx, remoteDir).catch(() => undefined);
  deployer.log.detail(ctx.op, `rsync ${args.join(' ')}`);
  ctx.progress.report({ message: `${direction === 'upload' ? 'Uploading' : 'Downloading'} ${path.basename(localDir)} using rsync…` });

  const code = await new Promise<number>((resolve) => {
    const child = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const cancel = ctx.token.onCancellationRequested(() => child.kill());
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^([<>ch.*][fdLDS][^\s]*)\s+(.*)$/.exec(line);
        if (!m) {
          continue;
        }
        if (m[1].startsWith('*deleting')) {
          deployer.log.count(ctx.op, 'deleted');
        } else if (m[1][1] === 'f') {
          deployer.log.count(ctx.op, 'transferred');
          deployer.log.detail(ctx.op, `${direction === 'upload' ? 'Uploaded' : 'Downloaded'} ${m[2]}`);
          ctx.progress.report({ message: m[2] });
        } else if (m[1][0] === 'c' && m[1][1] === 'd') {
          deployer.log.count(ctx.op, 'foldersCreated');
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      stderr += e.message;
      resolve(-1);
    });
    child.on('close', (c) => {
      cancel.dispose();
      if (stderr.trim()) {
        deployer.log.warn(ctx.op, `rsync: ${stderr.trim()}`);
      }
      resolve(c ?? -1);
    });
  });
  if (ctx.token.isCancellationRequested) {
    throw new CancelledError();
  }
  if (code === -1 || code === 127) {
    deployer.log.warn(ctx.op, 'rsync could not be started, falling back to SFTP');
    return false;
  }
  if (code === 255) {
    deployer.log.warn(ctx.op, 'rsync could not authenticate over ssh (BatchMode), falling back to SFTP');
    return false;
  }
  if (code !== 0) {
    throw new Error(`Rsync failed with exit code: ${code}`);
  }
  if (isOpenRsync && direction === 'upload' && (fileMode !== undefined || dirMode !== undefined)) {
    // macOS openrsync ignores --chmod: apply the permissions ourselves.
    await deployer.pool.run(s, async (t) => {
      if (!t.exec) {
        return;
      }
      const q = (x: string): string => `'${x.replace(/'/g, `'\\''`)}'`;
      const sudo = s.sudo ? 'sudo -n ' : '';
      if (fileMode !== undefined) {
        await t.exec(`${sudo}find ${q(remoteDir)} -type f -exec chmod ${fileMode.toString(8)} {} +`);
      }
      if (dirMode !== undefined) {
        await t.exec(`${sudo}find ${q(remoteDir)} -type d -exec chmod ${dirMode.toString(8)} {} +`);
      }
    });
  }
  return true;
}
