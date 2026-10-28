import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { answers, messages, Uri } from 'vscode';
import { normalizeServer, Server } from '../src/core/config';
import { Credentials } from '../src/core/credentials';
import { importIdea } from '../src/core/ideaImport';
import { TransferLog } from '../src/core/log';
import { Excluder, localForRemote, remoteForLocal, webUrlForLocal } from '../src/core/paths';
import { Project } from '../src/core/project';
import { RevisionTracker } from '../src/core/revisions';
import { Deployer } from '../src/core/transfer';
import { parseFtpTime } from '../src/transport/ftp';
import { ConnectionPool } from '../src/transport/pool';

// Usage: node dist-test/smoke.js [servers-dir] [protocol]
// Without a servers dir only the pure tests and the local-folder transport run. With one, SFTP
// (127.0.0.1:3373), FTP (2121), FTPS (2122) and WebDAV (8089) test servers are expected, user
// "test" / password "secret", serving folders below that dir.
const TMP = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'remote-deployment-test-'));
const SRV = process.argv[2] ?? path.join(TMP, 'srv');
fs.mkdirSync(path.join(SRV, 'local'), { recursive: true });
const WITH_SERVERS = process.argv[2] !== undefined;
const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d?: unknown) => m.get(k) ?? d, update: async (k: string, v: unknown) => void m.set(k, v), keys: () => [...m.keys()] }; };
const secrets = { get: async (k: string) => (k.startsWith('password:') ? 'secret' : undefined), store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose() {} }) };

let failures = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log('PASS', name); } catch (e) { failures++; console.log('FAIL', name, '\n   ', (e as Error).stack?.split('\n').slice(0, 4).join('\n    ')); }
}

function write(p: string, content: string, mtime?: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
}

async function main() {
  // ------------------------------------------------------------ pure logic
  await test('paths: mapping both ways + web url', () => {
    const s = normalizeServer({ name: 'p', rootPath: '/var/www', webUrl: 'https://ex.com', mappings: [{ local: '.', deploy: '/app', web: '/' }, { local: 'public', deploy: '/pub', web: '/static' }] });
    assert.equal(remoteForLocal('/proj', s, '/proj/src/a.php'), '/var/www/app/src/a.php');
    assert.equal(remoteForLocal('/proj', s, '/proj/public/x.css'), '/var/www/pub/x.css');
    assert.equal(localForRemote('/proj', s, '/var/www/pub/x.css'), '/proj/public/x.css');
    assert.equal(localForRemote('/proj', s, '/var/www/app'), '/proj');
    assert.equal(localForRemote('/proj', s, '/etc/passwd'), undefined);
    assert.equal(remoteForLocal('/proj', s, '/other/a'), undefined);
    assert.equal(webUrlForLocal('/proj', s, '/proj/public/a b.css'), 'https://ex.com/static/a%20b.css');
  });
  await test('paths: excluder', () => {
    const s = normalizeServer({ name: 'p', rootPath: '/var/www', mappings: [{ local: '.', deploy: '/', web: '/' }], excludedPaths: [{ path: 'vendor', local: true }, { path: '/storage', local: false }] });
    const ex = new Excluder('/proj', s, { excludeByName: '.git;*.log', } as never);
    assert.ok(ex.isLocalExcluded('/proj', '/proj/vendor/x.php'));
    assert.ok(ex.isLocalExcluded('/proj', '/proj/.git/HEAD'));
    assert.ok(ex.isLocalExcluded('/proj', '/proj/a/debug.log'));
    assert.ok(ex.isLocalExcluded('/proj', '/proj/storage/x'));
    assert.ok(!ex.isLocalExcluded('/proj', '/proj/src/x.php'));
    assert.ok(ex.isRemoteExcluded('/proj', '/var/www/storage/logs'));
    assert.ok(ex.isRemoteExcluded('/proj', '/var/www/vendor'));
    assert.ok(!ex.isRemoteExcluded('/proj', '/var/www/src'));
  });
  await test('ftp time parsing', () => {
    assert.equal(parseFtpTime('20260102030405'), Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.equal(parseFtpTime('20260102030405.123'), Date.UTC(2026, 0, 2, 3, 4, 5, 123));
  });
  await test('idea import', () => {
    const dir = path.join(TMP, 'idea'); fs.mkdirSync(path.join(dir, '.idea'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.idea/webServers.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<project version="4"><component name="WebServers"><option name="servers">
  <webServer id="a1" name="prod" url="https://example.com">
    <fileTransfer accessType="SFTP" host="example.com" port="2222" rootFolder="/var/www" sshConfig="deploy@example.com:2222 key" />
  </webServer>
  <webServer id="b2" name="ftp" url="http://">
    <fileTransfer accessType="FTP" host="ftp.example.com" port="21" rootFolder="/htdocs"><advancedOptions><advancedOptions passiveMode="false" /></advancedOptions></fileTransfer>
  </webServer>
</option></component></project>`);
    fs.writeFileSync(path.join(dir, '.idea/deployment.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<project version="4"><component name="PublishConfigData" autoUpload="Always" serverName="prod" preserveTimestamps="false" filePermissions="420" folderPermissions="493" promptOnRemoteOverwrite="CHECK_TIMESTAMP">
<serverData>
  <paths name="prod"><serverdata>
    <mappings><mapping deploy="/app" local="$PROJECT_DIR$" web="/" /></mappings>
    <excludedPaths><excludedPath local="true" path="$PROJECT_DIR$/vendor" /><excludedPath path="/app/storage" /></excludedPaths>
  </serverdata></paths>
  <paths name="ftp"><serverdata><mappings><mapping local="$PROJECT_DIR$/public" deploy="/" /></mappings></serverdata></paths>
</serverData></component></project>`);
    const c = importIdea(dir);
    assert.equal(c.defaultServer, 'prod');
    assert.equal(c.options.autoUpload, 'always');
    assert.equal(c.options.preserveTimestamps, false);
    assert.equal(c.options.filePermissions, '644');
    assert.equal(c.options.folderPermissions, '755');
    assert.equal(c.options.promptOnRemoteOverwrite, 'timestamp');
    const prod = c.servers.find((s) => s.name === 'prod')!;
    assert.equal(prod.user, 'deploy'); assert.equal(prod.port, 2222); assert.equal(prod.auth, 'key');
    assert.equal(prod.mappings[0].local, '.');
    assert.deepEqual(prod.excludedPaths[0], { path: 'vendor', local: true });
    const ftp = c.servers.find((s) => s.name === 'ftp')!;
    assert.equal(ftp.type, 'ftp'); assert.equal(ftp.passive, false); assert.equal(ftp.webUrl, ''); assert.equal(ftp.mappings[0].local, 'public');
    assert.equal(c.options.deleteRemoteOnLocalDelete, false);
  });

  // ------------------------------------------------------------ transports + deployer
  const servers: Record<string, Partial<Server>> = {
    local: { type: 'local', rootPath: path.join(SRV, 'local') },
    sftp: { type: 'sftp', host: '127.0.0.1', port: 3373, user: 'test', auth: 'password', rootPath: path.join(SRV, 'sftp') },
    ftp: { type: 'ftp', host: '127.0.0.1', port: 2121, user: 'test', rootPath: '/' },
    ftps: { type: 'ftps', host: '127.0.0.1', port: 2122, user: 'test', ftpsExplicit: true, rootPath: '/' },
    webdav: { type: 'webdav', host: 'http://127.0.0.1:8089', user: 'test', ssl: false, rootPath: '/' },
  };
  const only = process.argv[3];
  for (const [kind, partial] of Object.entries(servers)) {
    if ((only && only !== kind) || (!WITH_SERVERS && kind !== 'local')) continue;
    const root = path.join(TMP, 'proj-' + kind);
    fs.rmSync(root, { recursive: true, force: true });
    const old = Date.now() - 3600_000;
    write(path.join(root, 'index.php'), '<?php echo 1;', old);
    write(path.join(root, 'src/a.txt'), 'hello', old);
    write(path.join(root, 'src/deep/b.bin'), 'x'.repeat(70000), old);
    write(path.join(root, 'vendor/lib.php'), 'vendor', old);
    write(path.join(root, '.git/HEAD'), 'ref', old);
    write(path.join(root, 'app.log'), 'log', old);
    const server = normalizeServer({ name: kind, ...partial, mappings: [{ local: '.', deploy: '/proj', web: '/' }], excludedPaths: [{ path: 'vendor', local: true }] });
    write(path.join(root, '.vscode/deployment.json'), JSON.stringify({ defaultServer: kind, servers: [server], options: { excludeByName: '.git;.vscode;*.log', promptOnRemoteOverwrite: 'timestamp', filePermissions: kind === 'webdav' ? undefined : '640' } }));
    const project = new Project({ uri: Uri.file(root), name: kind, index: 0 } as never, memento() as never);
    const srv = project.config.servers[0];
    const credentials = new Credentials(secrets as never);
    const pool = new ConnectionPool(credentials);
    const log = new TransferLog();
    const deployer = new Deployer(pool, log, new RevisionTracker(memento() as never));
    const remoteRoot = (srv.rootPath === '/' ? '' : srv.rootPath) + '/proj';
    const lastOp = () => (log as unknown as { ops: { counts: Record<string, number>; status: string; lines: { text: string }[] }[] }).ops[0];
    const tree = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await pool.run(srv, (t) => t.list(dir))) {
        out.push(e.path.slice(remoteRoot.length) + (e.isDir ? '/' : ''));
        if (e.isDir) out.push(...(await tree(e.path)));
      }
      return out.sort();
    };
    // clean remote
    await pool.run(srv, async (t) => { const st = await t.stat(remoteRoot); if (st) { const rm = async (p: string) => { for (const c of await t.list(p)) { if (c.isDir) await rm(c.path); else await t.deleteFile(c.path); } await t.deleteDir(p); }; await rm(remoteRoot); } }).catch((e) => console.log('cleanup', kind, e.message));

    await test(`${kind}: upload project (excludes applied)`, async () => {
      const ok = await deployer.upload(project, [srv], [root]);
      const op = lastOp();
      assert.ok(ok, JSON.stringify(op.lines.map((l) => l.text)));
      assert.deepEqual(await tree(remoteRoot), ['/index.php', '/src/', '/src/a.txt', '/src/deep/', '/src/deep/b.bin']);
      assert.equal(op.counts.transferred, 3);
      const data = await pool.run(srv, (t) => t.readFile(remoteRoot + '/src/deep/b.bin'));
      assert.equal(data.length, 70000);
    });
    await test(`${kind}: second upload skips up-to-date files`, async () => {
      await deployer.upload(project, [srv], [root]);
      const op = lastOp();
      if (kind === 'webdav') { assert.ok(op.status !== 'error'); return; } // no mtime support
      assert.equal(op.counts.transferred ?? 0, 0, JSON.stringify(op.counts));
      assert.equal(op.counts.upToDate, 3);
    });
    await test(`${kind}: timestamps + permissions preserved`, async () => {
      const st = await pool.run(srv, (t) => t.stat(remoteRoot + '/src/a.txt'));
      assert.ok(st);
      if (kind !== 'webdav') assert.ok(Math.abs(st!.mtime - fs.statSync(path.join(root, 'src/a.txt')).mtimeMs) < 2000, `mtime ${st!.mtime}`);
      if (kind === 'local' || kind === 'sftp') assert.equal(st!.mode! & 0o777, 0o640);
    });
    await test(`${kind}: changed file is uploaded`, async () => {
      write(path.join(root, 'src/a.txt'), 'hello world');
      await deployer.upload(project, [srv], [path.join(root, 'src/a.txt')]);
      assert.equal(lastOp().counts.transferred, 1);
      assert.equal((await pool.run(srv, (t) => t.readFile(remoteRoot + '/src/a.txt'))).toString(), 'hello world');
    });
    await test(`${kind}: warns when remote changed since last upload`, async () => {
      await new Promise((r) => setTimeout(r, 1100));
      await pool.run(srv, (t) => t.writeFile(remoteRoot + '/src/a.txt', Buffer.from('changed on server!')));
      write(path.join(root, 'src/a.txt'), 'local edit');
      messages.length = 0;
      answers.warning = (_m, items) => items.find((i) => i === 'Skip') ?? items[0];
      await deployer.upload(project, [srv], [path.join(root, 'src/a.txt')]);
      answers.warning = (_m, items) => items[0];
      assert.equal(lastOp().counts.skippedByUser, 1, JSON.stringify(lastOp().counts) + messages.join('|'));
      assert.equal((await pool.run(srv, (t) => t.readFile(remoteRoot + '/src/a.txt'))).toString(), 'changed on server!');
    });
    await test(`${kind}: download restores files`, async () => {
      fs.rmSync(path.join(root, 'src'), { recursive: true });
      await deployer.download(project, srv, [root]);
      assert.equal(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8'), 'changed on server!');
      assert.equal(fs.statSync(path.join(root, 'src/deep/b.bin')).size, 70000);
      assert.ok(fs.existsSync(path.join(root, 'vendor/lib.php')), 'local excluded kept');
    });
    await test(`${kind}: deleteMissing removes remote extras`, async () => {
      fs.rmSync(path.join(root, 'src/deep'), { recursive: true });
      await deployer.upload(project, [srv], [root], { deleteMissing: true });
      assert.deepEqual(await tree(remoteRoot), ['/index.php', '/src/', '/src/a.txt']);
    });
    await test(`${kind}: remote copy, move and delete`, async () => {
      const a = (await pool.run(srv, (t) => t.stat(remoteRoot + '/src')))!;
      await deployer.copyRemote(project, srv, [a], remoteRoot + '/copy', false);
      await deployer.copyRemote(project, srv, [(await pool.run(srv, (t) => t.stat(remoteRoot + '/index.php')))!], remoteRoot + '/copy', true);
      const t = await tree(remoteRoot);
      assert.ok(t.includes('/copy/src/a.txt') && t.includes('/copy/index.php') && !t.includes('/index.php'), t.join(','));
      await deployer.deleteRemote(project, srv, [remoteRoot + '/copy']);
      assert.deepEqual(await tree(remoteRoot), ['/src/', '/src/a.txt']);
    });
    if (kind !== 'webdav') {
      await test(`${kind}: chmod`, async () => {
        await pool.run(srv, (t) => t.chmod!(remoteRoot + '/src/a.txt', 0o600));
        const st = await pool.run(srv, (t) => t.stat(remoteRoot + '/src/a.txt'));
        if (st?.mode !== undefined) assert.equal(st.mode & 0o777, 0o600);
      });
    }
    await pool.disconnect();
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
void main();
