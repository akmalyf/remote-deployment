import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Config, newServer, normalizeConfig, normalizeServer, Protocol, PROTOCOL_LABELS, Server } from '../core/config';
import type { Credentials } from '../core/credentials';
import { projectRelative } from '../core/paths';
import type { Project, Projects } from '../core/project';
import type { ConnectionPool } from '../transport/pool';

type Tab = 'servers' | 'options';

interface Msg {
  type: string;
  config?: Config;
  server?: Server;
  index?: number;
  field?: string;
  kind?: 'password' | 'passphrase';
}

/** Server configuration and options, as a webview. */
export class SettingsPanel {
  static extensionUri: vscode.Uri;
  private static current?: SettingsPanel;
  private readonly panel: vscode.WebviewPanel;
  private project: Project;

  static show(project: Project, deps: { projects: Projects; pool: ConnectionPool; credentials: Credentials }, tab: Tab = 'servers', select?: string): void {
    if (SettingsPanel.current && SettingsPanel.current.project === project) {
      SettingsPanel.current.panel.reveal();
      void SettingsPanel.current.post({ type: 'focus', tab, select });
      return;
    }
    SettingsPanel.current?.panel.dispose();
    SettingsPanel.current = new SettingsPanel(project, deps, tab, select);
  }

  private constructor(
    project: Project,
    private readonly deps: { projects: Projects; pool: ConnectionPool; credentials: Credentials },
    tab: Tab,
    select?: string,
  ) {
    this.project = project;
    this.panel = vscode.window.createWebviewPanel('deploy.settings', `Deployment: ${project.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(SettingsPanel.extensionUri, 'dist', 'media')],
    });
    this.panel.iconPath = new vscode.ThemeIcon('server-environment');
    this.panel.webview.html = this.html(tab, select);
    this.panel.onDidDispose(() => {
      if (SettingsPanel.current === this) {
        SettingsPanel.current = undefined;
      }
    });
    this.panel.webview.onDidReceiveMessage((m: Msg) => void this.onMessage(m));
  }

  private post(m: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(m);
  }

  private async state(): Promise<Record<string, unknown>> {
    const saved: Record<string, boolean> = {};
    for (const s of this.project.config.servers) {
      saved[s.name] = await this.deps.credentials.has(s, 'password');
    }
    return { config: this.project.config, root: this.project.root, saved, platform: process.platform };
  }

  private validate(config: Config): string | undefined {
    const names = new Set<string>();
    for (const s of config.servers) {
      if (!s.name.trim()) {
        return 'Server name is empty';
      }
      if (names.has(s.name)) {
        return `Duplicate server name "${s.name}"`;
      }
      names.add(s.name);
      if (s.type !== 'local' && !s.host.trim()) {
        return `${s.name}: host is not specified`;
      }
      if (s.type === 'local' && !s.rootPath.trim()) {
        return `${s.name}: folder is not specified`;
      }
      if (s.type === 'sftp' && s.auth === 'key' && !s.keyPath) {
        return `${s.name}: private key file is not specified`;
      }
      if (s.keepAliveSecs !== undefined && (!Number.isFinite(s.keepAliveSecs) || s.keepAliveSecs < 0)) {
        return `${s.name}: Keep-alive timeout is not valid`;
      }
      if (s.type !== 'local' && s.rootPath && !s.rootPath.startsWith('/')) {
        return `${s.name}: Root path is not valid`;
      }
    }
    for (const g of config.groups) {
      if (!g.name.trim() || names.has(g.name)) {
        return `Invalid or duplicate group name "${g.name}"`;
      }
      names.add(g.name);
    }
    for (const k of ['filePermissions', 'folderPermissions'] as const) {
      const v = config.options[k];
      if (v && !/^[0-7]{3,4}$/.test(v)) {
        return `Invalid ${k}: use octal, e.g. 644`;
      }
    }
    return undefined;
  }

  private async onMessage(m: Msg): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.post({ type: 'init', ...(await this.state()) });
        break;
      case 'save': {
        const config = normalizeConfig(m.config);
        const error = this.validate(config);
        if (error) {
          await this.post({ type: 'error', text: error });
          return;
        }
        // Mappings with an empty local path mean the project root.
        for (const s of config.servers) {
          s.mappings = s.mappings.filter((x) => x.local || x.deploy || x.web).map((x) => ({ local: x.local || '.', deploy: x.deploy || '/', web: x.web || '/' }));
        }
        await this.project.save(config);
        this.deps.projects.reloadAll();
        await this.deps.pool.disconnect();
        await this.post({ type: 'saved', ...(await this.state()) });
        vscode.window.setStatusBarMessage('$(check) Deployment configuration saved', 3000);
        break;
      }
      case 'test': {
        const server = normalizeServer(m.server!);
        const session = this.deps.pool.fresh(server);
        try {
          const home = await session.run((t) => t.home());
          const root = server.rootPath || home;
          const st = server.type === 'local' ? true : await session.run((t) => t.stat(root));
          await this.post({ type: 'testResult', ok: true, text: `Successfully connected to ${server.host || server.rootPath}.${st ? '' : ` Root path ${root} does not exist.`}` });
        } catch (e) {
          await this.post({ type: 'testResult', ok: false, text: `Connection to '${server.name}' failed.\n${(e as Error).message}` });
        } finally {
          await session.close().catch(() => undefined);
        }
        break;
      }
      case 'autodetect': {
        const server = normalizeServer(m.server!);
        const session = this.deps.pool.fresh(server);
        try {
          const home = await session.run((t) => t.home());
          await this.post({ type: 'set', field: 'rootPath', value: home });
        } catch (e) {
          await this.post({ type: 'testResult', ok: false, text: (e as Error).message });
        } finally {
          await session.close().catch(() => undefined);
        }
        break;
      }
      case 'browseRemoteRoot': {
        const server = normalizeServer(m.server!);
        const picked = await browseRemoteFolder(this.deps.pool, server, server.rootPath || undefined, `Choose Root Path on ${server.name}`);
        if (picked) {
          await this.post({ type: 'set', field: 'rootPath', value: picked });
        }
        break;
      }
      case 'browseDeploy': {
        const server = normalizeServer(m.server!);
        const root = server.rootPath || '/';
        const picked = await browseRemoteFolder(this.deps.pool, server, root, 'Choose Deployment Path');
        if (picked) {
          const rel = root === '/' ? picked : picked.startsWith(root) ? picked.slice(root.length) || '/' : picked;
          await this.post({ type: 'setMapping', index: m.index, field: 'deploy', value: rel.startsWith('/') ? rel : '/' + rel });
        }
        break;
      }
      case 'browseLocal': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: m.field === 'keyPath' || m.field === 'excludedLocal',
          canSelectFolders: m.field !== 'keyPath',
          defaultUri: m.field === 'keyPath' ? vscode.Uri.file(path.join(os.homedir(), '.ssh')) : this.project.folder.uri,
          openLabel: 'Select',
        });
        if (!uris?.[0]) {
          return;
        }
        const p = uris[0].fsPath;
        if (m.field === 'mapping') {
          await this.post({ type: 'setMapping', index: m.index, field: 'local', value: projectRelative(this.project.root, p) });
        } else if (m.field === 'excludedLocal') {
          await this.post({ type: 'addExcluded', local: true, value: projectRelative(this.project.root, p) });
        } else {
          await this.post({ type: 'set', field: m.field, value: p });
        }
        break;
      }
      case 'setPassword': {
        const server = normalizeServer(m.server!);
        const kind = m.kind ?? 'password';
        const value = await vscode.window.showInputBox({ prompt: `${kind === 'password' ? 'Password' : 'Key passphrase'} for ${server.name}`, password: true, ignoreFocusOut: true });
        if (value !== undefined) {
          const permanent = (await vscode.window.showQuickPick(['Save password permanently', 'Save until restart'], { placeHolder: 'Remember it?' })) !== 'Save until restart';
          await this.deps.credentials.set(server, kind, value, permanent);
          await this.post({ type: 'passwordSaved', name: server.name, text: permanent ? 'Password saved permanently' : 'Password saved until IDE restart' });
        }
        break;
      }
      case 'forgetPassword': {
        const server = normalizeServer(m.server!);
        await this.deps.credentials.forget(server, 'password');
        await this.deps.credentials.forget(server, 'passphrase');
        await this.post({ type: 'passwordSaved', name: server.name, text: 'Password removed', removed: true });
        break;
      }
      case 'addServer': {
        const picked = await vscode.window.showQuickPick(
          [
            ...(['sftp', 'ftp', 'ftps', 'webdav', 'local'] as Protocol[]).map((t) => ({ label: PROTOCOL_LABELS[t], type: t as Protocol | 'group' })),
            { label: '', kind: vscode.QuickPickItemKind.Separator, type: 'group' as const },
            { label: 'Server group', description: 'Run operations on several servers', type: 'group' as const },
          ],
          { title: 'Add Deployment Server', placeHolder: 'Connection type' },
        );
        if (!picked) {
          return;
        }
        const name = await vscode.window.showInputBox({ title: 'Add Deployment Server', prompt: 'Name', value: picked.type === 'group' ? 'group' : picked.type === 'local' ? 'local' : 'server' });
        if (!name) {
          return;
        }
        await this.post(picked.type === 'group' ? { type: 'added', group: { name } } : { type: 'added', server: newServer(name, picked.type) });
        break;
      }
      case 'openJson':
        await vscode.window.showTextDocument(vscode.Uri.file(this.project.configPath));
        break;
      case 'close':
        this.panel.dispose();
        break;
    }
  }

  private html(tab: Tab, select?: string): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const media = (f: string): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(SettingsPanel.extensionUri, 'dist', 'media', f));
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};`;
    const boot = JSON.stringify({ tab, select: select ?? null });
    return /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('codicon.css')}" id="vscode-codicon-stylesheet">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  #app { height: 100%; display: flex; flex-direction: column; }
  header { display: flex; align-items: flex-end; gap: 8px; padding: 0 16px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
  header vscode-tabs { flex: 1; }
  main { flex: 1; min-height: 0; display: flex; }
  aside { width: 260px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); /* Tinted towards the foreground so the list stands apart even when the theme's sidebar matches the editor. */ background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 94%, var(--vscode-foreground)); }
  .list-toolbar { display: flex; align-items: center; justify-content: space-between; height: 35px; padding: 0 4px 0 12px; }
  .list-title { font-size: 11px; font-weight: 700; letter-spacing: .04em; color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground)); }
  .list { flex: 1; overflow: auto; }
  .item { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 12px 0 16px; cursor: pointer; color: var(--vscode-sideBar-foreground, var(--vscode-foreground)); }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px solid var(--vscode-list-focusOutline, transparent); outline-offset: -1px; }
  .item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .meta { font-size: 11px; opacity: .7; }
  .item .star { color: var(--vscode-charts-yellow, #cca700); }
  .section { padding: 10px 12px 2px; font-size: 11px; font-weight: 700; opacity: .8; }
  .detail { flex: 1; min-width: 0; overflow: auto; padding: 12px 24px 24px; }
  .detail h2 { display: flex; align-items: center; gap: 8px; font-size: 20px; font-weight: 600; margin: 4px 0 12px; }
  .badge { font-size: 11px; font-weight: 400; padding: 1px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .detail vscode-tabs { margin-bottom: 8px; }
  .page, .options { max-width: 820px; }
  .options h3 { font-size: 14px; font-weight: 600; margin: 20px 0 4px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-settings-headerBorder, var(--vscode-panel-border)); }
  .options h3:first-child { margin-top: 4px; }
  vscode-form-group { max-width: 760px; }
  vscode-textfield.wide, vscode-single-select { width: 100%; max-width: 480px; }
  /* Some themes give text inputs the editor background and no border; draw them like the dropdowns. */
  vscode-textfield {
    --vscode-settings-textInputBackground: var(--vscode-settings-dropdownBackground, var(--vscode-dropdown-background, #313131));
    --vscode-settings-textInputBorder: var(--vscode-settings-dropdownBorder, var(--vscode-dropdown-border, var(--vscode-input-border, #3c3c3c)));
  }
  vscode-table vscode-textfield.wide { max-width: none; }
  .row { display: flex; gap: 8px; align-items: center; max-width: 620px; }
  .row vscode-textfield { flex: 1; }
  .actions { display: flex; gap: 8px; margin: 16px 0 0; }
  .desc { color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 8px 0 12px; }
  .desc.empty { padding: 0 16px; }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
  .members { display: flex; flex-direction: column; gap: 4px; }
  .member { display: flex; align-items: center; gap: 8px; }
  .order { font-size: 11px; opacity: .7; }
  .notice { display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin: 4px 0 12px; border-radius: 3px; border-left: 3px solid var(--vscode-notificationsInfoIcon-foreground, var(--vscode-focusBorder)); background: var(--vscode-inputValidation-infoBackground, var(--vscode-editorWidget-background)); white-space: pre-wrap; max-width: 760px; }
  .notice.error { border-left-color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, var(--vscode-editorWidget-background)); }
  .notice.ok { border-left-color: var(--vscode-testing-iconPassed, #73c991); }
  footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
  footer .dirty { flex: 1; color: var(--vscode-descriptionForeground); }
</style></head>
<body><div id="app"></div>
<script nonce="${nonce}">window.__SETTINGS__ = ${boot};</script>
<script nonce="${nonce}" src="${media('settings.js')}"></script>
</body></html>`;
  }
}

/** Pick a remote folder by walking the server with a quick pick. */
export async function browseRemoteFolder(pool: ConnectionPool, server: Server, start: string | undefined, title: string): Promise<string | undefined> {
  let dir = start || (await pool.run(server, (t) => t.home()));
  for (;;) {
    let entries;
    try {
      entries = (await pool.run(server, (t) => t.list(dir))).filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      void vscode.window.showErrorMessage(`${dir}: ${(e as Error).message}`);
      return undefined;
    }
    const items: (vscode.QuickPickItem & { path?: string; select?: boolean })[] = [
      { label: `$(check) Use ${dir}`, select: true, path: dir },
      ...(dir !== '/' ? [{ label: '$(arrow-up) ..', path: path.posix.dirname(dir) }] : []),
      ...entries.map((e) => ({ label: `$(folder) ${e.name}`, path: e.path })),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: `${title} — ${dir}`, placeHolder: 'Choose a folder' });
    if (!picked?.path) {
      return undefined;
    }
    if (picked.select) {
      return picked.path;
    }
    dir = picked.path;
  }
}
