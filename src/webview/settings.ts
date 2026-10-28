// Deployment configuration webview, built from @vscode-elements components laid out like the
// VS Code Settings editor. The draft lives here until Apply/OK sends it to SettingsPanel.
import '@vscode-elements/elements/dist/main.js';
import { html, nothing, render, type TemplateResult } from 'lit';

type Protocol = 'sftp' | 'ftp' | 'ftps' | 'local' | 'webdav';
interface Mapping {
  local: string;
  deploy: string;
  web: string;
}
interface Excluded {
  path: string;
  local: boolean;
}
interface Server {
  name: string;
  type: Protocol;
  host: string;
  port?: number;
  user: string;
  auth: 'password' | 'key' | 'agent' | 'openSsh';
  keyPath?: string;
  rootPath: string;
  webUrl: string;
  passive: boolean;
  ftpsExplicit: boolean;
  ftpsProtection?: string;
  disableTls13?: boolean;
  showHidden?: boolean;
  keepAliveSecs?: number;
  timeoutSecs: number;
  ssl: boolean;
  rsync: boolean;
  sudo: boolean;
  global?: boolean;
  mappings: Mapping[];
  excludedPaths: Excluded[];
}
interface Group {
  name: string;
  servers: string[];
}
interface Config {
  defaultServer?: string;
  servers: Server[];
  groups: Group[];
  options: Record<string, any>;
}

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
declare global {
  interface Window {
    __SETTINGS__: { tab: 'servers' | 'options'; select: string | null };
  }
}
const vscode = acquireVsCodeApi();
const post = (m: Record<string, unknown>): void => vscode.postMessage(m);

let draft: Config | undefined;
let tab = window.__SETTINGS__.tab;
let sel: string | null = window.__SETTINGS__.select;
let sub: 'connection' | 'mappings' | 'excluded' = 'connection';
let saved: Record<string, boolean> = {};
let root = '';
let dirty = false;
let closeAfterSave = false;
let notice: { text: string; kind: 'info' | 'error' | 'ok' } | undefined;

const PROTOCOLS: [Protocol, string][] = [
  ['sftp', 'SFTP'],
  ['ftp', 'FTP'],
  ['ftps', 'FTPS'],
  ['webdav', 'WebDAV'],
  ['local', 'Local or mounted folder'],
];

function defaultPort(s: Server): number | '' {
  switch (s.type) {
    case 'sftp':
      return 22;
    case 'ftp':
      return 21;
    case 'ftps':
      return s.ftpsExplicit ? 21 : 990;
    case 'webdav':
      return s.ssl ? 443 : 80;
    default:
      return '';
  }
}

function current(): { server?: Server; group?: Group } {
  if (!draft || !sel) return {};
  if (sel.startsWith('#g:')) return { group: draft.groups.find((g) => g.name === sel!.slice(3)) };
  return { server: draft.servers.find((s) => s.name === sel) };
}

function markDirty(): void {
  dirty = true;
  draw();
}

function uniqueName(base: string): string {
  const all = [...draft!.servers.map((s) => s.name), ...draft!.groups.map((g) => g.name)];
  let n = base;
  let i = 2;
  while (all.includes(n)) n = `${base} (${i++})`;
  return n;
}

// ------------------------------------------------------------------ field helpers

const val = (e: Event): string => (e.target as HTMLInputElement).value;
const checked = (e: Event): boolean => (e.target as HTMLInputElement).checked;

/** One setting in the Settings-editor style: title, description, control. */
function setting(title: string, control: TemplateResult, description?: TemplateResult | string): TemplateResult {
  return html`<vscode-form-group variant="settings-group">
    <vscode-label>${title}</vscode-label>
    ${description ? html`<vscode-form-helper>${description}</vscode-form-helper>` : nothing}
    ${control}
  </vscode-form-group>`;
}

function text(value: string | number | undefined, onChange: (v: string) => void, opts: { placeholder?: string; type?: string; after?: TemplateResult } = {}): TemplateResult {
  return html`<vscode-textfield
    class="wide"
    type=${opts.type ?? 'text'}
    .value=${value === undefined ? '' : String(value)}
    placeholder=${opts.placeholder ?? ''}
    @change=${(e: Event) => onChange(val(e))}
    >${opts.after ?? nothing}</vscode-textfield
  >`;
}

function check(label: string, value: boolean | undefined, onChange: (v: boolean) => void): TemplateResult {
  return html`<vscode-checkbox .checked=${!!value} @change=${(e: Event) => onChange(checked(e))}>${label}</vscode-checkbox>`;
}

function select(value: string, options: [string, string][], onChange: (v: string) => void): TemplateResult {
  return html`<vscode-single-select .value=${value} @change=${(e: Event) => onChange(val(e))}>
    ${options.map(([v, l]) => html`<vscode-option value=${v} ?selected=${v === value}>${l}</vscode-option>`)}
  </vscode-single-select>`;
}

const icon = (name: string, title: string, onClick: () => void): TemplateResult =>
  html`<vscode-icon slot="content-after" name=${name} title=${title} action-icon @click=${onClick}></vscode-icon>`;

// ------------------------------------------------------------------ server pages

function connectionPage(s: Server): TemplateResult {
  const t = s.type;
  const set = <K extends keyof Server>(k: K, v: Server[K], redraw = false): void => {
    s[k] = v;
    dirty = true;
    if (redraw) draw();
    else draw();
  };
  const remote = t !== 'local';
  return html`
    ${setting('Name', text(s.name, (v) => renameServer(s, v)))}
    ${setting('Type', select(t, PROTOCOLS, (v) => {
      if (v === 'local' && s.rootPath === '/') s.rootPath = '';
      set('type', v as Protocol, true);
    }))}
    ${setting('Visibility', check('Visible only for this project', !s.global, (v) => set('global', !v, true)), 'When off, the connection is shared by all your projects; mappings stay in this project.')}
    ${!remote
      ? setting('Folder', text(s.rootPath, (v) => set('rootPath', v), { after: icon('folder-opened', 'Browse…', () => post({ type: 'browseLocal', field: 'rootPath' })) }), 'Files are copied to this local or mounted folder.')
      : html`
          ${setting(t === 'webdav' ? 'Host or URL' : 'Host', text(s.host, (v) => set('host', v)), t === 'sftp' && s.auth === 'openSsh' ? 'Host alias from ~/.ssh/config.' : undefined)}
          ${setting('Port', text(s.port, (v) => set('port', v ? Number(v) : undefined), { type: 'number', placeholder: String(defaultPort(s)) }))}
          ${t === 'ftp' || t === 'ftps' ? setting('Login', check('Anonymous login', s.user === 'anonymous', (v) => set('user', v ? 'anonymous' : '', true))) : nothing}
          ${s.user !== 'anonymous' || t === 'sftp' || t === 'webdav' ? setting('Username', text(s.user, (v) => set('user', v))) : nothing}
          ${t === 'sftp'
            ? setting('Authentication', select(s.auth, [['password', 'Password'], ['key', 'Key pair'], ['agent', 'OpenSSH agent'], ['openSsh', 'OpenSSH config and authentication agent']], (v) => set('auth', v as Server['auth'], true)))
            : nothing}
          ${t === 'sftp' && s.auth === 'key'
            ? setting(
                'Private key file',
                html`<div class="row">${text(s.keyPath, (v) => set('keyPath', v || undefined), { after: icon('folder-opened', 'Browse…', () => post({ type: 'browseLocal', field: 'keyPath' })) })}
                  <vscode-button secondary @click=${() => post({ type: 'setPassword', server: s, kind: 'passphrase' })}>Passphrase…</vscode-button></div>`,
              )
            : nothing}
          ${t !== 'sftp' || s.auth === 'password'
            ? setting(
                'Password',
                html`<div class="row">
                  <vscode-button secondary icon="key" @click=${() => post({ type: 'setPassword', server: s, kind: 'password' })}>${saved[s.name] ? 'Change…' : 'Set…'}</vscode-button>
                  ${saved[s.name] ? html`<vscode-button secondary icon="trash" @click=${() => post({ type: 'forgetPassword', server: s })}>Forget</vscode-button>` : nothing}
                </div>`,
                saved[s.name] ? 'Saved in the OS keychain.' : 'Not saved: you are asked when connecting.',
              )
            : nothing}
          ${setting(
            'Root path',
            html`<div class="row">${text(s.rootPath, (v) => set('rootPath', v), { placeholder: '/', after: icon('folder-opened', 'Choose on server…', () => post({ type: 'browseRemoteRoot', server: s })) })}
              <vscode-button secondary @click=${() => {
                showNotice('Connecting…', 'info');
                post({ type: 'autodetect', server: s });
              }}>Autodetect</vscode-button></div>`,
            'Used as a root directory for browsing the remote file system and setting the server path mappings and excluded paths.',
          )}
        `}
    ${setting('Web server URL', text(s.webUrl, (v) => set('webUrl', v), { placeholder: 'http://' }), 'Used by Open in Browser and web path mappings.')}
    ${t === 'ftp' || t === 'ftps'
      ? html`${setting('Passive mode', check('Use passive mode', s.passive, (v) => set('passive', v)))}
        ${setting('Hidden files', check('Show and process hidden files', s.showHidden !== false, (v) => set('showHidden', v)))}`
      : nothing}
    ${t === 'ftps'
      ? html`${setting('TLS', select(s.ftpsExplicit ? 'true' : 'false', [['true', 'Explicit'], ['false', 'Implicit']], (v) => set('ftpsExplicit', v === 'true', true)), 'Explicit FTPS usually uses port 21, implicit FTPS uses 990.')}
        ${setting('Data channel protection', select(s.ftpsProtection ?? 'default', [['default', '<default>'], ['clear', 'Clear'], ['private', 'Private']], (v) => set('ftpsProtection', v)))}
        ${setting('TLS 1.3', check('Disable TLS 1.3', s.disableTls13, (v) => set('disableTls13', v)))}`
      : nothing}
    ${t === 'webdav' ? setting('HTTPS', check('Use HTTPS', s.ssl, (v) => set('ssl', v, true))) : nothing}
    ${t === 'sftp'
      ? html`${setting('rsync', check('Use rsync for folder transfers', s.rsync, (v) => set('rsync', v)), 'Needs agent, key or OpenSSH authentication; falls back to SFTP otherwise.')}
        ${setting('sudo', check('Write files with sudo -n', s.sudo, (v) => set('sudo', v)), 'Requires passwordless sudo on the server.')}`
      : nothing}
    ${remote
      ? html`${setting('Keep-alive', text(s.keepAliveSecs, (v) => set('keepAliveSecs', v ? Number(v) : undefined), { type: 'number', placeholder: '30' }), 'Seconds between keep-alive packets.')}
        ${setting('Timeout', text(s.timeoutSecs, (v) => set('timeoutSecs', Number(v) || 30), { type: 'number' }), 'Connection timeout in seconds.')}`
      : nothing}
    <div class="actions">
      <vscode-button icon="plug" @click=${() => {
        showNotice('Connecting…', 'info');
        post({ type: 'test', server: s });
      }}>Test Connection</vscode-button>
    </div>
  `;
}

function mappingsPage(s: Server): TemplateResult {
  const set = (i: number, k: keyof Mapping, v: string): void => {
    s.mappings[i][k] = v;
    dirty = true;
    draw();
  };
  return html`
    <p class="desc">
      Local path is relative to the project (${root}) or absolute. Deployment path is relative to the root path${s.rootPath && s.rootPath !== '/' ? html` (<code>${s.rootPath}</code>)` : ''}.
      Web path is relative to the web server URL${s.webUrl ? html` (<code>${s.webUrl}</code>)` : ''}.
    </p>
    <vscode-table zebra bordered-columns resizable columns='["40%","30%","22%","8%"]'>
      <vscode-table-header slot="header">
        <vscode-table-header-cell>Local path</vscode-table-header-cell>
        <vscode-table-header-cell>Deployment path</vscode-table-header-cell>
        <vscode-table-header-cell>Web path</vscode-table-header-cell>
        <vscode-table-header-cell></vscode-table-header-cell>
      </vscode-table-header>
      <vscode-table-body slot="body">
        ${s.mappings.map(
          (m, i) => html`<vscode-table-row>
            <vscode-table-cell>${text(m.local, (v) => set(i, 'local', v), { placeholder: '.', after: icon('folder-opened', 'Browse…', () => post({ type: 'browseLocal', field: 'mapping', index: i })) })}</vscode-table-cell>
            <vscode-table-cell>${text(m.deploy, (v) => set(i, 'deploy', v), { placeholder: '/', after: icon('remote-explorer', 'Choose on server…', () => post({ type: 'browseDeploy', server: s, index: i })) })}</vscode-table-cell>
            <vscode-table-cell>${text(m.web, (v) => set(i, 'web', v), { placeholder: '/' })}</vscode-table-cell>
            <vscode-table-cell><vscode-icon name="trash" action-icon title="Remove mapping" @click=${() => {
              s.mappings.splice(i, 1);
              markDirty();
            }}></vscode-icon></vscode-table-cell>
          </vscode-table-row>`,
        )}
      </vscode-table-body>
    </vscode-table>
    <div class="actions">
      <vscode-button secondary icon="add" @click=${() => {
        s.mappings.push({ local: '', deploy: '/', web: '/' });
        markDirty();
      }}>Add Mapping</vscode-button>
    </div>
  `;
}

function excludedPage(s: Server): TemplateResult {
  return html`
    <p class="desc">Any matching file, directory or its child is excluded from download and upload.</p>
    ${s.excludedPaths.length
      ? html`<vscode-table zebra bordered-columns columns='["22%","70%","8%"]'>
          <vscode-table-header slot="header">
            <vscode-table-header-cell>Type</vscode-table-header-cell>
            <vscode-table-header-cell>Path</vscode-table-header-cell>
            <vscode-table-header-cell></vscode-table-header-cell>
          </vscode-table-header>
          <vscode-table-body slot="body">
            ${s.excludedPaths.map(
              (e, i) => html`<vscode-table-row>
                <vscode-table-cell><vscode-icon name=${e.local ? 'folder' : 'remote'}></vscode-icon> ${e.local ? 'Local path' : 'Deployment path'}</vscode-table-cell>
                <vscode-table-cell>${text(e.path, (v) => {
                  e.path = v;
                  dirty = true;
                  draw();
                })}</vscode-table-cell>
                <vscode-table-cell><vscode-icon name="trash" action-icon title="Remove" @click=${() => {
                  s.excludedPaths.splice(i, 1);
                  markDirty();
                }}></vscode-icon></vscode-table-cell>
              </vscode-table-row>`,
            )}
          </vscode-table-body>
        </vscode-table>`
      : html`<p class="desc">No excluded paths added.</p>`}
    <div class="actions">
      <vscode-button secondary icon="folder" @click=${() => post({ type: 'browseLocal', field: 'excludedLocal' })}>Add Local Path…</vscode-button>
      <vscode-button secondary icon="remote" @click=${() => {
        s.excludedPaths.push({ path: '/', local: false });
        markDirty();
      }}>Add Deployment Path</vscode-button>
    </div>
  `;
}

function groupPage(g: Group): TemplateResult {
  return html`
    ${setting('Name', text(g.name, (v) => {
      const old = g.name;
      g.name = v;
      if (draft!.defaultServer === old) draft!.defaultServer = v;
      sel = '#g:' + v;
      markDirty();
    }))}
    ${setting(
      'Members',
      html`<div class="members">
        ${draft!.servers.map((s) => {
          const idx = g.servers.indexOf(s.name);
          return html`<div class="member">
            ${check(s.name, idx >= 0, (v) => {
              if (v && idx < 0) g.servers.push(s.name);
              if (!v && idx >= 0) g.servers.splice(idx, 1);
              markDirty();
            })}
            ${idx >= 0
              ? html`<span class="order">${idx + 1}</span>${idx > 0
                    ? html`<vscode-icon name="arrow-up" action-icon title="Move up" @click=${() => {
                        [g.servers[idx - 1], g.servers[idx]] = [g.servers[idx], g.servers[idx - 1]];
                        markDirty();
                      }}></vscode-icon>`
                    : nothing}`
              : nothing}
          </div>`;
        })}
      </div>`,
      'Operations run on each member in order. A failure on one server does not stop the others.',
    )}
  `;
}

function renameServer(s: Server, v: string): void {
  const old = s.name;
  s.name = v;
  sel = v;
  if (draft!.defaultServer === old) draft!.defaultServer = v;
  draft!.groups.forEach((g) => (g.servers = g.servers.map((n) => (n === old ? v : n))));
  if (draft!.options.uploadOnCommit === old) draft!.options.uploadOnCommit = v;
  markDirty();
}

// ------------------------------------------------------------------ options page

function optionsPage(): TemplateResult {
  const o = draft!.options;
  const set = (k: string, v: unknown, redraw = false): void => {
    o[k] = v === '' ? undefined : v;
    dirty = true;
    if (redraw) draw();
    else draw();
  };
  const targets: [string, string][] = [['', 'Never'], ...draft!.servers.map((s) => [s.name, s.name] as [string, string]), ...draft!.groups.map((g) => [g.name, `${g.name} (group)`] as [string, string])];
  return html`<div class="options">
    <h3>Transfers</h3>
    ${setting('Exclude items by name', text(o.excludeByName, (v) => set('excludeByName', v)), html`Use <code>;</code> as delimiter, <code>*</code> and <code>?</code> as wildcards.`)}
    ${setting('Confirm before uploading', check('Ask before a manual upload', o.confirmBeforeUploading, (v) => set('confirmBeforeUploading', v)), 'Automatic upload and upload on commit never ask.')}
    ${setting('Confirm before deletion', check('Ask before deleting items on the server', o.confirmBeforeDeletion, (v) => set('confirmBeforeDeletion', v)))}
    ${setting('Overwrite up-to-date files', check('Transfer files even when size and timestamp match', o.overwriteUpToDate, (v) => set('overwriteUpToDate', v)))}
    ${setting('Preserve file timestamps', check('Keep the modification time of transferred files', o.preserveTimestamps, (v) => set('preserveTimestamps', v)))}
    ${setting('Delete target items', check('Delete target items when source ones do not exist', o.deleteMissingItems, (v) => set('deleteMissingItems', v)), 'When transferring from the Explorer or the Remote Host view.')}
    ${setting('Create empty directories', check('Create empty directories', o.createEmptyFolders, (v) => set('createEmptyFolders', v)))}
    ${setting('Prompt when overwriting local items', check('Prompt when overwriting or deleting local items', o.promptOnLocalOverwrite, (v) => set('promptOnLocalOverwrite', v)))}
    ${setting('Safe write', check('Upload to a temporary file, then rename', o.useTempFile, (v) => set('useTempFile', v)))}
    ${setting('Operations logging', select(o.logLevel, [['errors', 'Errors only'], ['brief', 'Brief'], ['details', 'Details']], (v) => set('logLevel', v)))}

    <h3>Automatic Upload</h3>
    ${setting('Upload changed files automatically to the default server', select(o.autoUpload, [['always', 'Always'], ['onExplicitSave', 'On explicit save action'], ['never', 'Never']], (v) => set('autoUpload', v)))}
    ${setting('Skip external changes', check('Do not upload files changed outside the editor', !o.uploadExternalChanges, (v) => set('uploadExternalChanges', !v)), 'For example by git or a build tool.')}
    ${setting('Delete remote files', check('Delete remote files when local are deleted', o.deleteRemoteOnLocalDelete, (v) => set('deleteRemoteOnLocalDelete', v)))}
    ${setting('Batch delay', text(o.autoUploadDebounceMs, (v) => set('autoUploadDebounceMs', Number(v) || 0), { type: 'number' }), 'Milliseconds without new changes before a batch is uploaded.')}
    ${setting('Confirm large batches', text(o.autoUploadConfirmOver, (v) => set('autoUploadConfirmOver', Number(v) || 0), { type: 'number' }), 'Ask before uploading more files than this at once. 0 = never ask.')}

    <h3>Remote Changes</h3>
    ${setting('Warn when uploading over newer file', select(o.promptOnRemoteOverwrite, [['none', 'No'], ['timestamp', 'Compare timestamp & size'], ['content', 'Compare content']], (v) => set('promptOnRemoteOverwrite', v)))}
    ${setting('Notify of remote changes', check('Warn when an opened file was changed on the server', o.notifyRemoteChanges, (v) => set('notifyRemoteChanges', v)))}

    <h3>Permissions</h3>
    ${setting('Files', text(o.filePermissions, (v) => set('filePermissions', v), { placeholder: 'e.g. 644' }), 'Override default permissions on uploaded files (octal).')}
    ${setting('Folders', text(o.folderPermissions, (v) => set('folderPermissions', v), { placeholder: 'e.g. 755' }), 'Override default permissions on created folders (octal).')}

    <h3>Version Control</h3>
    ${setting('Upload changed files after commit to', select(o.uploadOnCommit ?? '', targets, (v) => set('uploadOnCommit', v)))}
  </div>`;
}

// ------------------------------------------------------------------ layout

function serverList(): TemplateResult {
  const d = draft!;
  const c = current();
  const name = c.group?.name ?? c.server?.name;
  const isDefault = !!name && d.defaultServer === name;
  return html`<aside>
    <div class="list-toolbar">
      <span class="list-title">SERVERS</span>
      <vscode-toolbar-container>
        <vscode-toolbar-button icon="add" label="Add Server or Group…" @click=${() => post({ type: 'addServer' })}></vscode-toolbar-button>
        <vscode-toolbar-button icon="copy" label="Copy" ?disabled=${!c.server} @click=${copyServer}></vscode-toolbar-button>
        <vscode-toolbar-button icon=${isDefault ? 'star-full' : 'star-empty'} label="Use as Default" ?disabled=${!name} @click=${toggleDefault}></vscode-toolbar-button>
        <vscode-toolbar-button icon="trash" label="Remove" ?disabled=${!name} @click=${removeSelected}></vscode-toolbar-button>
      </vscode-toolbar-container>
    </div>
    <div class="list" role="listbox">
      ${d.servers.map(
        (s) => html`<div class="item ${sel === s.name ? 'selected' : ''}" role="option" @click=${() => select_(s.name)}>
          <vscode-icon name=${s.type === 'local' ? 'folder-library' : 'server'}></vscode-icon>
          <span class="label">${s.name}</span>
          <span class="meta">${s.type.toUpperCase()}${s.global ? ' · global' : ''}</span>
          ${d.defaultServer === s.name ? html`<vscode-icon name="star-full" class="star" title="Default server"></vscode-icon>` : nothing}
        </div>`,
      )}
      ${d.groups.length ? html`<div class="section">GROUPS</div>` : nothing}
      ${d.groups.map(
        (g) => html`<div class="item ${sel === '#g:' + g.name ? 'selected' : ''}" role="option" @click=${() => select_('#g:' + g.name)}>
          <vscode-icon name="server-environment"></vscode-icon>
          <span class="label">${g.name}</span>
          <span class="meta">${g.servers.length} servers</span>
          ${d.defaultServer === g.name ? html`<vscode-icon name="star-full" class="star" title="Default"></vscode-icon>` : nothing}
        </div>`,
      )}
      ${!d.servers.length ? html`<p class="desc empty">No servers yet. Use <vscode-icon name="add"></vscode-icon> to add one.</p>` : nothing}
    </div>
  </aside>`;
}

function select_(name: string): void {
  sel = name;
  notice = undefined;
  draw();
}

function copyServer(): void {
  const s = current().server;
  if (!s) return;
  const copy: Server = JSON.parse(JSON.stringify(s));
  copy.name = uniqueName(`${s.name} copy`);
  draft!.servers.push(copy);
  sel = copy.name;
  markDirty();
}

function toggleDefault(): void {
  const c = current();
  const name = c.group?.name ?? c.server?.name;
  if (!name) return;
  draft!.defaultServer = draft!.defaultServer === name ? undefined : name;
  markDirty();
}

function removeSelected(): void {
  const c = current();
  if (c.group) {
    draft!.groups = draft!.groups.filter((g) => g !== c.group);
  } else if (c.server) {
    const n = c.server.name;
    draft!.servers = draft!.servers.filter((s) => s !== c.server);
    draft!.groups.forEach((g) => (g.servers = g.servers.filter((x) => x !== n)));
  } else {
    return;
  }
  const name = c.group?.name ?? c.server?.name;
  if (draft!.defaultServer === name) draft!.defaultServer = undefined;
  sel = draft!.servers[0]?.name ?? null;
  markDirty();
}

function detail(): TemplateResult {
  const c = current();
  if (c.group) {
    return html`<section class="detail"><h2><vscode-icon name="server-environment"></vscode-icon> ${c.group.name}</h2>${noticeBar()}${groupPage(c.group)}</section>`;
  }
  const s = c.server;
  if (!s) {
    return html`<section class="detail"><p class="desc">${draft!.servers.length ? 'Select a server.' : 'Add a server to get started.'}</p></section>`;
  }
  const subs: [typeof sub, string][] = [
    ['connection', 'Connection'],
    ['mappings', 'Mappings'],
    ['excluded', 'Excluded Paths'],
  ];
  return html`<section class="detail">
    <h2><vscode-icon name=${s.type === 'local' ? 'folder-library' : 'server'}></vscode-icon> ${s.name}${draft!.defaultServer === s.name ? html`<span class="badge">default</span>` : nothing}</h2>
    <vscode-tabs
      .selectedIndex=${subs.findIndex(([k]) => k === sub)}
      @vsc-tabs-select=${(e: CustomEvent<{ selectedIndex: number }>) => {
        sub = subs[e.detail.selectedIndex][0];
        draw();
      }}
    >
      ${subs.map(([, label]) => html`<vscode-tab-header slot="header">${label}</vscode-tab-header><vscode-tab-panel></vscode-tab-panel>`)}
    </vscode-tabs>
    ${noticeBar()}
    <div class="page">${sub === 'connection' ? connectionPage(s) : sub === 'mappings' ? mappingsPage(s) : excludedPage(s)}</div>
  </section>`;
}

function noticeBar(): TemplateResult | typeof nothing {
  if (!notice) return nothing;
  const iconName = notice.kind === 'error' ? 'error' : notice.kind === 'ok' ? 'pass' : 'info';
  return html`<div class="notice ${notice.kind}"><vscode-icon name=${iconName} ?spin=${notice.text === 'Connecting…'}></vscode-icon><span>${notice.text}</span></div>`;
}

function showNotice(text: string, kind: 'info' | 'error' | 'ok'): void {
  notice = { text, kind };
  draw();
}

function footer(): TemplateResult {
  return html`<footer>
    <span class="dirty">${dirty ? 'Unsaved changes' : ''}</span>
    <vscode-button secondary @click=${() => post({ type: 'close' })}>Cancel</vscode-button>
    <vscode-button secondary ?disabled=${!dirty} @click=${() => post({ type: 'save', config: draft })}>Apply</vscode-button>
    <vscode-button @click=${() => {
      closeAfterSave = true;
      post({ type: 'save', config: draft });
    }}>OK</vscode-button>
  </footer>`;
}

function draw(): void {
  if (!draft) return;
  const tabs = ['servers', 'options'] as const;
  render(
    html`<header>
        <vscode-tabs
          .selectedIndex=${tabs.indexOf(tab)}
          @vsc-tabs-select=${(e: CustomEvent<{ selectedIndex: number }>) => {
            tab = tabs[e.detail.selectedIndex];
            draw();
          }}
        >
          <vscode-tab-header slot="header">Servers</vscode-tab-header><vscode-tab-panel></vscode-tab-panel>
          <vscode-tab-header slot="header">Options</vscode-tab-header><vscode-tab-panel></vscode-tab-panel>
        </vscode-tabs>
        <vscode-toolbar-button icon="json" label="Open deployment.json" @click=${() => post({ type: 'openJson' })}></vscode-toolbar-button>
      </header>
      <main class=${tab}>${tab === 'servers' ? html`${serverList()}${detail()}` : html`<section class="detail">${noticeBar()}${optionsPage()}</section>`}</main>
      ${footer()}`,
    document.getElementById('app')!,
  );
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
    case 'saved':
      draft = JSON.parse(JSON.stringify(m.config));
      saved = m.saved;
      root = m.root;
      dirty = false;
      if (sel && !sel.startsWith('#g:') && !draft!.servers.some((s) => s.name === sel)) sel = null;
      if (!sel && draft!.servers.length) sel = draft!.defaultServer && draft!.servers.some((s) => s.name === draft!.defaultServer) ? draft!.defaultServer : draft!.servers[0].name;
      if (m.type === 'saved') {
        notice = { text: 'Saved.', kind: 'ok' };
        if (closeAfterSave) post({ type: 'close' });
      }
      draw();
      break;
    case 'focus':
      tab = m.tab;
      if (m.select) sel = m.select;
      draw();
      break;
    case 'added':
      if (m.group) {
        const name = uniqueName(m.group.name);
        draft!.groups.push({ name, servers: [] });
        sel = '#g:' + name;
      } else {
        const s: Server = m.server;
        s.name = uniqueName(s.name);
        draft!.servers.push(s);
        sel = s.name;
        sub = 'connection';
      }
      tab = 'servers';
      markDirty();
      break;
    case 'error':
      closeAfterSave = false;
      showNotice(m.text, 'error');
      break;
    case 'testResult':
      showNotice(m.text, m.ok ? 'ok' : 'error');
      break;
    case 'set': {
      const s = current().server;
      if (s) {
        (s as unknown as Record<string, unknown>)[m.field] = m.value;
        notice = undefined;
        markDirty();
      }
      break;
    }
    case 'setMapping': {
      const s = current().server;
      if (s) {
        s.mappings[m.index][m.field as keyof Mapping] = m.value;
        markDirty();
      }
      break;
    }
    case 'addExcluded': {
      const s = current().server;
      if (s) {
        s.excludedPaths.push({ path: m.value, local: m.local });
        markDirty();
      }
      break;
    }
    case 'passwordSaved':
      saved[m.name] = !m.removed;
      showNotice(m.text, 'ok');
      break;
  }
});
post({ type: 'ready' });

export {};
