// Sync with Deployed webview: a directory diff (table on top) with the selected file's
// diff below (Monaco). Talks to SyncPanel through postMessage.
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js';
import 'monaco-editor/languages/definitions/php/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/scss/register.js';
import 'monaco-editor/languages/definitions/less/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import 'monaco-editor/languages/definitions/mysql/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';
import 'monaco-editor/languages/definitions/dockerfile/register.js';
import 'monaco-editor/languages/definitions/twig/register.js';
import 'monaco-editor/languages/definitions/go/register.js';
import 'monaco-editor/languages/definitions/java/register.js';
import 'monaco-editor/languages/definitions/ruby/register.js';
import 'monaco-editor/languages/definitions/rust/register.js';
import 'monaco-editor/languages/definitions/csharp/register.js';
import 'monaco-editor/languages/definitions/cpp/register.js';
import 'monaco-editor/languages/definitions/kotlin/register.js';
import 'monaco-editor/languages/definitions/swift/register.js';
import 'monaco-editor/languages/definitions/handlebars/register.js';
import 'monaco-editor/languages/definitions/pug/register.js';
import 'monaco-editor/languages/definitions/graphql/register.js';
import 'monaco-editor/languages/definitions/powershell/register.js';
import 'monaco-editor/languages/definitions/bat/register.js';

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
    __DEPLOY__: { workerUrl: string; server: string };
  }
}

const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const persisted = vscode.getState() || {};
const persist = (patch: Record<string, unknown>): void => vscode.setState({ ...(vscode.getState() || {}), ...patch });

// ------------------------------------------------------------------ monaco worker

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  // Webview resources are cross-origin for workers: load the script text into a blob worker.
  getWorker: async () => {
    const code = await (await fetch(window.__DEPLOY__.workerUrl)).text();
    return new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  },
};

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
  else if (k === 'F7') diffEditor?.goToDiff(e.shiftKey ? 'previous' : 'next');
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
  diffEditor?.layout();
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

// ------------------------------------------------------------------ theme

function toHex(color: string): string | undefined {
  if (!color) return undefined;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fillStyle = '#00000000';
  ctx.fillStyle = color.trim();
  const v = ctx.fillStyle;
  if (v.startsWith('#')) return v;
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return undefined;
  const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim());
  const h = (n: number): string => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(+r)}${h(+g)}${h(+b)}${Number(a) < 1 ? h(Number(a) * 255) : ''}`;
}

function defineTheme(): void {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string): string | undefined => toHex(css.getPropertyValue(`--vscode-${name}`));
  const cls = document.body.classList;
  const base: monaco.editor.BuiltinTheme = cls.contains('vscode-high-contrast') ? 'hc-black' : cls.contains('vscode-light') ? 'vs' : 'vs-dark';
  const map: Record<string, string> = {
    'editor.background': 'editor-background',
    'editor.foreground': 'editor-foreground',
    'editorLineNumber.foreground': 'editorLineNumber-foreground',
    'editorLineNumber.activeForeground': 'editorLineNumber-activeForeground',
    'editor.selectionBackground': 'editor-selectionBackground',
    'editor.inactiveSelectionBackground': 'editor-inactiveSelectionBackground',
    'editor.lineHighlightBackground': 'editor-lineHighlightBackground',
    'editor.lineHighlightBorder': 'editor-lineHighlightBorder',
    'editorCursor.foreground': 'editorCursor-foreground',
    'editorWhitespace.foreground': 'editorWhitespace-foreground',
    'editorIndentGuide.background1': 'editorIndentGuide-background1',
    'editorGutter.background': 'editorGutter-background',
    'editorWidget.background': 'editorWidget-background',
    'editorWidget.border': 'editorWidget-border',
    'input.background': 'input-background',
    'input.foreground': 'input-foreground',
    'focusBorder': 'focusBorder',
    'scrollbarSlider.background': 'scrollbarSlider-background',
    'scrollbarSlider.hoverBackground': 'scrollbarSlider-hoverBackground',
    'scrollbarSlider.activeBackground': 'scrollbarSlider-activeBackground',
    'diffEditor.insertedTextBackground': 'diffEditor-insertedTextBackground',
    'diffEditor.removedTextBackground': 'diffEditor-removedTextBackground',
    'diffEditor.insertedLineBackground': 'diffEditor-insertedLineBackground',
    'diffEditor.removedLineBackground': 'diffEditor-removedLineBackground',
    'diffEditor.diagonalFill': 'diffEditor-diagonalFill',
    'diffEditor.border': 'diffEditor-border',
    'diffEditorGutter.insertedLineBackground': 'diffEditorGutter-insertedLineBackground',
    'diffEditorGutter.removedLineBackground': 'diffEditorGutter-removedLineBackground',
    'diffEditor.unchangedRegionBackground': 'diffEditor-unchangedRegionBackground',
    'diffEditor.unchangedRegionForeground': 'diffEditor-unchangedRegionForeground',
    'editorBracketMatch.background': 'editorBracketMatch-background',
    'editorBracketMatch.border': 'editorBracketMatch-border',
    'editor.findMatchBackground': 'editor-findMatchBackground',
    'editor.findMatchHighlightBackground': 'editor-findMatchHighlightBackground',
    'editor.wordHighlightBackground': 'editor-wordHighlightBackground',
  };
  const colors: Record<string, string> = {};
  for (const [k, cssName] of Object.entries(map)) {
    const c = v(cssName);
    if (c) colors[k] = c;
  }
  monaco.editor.defineTheme('vscode', { base, inherit: true, rules: [], colors });
  monaco.editor.setTheme('vscode');
}

// ------------------------------------------------------------------ diff editor

let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
let diffId = -1;
let current: DiffMsg | undefined;
let localModel: monaco.editor.ITextModel | undefined;
let remoteModel: monaco.editor.ITextModel | undefined;
let savedLocal = '';
let savedRemote = '';
let remoteLocked = true;
let sideBySide = persisted.sideBySide !== false;
let collapse = !!persisted.collapse;
let ignoreWs = !!persisted.ignoreWs;
let wordWrap = !!persisted.wordWrap;
let glyphs: { local?: monaco.editor.IEditorDecorationsCollection; remote?: monaco.editor.IEditorDecorationsCollection } = {};

function fontOptions(): monaco.editor.IEditorOptions {
  const css = getComputedStyle(document.documentElement);
  return {
    fontFamily: css.getPropertyValue('--vscode-editor-font-family').trim() || undefined,
    fontSize: parseInt(css.getPropertyValue('--vscode-editor-font-size'), 10) || 13,
  };
}

function ensureEditor(): monaco.editor.IStandaloneDiffEditor {
  if (diffEditor) return diffEditor;
  defineTheme();
  new MutationObserver(defineTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  diffEditor = monaco.editor.createDiffEditor($('diff'), {
    theme: 'vscode',
    automaticLayout: true,
    originalEditable: true,
    readOnly: remoteLocked,
    renderSideBySide: sideBySide,
    useInlineViewWhenSpaceIsLimited: false,
    ignoreTrimWhitespace: ignoreWs,
    renderMarginRevertIcon: false,
    // Copy arrows live in the line decorations column (between numbers and code), which has room
    // around them; the +/- indicators would share that column, and folding is replaced by collapse.
    renderIndicators: false,
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 26,
    enableSplitViewResizing: true,
    hideUnchangedRegions: { enabled: collapse },
    wordWrap: wordWrap ? 'on' : 'off',
    diffWordWrap: wordWrap ? 'on' : 'off',
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    renderOverviewRuler: true,
    ...fontOptions(),
  });
  const original = diffEditor.getOriginalEditor();
  const modified = diffEditor.getModifiedEditor();
  original.updateOptions({ readOnly: false });
  diffEditor.onDidUpdateDiff(() => {
    updateCount();
    updateGlyphs();
  });
  for (const [ed, side] of [
    [original, 'local'],
    [modified, 'remote'],
  ] as const) {
    ed.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS && e.target.position) {
        applyAt(side, e.target.position.lineNumber);
      }
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save(side));
    ed.addCommand(monaco.KeyCode.F7, () => diffEditor!.goToDiff('next'));
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => diffEditor!.goToDiff('previous'));
    ed.onDidChangeModelContent(() => updateDirty());
  }
  return diffEditor;
}

function lineChanges(): monaco.editor.ILineChange[] {
  return diffEditor?.getLineChanges() ?? [];
}

function updateCount(): void {
  const n = lineChanges().length;
  $('diffCount').textContent = current && !current.binary && !current.tooLarge ? (n ? `${n} difference${n === 1 ? '' : 's'}` : 'Contents are identical') : '';
}

/** Gutter arrows: « on the remote side copies the block to local; » on the local side pushes it to the server (unlocked only). */
function updateGlyphs(): void {
  if (!diffEditor) return;
  const changes = lineChanges();
  const localDecos: monaco.editor.IModelDeltaDecoration[] = [];
  const remoteDecos: monaco.editor.IModelDeltaDecoration[] = [];
  const both = current?.local.exists && current?.remote.exists;
  for (const c of changes) {
    const remoteLine = Math.max(1, c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber || 1 : c.modifiedStartLineNumber);
    const localLine = Math.max(1, c.originalEndLineNumber === 0 ? c.originalStartLineNumber || 1 : c.originalStartLineNumber);
    if (both) {
      remoteDecos.push({ range: new monaco.Range(remoteLine, 1, remoteLine, 1), options: { linesDecorationsClassName: 'arrow-accept', linesDecorationsTooltip: 'Copy this change to the local file' } });
      if (!remoteLocked) {
        localDecos.push({ range: new monaco.Range(localLine, 1, localLine, 1), options: { linesDecorationsClassName: 'arrow-push', linesDecorationsTooltip: 'Copy this change to the server' } });
      }
    }
  }
  glyphs.local?.clear();
  glyphs.remote?.clear();
  glyphs = {
    local: diffEditor.getOriginalEditor().createDecorationsCollection(localDecos),
    remote: diffEditor.getModifiedEditor().createDecorationsCollection(remoteDecos),
  };
}

function linesText(model: monaco.editor.ITextModel, start: number, end: number): string {
  return model.getValueInRange(new monaco.Range(start, 1, end, model.getLineMaxColumn(end)));
}

/** Replace the target block of a line change with the source block. */
function applyChange(c: monaco.editor.ILineChange, toLocal: boolean): void {
  if (!localModel || !remoteModel) return;
  const from = toLocal ? remoteModel : localModel;
  const to = toLocal ? localModel : remoteModel;
  const fromStart = toLocal ? c.modifiedStartLineNumber : c.originalStartLineNumber;
  const fromEnd = toLocal ? c.modifiedEndLineNumber : c.originalEndLineNumber;
  const toStart = toLocal ? c.originalStartLineNumber : c.modifiedStartLineNumber;
  const toEnd = toLocal ? c.originalEndLineNumber : c.modifiedEndLineNumber;
  let range: monaco.Range;
  let text: string;
  if (fromEnd === 0) {
    // The source has no lines here: delete the target block including its line break.
    if (toEnd < to.getLineCount()) {
      range = new monaco.Range(toStart, 1, toEnd + 1, 1);
    } else if (toStart > 1) {
      range = new monaco.Range(toStart - 1, to.getLineMaxColumn(toStart - 1), toEnd, to.getLineMaxColumn(toEnd));
    } else {
      range = new monaco.Range(1, 1, toEnd, to.getLineMaxColumn(toEnd));
    }
    text = '';
  } else {
    const block = linesText(from, fromStart, fromEnd);
    if (toEnd === 0) {
      // Insert after line toStart.
      if (toStart === 0) {
        range = new monaco.Range(1, 1, 1, 1);
        text = block + to.getEOL();
      } else {
        const col = to.getLineMaxColumn(toStart);
        range = new monaco.Range(toStart, col, toStart, col);
        text = to.getEOL() + block;
      }
    } else {
      range = new monaco.Range(toStart, 1, toEnd, to.getLineMaxColumn(toEnd));
      text = block;
    }
  }
  to.pushEditOperations([], [{ range, text, forceMoveMarkers: true }], () => null);
  to.pushStackElement();
}

function applyAt(side: 'local' | 'remote', line: number): void {
  const toLocal = side === 'remote';
  if (!toLocal && remoteLocked) return;
  const c = lineChanges().find((ch) => {
    const start = toLocal ? ch.modifiedStartLineNumber : ch.originalStartLineNumber;
    const end = toLocal ? ch.modifiedEndLineNumber : ch.originalEndLineNumber;
    const glyphLine = Math.max(1, end === 0 ? start || 1 : start);
    return glyphLine === line;
  });
  if (!c) return;
  applyChange(c, toLocal);
  // Apply and save at once.
  save(toLocal ? 'local' : 'remote');
}

function updateDirty(): void {
  const localDirty = !!localModel && localModel.getValue() !== savedLocal;
  const remoteDirty = !!remoteModel && remoteModel.getValue() !== savedRemote;
  $('localDirty').textContent = localDirty ? '● modified' : '';
  $('remoteDirty').textContent = remoteDirty ? '● modified — Ctrl+S to upload' : '';
}

function save(side: 'local' | 'remote'): void {
  if (!current) return;
  if (side === 'local' && localModel) {
    const text = localModel.getValue();
    if (text === savedLocal && current.local.exists) return;
    savedLocal = text;
    vscode.postMessage({ type: 'saveLocal', id: current.id, text });
  } else if (side === 'remote' && remoteModel) {
    const text = remoteModel.getValue();
    if (text === savedRemote && current.remote.exists) return;
    savedRemote = text;
    vscode.postMessage({ type: 'saveRemote', id: current.id, text });
  }
  updateDirty();
}

/** Before switching files: local edits are saved (autosave), remote edits need confirmation. */
function flushEdits(): void {
  if (!current) return;
  if (localModel && localModel.getValue() !== savedLocal) {
    save('local');
  }
  if (remoteModel && remoteModel.getValue() !== savedRemote) {
    vscode.postMessage({ type: 'confirmRemote', id: current.id, text: remoteModel.getValue() });
    savedRemote = remoteModel.getValue();
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

function showDiff(m: DiffMsg): void {
  if (m.id !== diffId) return;
  current = m;
  $('localTitle').textContent = '‎' + (m.local.exists ? m.local.path : `${m.local.path} (does not exist)`) + '‎';
  $('localTitle').title = m.local.path;
  $('remoteTitle').textContent = '‎' + `${window.__DEPLOY__.server}:${m.remote.path}${m.remote.exists ? '' : ' (does not exist)'}` + '‎';
  $('remoteTitle').title = m.remote.path;
  const message = m.tooLarge ? 'File is too large to compare here.' : m.binary ? (m.identicalBinary ? 'Binary files are identical.' : 'Binary files differ.') : '';
  $('diffMessage').textContent = message;
  $('diffMessage').hidden = !message;
  $('diff').style.visibility = message ? 'hidden' : 'visible';
  if (message) {
    updateCount();
    return;
  }
  const ed = ensureEditor();
  const oldLocal = localModel;
  const oldRemote = remoteModel;
  const lang = monaco.languages.getLanguages().some((l) => l.id === m.language) ? m.language : 'plaintext';
  localModel = monaco.editor.createModel(m.local.text ?? '', lang);
  remoteModel = monaco.editor.createModel(m.remote.text ?? '', lang);
  savedLocal = m.local.text ?? '';
  savedRemote = m.remote.text ?? '';
  ed.setModel({ original: localModel, modified: remoteModel });
  oldLocal?.dispose();
  oldRemote?.dispose();
  setLocked(remoteLocked);
  updateDirty();
  updateDiffNav();
  // Jump to the first change.
  const once = ed.onDidUpdateDiff(() => {
    once.dispose();
    const first = lineChanges()[0];
    if (first) {
      ed.getModifiedEditor().revealLineInCenterIfOutsideViewport(Math.max(1, first.modifiedStartLineNumber));
      ed.getOriginalEditor().revealLineInCenterIfOutsideViewport(Math.max(1, first.originalStartLineNumber));
    }
  });
}

function setLocked(locked: boolean): void {
  remoteLocked = locked;
  diffEditor?.getModifiedEditor().updateOptions({ readOnly: locked, readOnlyMessage: { value: 'The deployed file is read-only. Click the lock icon to edit it.' } });
  $('lock').innerHTML = `<i class="codicon codicon-${locked ? 'lock' : 'unlock'}"></i>`;
  $('lock').title = locked ? 'Deployed file is read-only — click to allow editing' : 'Deployed file is editable — click to lock';
  $('lock').classList.toggle('on', !locked);
  updateGlyphs();
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
  ($('prevFile') as HTMLButtonElement).disabled = idx <= 0;
  ($('nextFile') as HTMLButtonElement).disabled = idx < 0 || idx >= view.length - 1;
}

function setToggle(id: string, on: boolean): void {
  $(id).classList.toggle('on', on);
}

$('prevDiff').onclick = () => diffEditor?.goToDiff('previous');
$('nextDiff').onclick = () => diffEditor?.goToDiff('next');
$('editSource').onclick = () => diffId >= 0 && vscode.postMessage({ type: 'open', id: diffId });
$('prevFile').onclick = () => moveFile(-1);
$('nextFile').onclick = () => moveFile(1);
$('lock').onclick = () => setLocked(!remoteLocked);
$('collapse').onclick = () => {
  collapse = !collapse;
  persist({ collapse });
  setToggle('collapse', collapse);
  diffEditor?.updateOptions({ hideUnchangedRegions: { enabled: collapse } });
};
const setMode = (sbs: boolean): void => {
  sideBySide = sbs;
  persist({ sideBySide });
  setToggle('sideBySide', sbs);
  setToggle('unified', !sbs);
  diffEditor?.updateOptions({ renderSideBySide: sbs });
  document.body.classList.toggle('unified', !sbs);
};
$('sideBySide').onclick = () => setMode(true);
$('unified').onclick = () => setMode(false);
$('settings').onclick = (e) => {
  e.stopPropagation();
  $('settingsMenu').hidden = !$('settingsMenu').hidden;
};
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#settingsMenu')) $('settingsMenu').hidden = true;
});
($('optIgnoreWs') as HTMLInputElement).checked = ignoreWs;
($('optWrap') as HTMLInputElement).checked = wordWrap;
$('optIgnoreWs').onchange = (e) => {
  ignoreWs = (e.target as HTMLInputElement).checked;
  persist({ ignoreWs });
  diffEditor?.updateOptions({ ignoreTrimWhitespace: ignoreWs });
};
$('optWrap').onchange = (e) => {
  wordWrap = (e.target as HTMLInputElement).checked;
  persist({ wordWrap });
  diffEditor?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off', diffWordWrap: wordWrap ? 'on' : 'off' });
};
setToggle('collapse', collapse);
setMode(sideBySide);

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
        $('diffMessage').textContent = 'Select a file to compare.';
        $('diffMessage').hidden = false;
        $('diff').style.visibility = 'hidden';
        updateCount();
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
