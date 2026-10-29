// Sync with Deployed webview: a directory diff (table on top) with the selected file's
// diff below (ide-diff, JetBrains-style on CodeMirror 6). Talks to SyncPanel through postMessage.
import { createDiffViewer, getIcon, type DiffViewerHost, type DiffViewerOptions, type IconName } from '@ide-diff/viewer';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { languageFor } from './languages';

type State = 'equal' | 'different' | 'localOnly' | 'remoteOnly' | 'conflict';
type Op = 'upload' | 'download' | 'deleteLocal' | 'deleteRemote' | 'skip' | 'none';
interface Row {
  id: number;
  rel: string;
  local?: { size: number; mtime: number };
  remote?: { size: number; mtime: number };
  state: State;
  newer?: 'local' | 'remote';
  op: Op;
}
interface Side {
  exists: boolean;
  text?: string;
  path: string;
}
interface DiffMsg {
  type: 'diff';
  id: number;
  rel: string;
  language: string;
  local: Side;
  remote: Side;
  binary?: boolean;
  tooLarge?: boolean;
  identicalBinary?: boolean;
}

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: unknown): void };
declare global {
  interface Window {
    __DEPLOY__: { server: string };
  }
}

const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const persisted = vscode.getState() || {};
const persist = (patch: Record<string, unknown>): void => vscode.setState({ ...(vscode.getState() || {}), ...patch });

// ------------------------------------------------------------------ table

let rows: Row[] = [];
let view: Row[] = [];
let ops: Record<number, Op> = {};
let selected = new Set<number>();
let cursor = -1;
let anchor = -1;
let busy = false;
const filters = new Set<string>(persisted.filters || ['localOnly', 'different', 'remoteOnly']);

function opsFor(r: Row): Op[] {
  switch (r.state) {
    case 'localOnly':
      return ['upload', 'deleteLocal', 'skip'];
    case 'remoteOnly':
      return ['download', 'deleteRemote', 'skip'];
    case 'different':
      return r.newer === 'remote' ? ['download', 'upload', 'skip'] : ['upload', 'download', 'skip'];
    case 'conflict':
      return ['skip', 'upload', 'download'];
    default:
      return ['none'];
  }
}
const opOf = (r: Row): Op => ops[r.id] || r.op;
const GLYPH: Partial<Record<Op, string>> = { upload: '→', download: '←', deleteLocal: '✕', deleteRemote: '✕', none: '=' };
const OP_TITLE: Record<Op, string> = {
  upload: 'Copy to server',
  download: 'Copy to local',
  deleteLocal: 'Delete local file',
  deleteRemote: 'Delete file on server',
  skip: 'Do nothing',
  none: 'Equal',
};
const glyph = (r: Row): string => {
  const o = opOf(r);
  return o === 'skip' ? (r.state === 'different' || r.state === 'conflict' ? '≠' : '') : (GLYPH[o] ?? '');
};
const fmt = new Intl.DateTimeFormat(undefined, { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const date = (t?: number): string => (t ? fmt.format(new Date(t)) : '');
const stateGroup = (s: State): string => (s === 'conflict' ? 'different' : s);

function visible(r: Row): boolean {
  if (!filters.has(stateGroup(r.state))) {
    return false;
  }
  const q = $<HTMLInputElement>('filter').value.trim();
  if (!q) {
    return true;
  }
  if (/[*?]/.test(q)) {
    const re = new RegExp('^' + q.replace(/[.+^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return re.test(r.rel.split('/').pop()!) || re.test(r.rel);
  }
  return r.rel.toLowerCase().includes(q.toLowerCase());
}

function nameCell(r: Row): string {
  const parts = r.rel.split('/');
  const base = parts.pop()!;
  const dir = parts.length ? `<span class="dir">${esc(parts.join('/'))}/</span>` : '';
  return `<i class="codicon codicon-file"></i><span>${dir}${esc(base)}</span>`;
}

function selectedRows(): Row[] {
  return rows.filter((r) => selected.has(r.id) && view.includes(r));
}

function render(keepScroll = true): void {
  const body = $('body');
  const top = body.scrollTop;
  view = rows.filter(visible);
  const html: string[] = [];
  view.forEach((r, i) => {
    const cls = ['row', 'st-' + r.state];
    if (selected.has(r.id)) cls.push('sel');
    if (i === cursor) cls.push('cursor');
    if (r.id === diffId) cls.push('shown');
    const o = opOf(r);
    html.push(
      `<div class="${cls.join(' ')}" data-i="${i}" title="${esc(r.rel)}">` +
        `<div class="name lname">${r.local ? nameCell(r) : ''}</div>` +
        `<div class="num">${r.local ? r.local.size : ''}</div>` +
        `<div class="date">${date(r.local?.mtime)}</div>` +
        `<div class="op op-${o}" data-op="${i}" title="${OP_TITLE[o]}">${glyph(r)}</div>` +
        `<div class="date">${date(r.remote?.mtime)}</div>` +
        `<div class="num">${r.remote ? r.remote.size : ''}</div>` +
        `<div class="name rname">${r.remote ? nameCell(r) : ''}</div></div>`,
    );
  });
  body.innerHTML = html.join('');
  if (keepScroll) body.scrollTop = top;
  const diff = rows.filter((r) => r.state !== 'equal').length;
  const hidden = rows.length - view.length;
  $('summary').textContent = rows.length ? `${diff} difference${diff === 1 ? '' : 's'}${hidden ? ` · ${hidden} hidden by filter` : ''}` : '';
  if (!busy) {
    $('status').textContent = !rows.length ? 'No differences.' : !view.length ? 'All items are hidden by the filter.' : '';
  }
  $<HTMLButtonElement>('syncSel').disabled = busy || !selectedRows().some((r) => !['none', 'skip'].includes(opOf(r)));
  $<HTMLButtonElement>('syncAll').disabled = busy || !view.some((r) => !['none', 'skip'].includes(opOf(r)));
  updateDiffNav();
}

let selectTimer: number | undefined;
function notifySelect(): void {
  window.clearTimeout(selectTimer);
  const r = view[cursor];
  if (!r || r.id === diffId) return;
  selectTimer = window.setTimeout(() => requestDiff(r.id), 120);
}

function setCursor(i: number, extend = false, toggle = false): void {
  if (!view.length) return;
  i = Math.max(0, Math.min(view.length - 1, i));
  if (extend && anchor >= 0) {
    selected = new Set(view.slice(Math.min(anchor, i), Math.max(anchor, i) + 1).map((r) => r.id));
  } else if (toggle) {
    const id = view[i].id;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchor = i;
  } else {
    selected = new Set([view[i].id]);
    anchor = i;
  }
  cursor = i;
  render();
  $('body').querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  notifySelect();
}

function cycle(list: Row[]): void {
  for (const r of list) {
    const options = opsFor(r);
    if (options.length < 2) continue;
    ops[r.id] = options[(options.indexOf(opOf(r)) + 1) % options.length];
  }
  render();
}

function perform(list: Row[]): void {
  const ids = list.filter((r) => !['none', 'skip'].includes(opOf(r))).map((r) => r.id);
  if (!ids.length || busy) return;
  flushEdits();
  vscode.postMessage({ type: 'perform', ids, ops });
}

const refresh = (): void => {
  flushEdits();
  vscode.postMessage({ type: 'refresh', compareBy: $<HTMLSelectElement>('compareBy').value });
};

$('body').addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;
  const rowEl = target.closest<HTMLElement>('.row');
  if (!rowEl) return;
  const i = Number(rowEl.dataset.i);
  const opCell = target.closest('[data-op]');
  if (opCell && selected.has(view[i].id) && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
    cycle(selectedRows());
    return;
  }
  setCursor(i, e.shiftKey, e.metaKey || e.ctrlKey);
  if (opCell) cycle([view[i]]);
});
$('body').addEventListener('dblclick', (e) => {
  const target = e.target as HTMLElement;
  const rowEl = target.closest<HTMLElement>('.row');
  if (rowEl && !target.closest('[data-op]')) vscode.postMessage({ type: 'open', id: view[Number(rowEl.dataset.i)].id });
});
$('table').addEventListener('keydown', (e) => {
  const page = Math.max(1, Math.floor($('body').clientHeight / 22) - 1);
  const k = e.key;
  const mod = e.metaKey || e.ctrlKey;
  if (k === 'ArrowDown') setCursor(cursor + 1, e.shiftKey);
  else if (k === 'ArrowUp') setCursor(cursor - 1, e.shiftKey);
  else if (k === 'PageDown') setCursor(cursor + page, e.shiftKey);
  else if (k === 'PageUp') setCursor(cursor - page, e.shiftKey);
  else if (k === 'Home') setCursor(0, e.shiftKey);
  else if (k === 'End') setCursor(view.length - 1, e.shiftKey);
  else if (k === ' ') cycle(selectedRows());
  else if (k === 'Enter') perform(selectedRows());
  else if (k === 'F7') e.shiftKey ? viewer?.goToPreviousChange() : viewer?.goToNextChange();
  else if (k === 'F4') view[cursor] && vscode.postMessage({ type: 'open', id: view[cursor].id });
  else if (mod && k.toLowerCase() === 'a') {
    selected = new Set(view.map((r) => r.id));
    render();
  } else if (mod && k.toLowerCase() === 'r') refresh();
  else return;
  e.preventDefault();
});
document.querySelectorAll<HTMLElement>('[data-f]').forEach((b) => {
  b.classList.toggle('on', filters.has(b.dataset.f!));
  b.onclick = () => {
    const f = b.dataset.f!;
    if (filters.has(f)) filters.delete(f);
    else filters.add(f);
    b.classList.toggle('on', filters.has(f));
    persist({ filters: [...filters] });
    cursor = view.findIndex((r) => r.id === diffId);
    render();
    cursor = view.findIndex((r) => r.id === diffId);
    render();
  };
});
$('filter').addEventListener('input', () => {
  render(false);
  cursor = view.findIndex((r) => r.id === diffId);
  render(false);
});
$('filter').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    $('table').focus();
    setCursor(0);
    e.preventDefault();
  }
});
$('refresh').onclick = refresh;
$('compareBy').onchange = refresh;
$('syncSel').onclick = () => perform(selectedRows());
$('syncAll').onclick = () => perform(view);
$('chooseLocal').onclick = () => vscode.postMessage({ type: 'chooseLocal' });
$('chooseRemote').onclick = () => vscode.postMessage({ type: 'chooseRemote' });

// ------------------------------------------------------------------ splitter

const main = $('main');
let split = typeof persisted.split === 'number' ? persisted.split : 0.4;
function applySplit(): void {
  main.style.setProperty('--top', `${Math.round(split * 1000) / 10}%`);
  viewer?.layout();
}
applySplit();
$('splitter').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const rect = main.getBoundingClientRect();
  const move = (ev: MouseEvent): void => {
    split = Math.min(0.85, Math.max(0.12, (ev.clientY - rect.top) / rect.height));
    applySplit();
  };
  const up = (): void => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    persist({ split });
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ------------------------------------------------------------------ diff viewer

type Impl = ReturnType<DiffViewerHost['getImplementation']>;
type Settings = ReturnType<Impl['exportOptions']>;
type Appearance = Pick<Settings, 'showWhitespaces' | 'showLineNumbers' | 'softWraps'>;

let viewer: DiffViewerHost | undefined;
let diffId = -1;
let current: DiffMsg | undefined;
let savedLocal = '';
let savedRemote = '';
let dirty = { local: false, remote: false };
let remoteLocked = true;
// The viewer is re-created for every file (so undo never crosses files); its settings carry over.
let settings: Partial<DiffViewerOptions> = persisted.viewer || {};
let appearance: Appearance | undefined = persisted.appearance;

const theme = (): 'dark' | 'light' => (/\bvscode-(light|high-contrast-light)\b/.test(document.body.className) ? 'light' : 'dark');
new MutationObserver(() => viewer?.setOptions({ theme: theme() })).observe(document.body, { attributes: true, attributeFilter: ['class'] });

function saveSettings(): void {
  if (!viewer) return;
  const o = viewer.getImplementation().exportOptions();
  settings = { mode: o.mode, ignorePolicy: o.ignorePolicy, highlightPolicy: o.highlightPolicy, collapseUnchanged: o.collapseUnchanged, syncScroll: o.syncScroll };
  appearance = { showWhitespaces: o.showWhitespaces, showLineNumbers: o.showLineNumbers, softWraps: o.softWraps };
  remoteLocked = o.readOnly[1];
  persist({ viewer: settings, appearance });
}

function disposeViewer(): void {
  if (!viewer) return;
  saveSettings();
  viewer.dispose();
  viewer = undefined;
}

function showMessage(text: string): void {
  disposeViewer();
  $('diffMessage').textContent = text;
  $('diffMessage').hidden = false;
}

function titles(): Pick<DiffViewerOptions, 'originalTitle' | 'modifiedTitle'> {
  const m = current!;
  return {
    originalTitle: (m.local.exists ? m.local.path : `${m.local.path} (does not exist)`) + (dirty.local ? '  ● modified' : ''),
    modifiedTitle:
      `${window.__DEPLOY__.server}:${m.remote.path}${m.remote.exists ? '' : ' (does not exist)'}` + (dirty.remote ? '  ● modified — Ctrl+S to upload' : ''),
  };
}

function updateDirty(): void {
  if (!viewer || !current) return;
  const next = { local: viewer.getOriginal() !== savedLocal, remote: viewer.getModified() !== savedRemote };
  if (next.local === dirty.local && next.remote === dirty.remote) return;
  dirty = next;
  viewer.setOptions(titles());
}

function save(side: 'local' | 'remote'): void {
  if (!current || !viewer) return;
  if (side === 'local') {
    const text = viewer.getOriginal();
    if (text === savedLocal && current.local.exists) return;
    savedLocal = text;
    vscode.postMessage({ type: 'saveLocal', id: current.id, text });
  } else {
    const text = viewer.getModified();
    if (text === savedRemote && current.remote.exists) return;
    savedRemote = text;
    vscode.postMessage({ type: 'saveRemote', id: current.id, text });
  }
  updateDirty();
}

/** Ctrl+S: saves the focused side; the unified viewer has one editor for both, so it saves whatever changed. */
const saveKey = Prec.highest(
  keymap.of([
    {
      key: 'Mod-s',
      run: (view: EditorView) => {
        const impl = viewer?.getImplementation();
        const editors = impl && 'getEditors' in impl ? impl.getEditors() : undefined;
        if (editors) save(editors[0] === view ? 'local' : 'remote');
        else {
          if (dirty.local) save('local');
          if (dirty.remote) save('remote');
        }
        return true;
      },
    },
  ]),
);

// Gutter >> / << arrows: apply and save at once. The viewer applies synchronously in the click handler.
$('diff').addEventListener(
  'click',
  (e) => {
    if (!viewer || !(e.target as HTMLElement).closest('.idd-gutter-op')) return;
    const before = [viewer.getOriginal(), viewer.getModified()];
    window.setTimeout(() => {
      if (viewer?.getOriginal() !== before[0]) save('local');
      if (viewer?.getModified() !== before[1]) save('remote');
    });
  },
  true,
);

/** Before switching files: local edits are saved (autosave), remote edits need confirmation. */
function flushEdits(): void {
  if (!current || !viewer) return;
  if (viewer.getOriginal() !== savedLocal) {
    save('local');
  }
  const remote = viewer.getModified();
  if (remote !== savedRemote) {
    vscode.postMessage({ type: 'confirmRemote', id: current.id, text: remote });
    savedRemote = remote;
  }
}

function requestDiff(id: number): void {
  flushEdits();
  diffId = id;
  render();
  $('diffMessage').textContent = 'Loading…';
  $('diffMessage').hidden = false;
  vscode.postMessage({ type: 'select', id });
}

function toolButton(id: string, icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'idd-btn';
  button.id = id;
  button.title = title;
  button.setAttribute('aria-label', title);
  const i = document.createElement('span');
  i.className = 'idd-icon';
  i.dataset.icon = icon;
  i.innerHTML = getIcon(icon, theme());
  button.appendChild(i);
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', () => !button.disabled && onClick());
  return button;
}

/** Adds Edit Source and previous/next file after the viewer's previous/next difference buttons. */
function addToolbarButtons(): void {
  const next = $('diff').querySelector('.idd-toolbar-left')?.children[1];
  if (!next || document.getElementById('editSource')) return;
  const sep = (): HTMLElement => Object.assign(document.createElement('span'), { className: 'idd-sep' });
  next.after(
    sep(),
    toolButton('editSource', 'generalEdit', 'Edit Source (F4)', () => diffId >= 0 && vscode.postMessage({ type: 'open', id: diffId })),
    sep(),
    toolButton('prevFile', 'generalLeft', 'Compare Previous File', () => moveFile(-1)),
    toolButton('nextFile', 'generalRight', 'Compare Next File', () => moveFile(1)),
  );
  updateDiffNav();
}

function revealFirstChange(): void {
  const impl = viewer?.getImplementation();
  const first = viewer?.getChanges()[0];
  if (!impl || !first || !('getEditors' in impl)) return;
  const ed = impl.getEditors()[1];
  const pos = ed.state.doc.line(Math.min(first.startLine2 + 1, ed.state.doc.lines)).from;
  ed.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
}

function showDiff(m: DiffMsg): void {
  if (m.id !== diffId) return;
  current = m;
  const message = m.tooLarge ? 'File is too large to compare here.' : m.binary ? (m.identicalBinary ? 'Binary files are identical.' : 'Binary files differ.') : '';
  if (message) {
    showMessage(message);
    return;
  }
  $('diffMessage').hidden = true;
  disposeViewer();
  savedLocal = m.local.text ?? '';
  savedRemote = m.remote.text ?? '';
  dirty = { local: false, remote: false };
  viewer = createDiffViewer($('diff'), {
    ...settings,
    ...titles(),
    original: savedLocal,
    modified: savedRemote,
    language: languageFor(m.language),
    theme: theme(),
    readOnly: { original: false, modified: remoteLocked },
    extensions: [saveKey],
  });
  if (appearance) (viewer.getImplementation() as unknown as { setAppearance(a: Appearance): void }).setAppearance(appearance);
  viewer.onDidUpdateDiff(updateDirty);
  viewer.onDidChangeMode(addToolbarButtons);
  addToolbarButtons();
  revealFirstChange();
}

function moveFile(delta: number): void {
  const idx = view.findIndex((r) => r.id === diffId);
  let i = idx;
  for (;;) {
    i += delta;
    if (i < 0 || i >= view.length) return;
    if (view[i].state !== 'equal' || filters.has('equal')) break;
  }
  setCursor(i);
}

function updateDiffNav(): void {
  const idx = view.findIndex((r) => r.id === diffId);
  const prev = document.getElementById('prevFile') as HTMLButtonElement | null;
  const next = document.getElementById('nextFile') as HTMLButtonElement | null;
  if (prev) prev.disabled = idx <= 0;
  if (next) next.disabled = idx < 0 || idx >= view.length - 1;
}
window.addEventListener('beforeunload', saveSettings);

// ------------------------------------------------------------------ messages

window.addEventListener('message', (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'header':
      $('localPath').textContent = '‎' + m.local + '‎';
      $('localPath').title = m.local;
      $('remotePath').textContent = '‎' + m.server + ':' + m.remote + '‎';
      $('remotePath').title = m.server + ':' + m.remote;
      $<HTMLSelectElement>('compareBy').value = m.compareBy;
      break;
    case 'busy':
      busy = true;
      render();
      $('status').textContent = m.text;
      break;
    case 'error':
      busy = false;
      render();
      $('status').innerHTML = `<span class="error">${esc(m.text)}</span>`;
      break;
    case 'rows': {
      const prevRel = new Set(rows.filter((r) => selected.has(r.id)).map((r) => r.rel));
      const shownRel = rows.find((r) => r.id === diffId)?.rel;
      rows = m.rows;
      ops = {};
      busy = false;
      selected = new Set(rows.filter((r) => prevRel.has(r.rel)).map((r) => r.id));
      render();
      cursor = shownRel ? view.findIndex((r) => r.rel === shownRel) : -1;
      if (cursor < 0 && view.length) {
        cursor = 0;
        selected = new Set([view[0].id]);
        anchor = 0;
      }
      diffId = -1;
      render();
      if (cursor >= 0) {
        requestDiff(view[cursor].id);
      } else {
        current = undefined;
        showMessage('Select a file to compare.');
      }
      $('table').focus();
      break;
    }
    case 'rowUpdate': {
      const i = rows.findIndex((r) => r.id === m.row.id);
      if (i >= 0) {
        rows[i] = m.row;
        delete ops[m.row.id];
        render();
      }
      break;
    }
    case 'diff':
      showDiff(m as DiffMsg);
      break;
    case 'savedRemote':
      if (current && m.id === current.id) {
        current.remote.exists = true;
      }
      break;
    case 'savedLocal':
      if (current && m.id === current.id) {
        current.local.exists = true;
      }
      break;
  }
});
vscode.postMessage({ type: 'ready' });

export {};
