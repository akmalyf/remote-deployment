// CodeMirror language support for the diff viewer, keyed by the ids SyncPanel's languageOf() sends.
import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { php } from '@codemirror/lang-php';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { sass } from '@codemirror/lang-sass';
import { less } from '@codemirror/lang-less';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { sql, MySQL } from '@codemirror/lang-sql';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { kotlin, csharp } from '@codemirror/legacy-modes/mode/clike';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { pug } from '@codemirror/legacy-modes/mode/pug';

const LANGUAGES: Record<string, () => Extension> = {
  php: () => php(),
  javascript: () => javascript({ jsx: true }),
  typescript: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  html: () => html(),
  twig: () => html(),
  handlebars: () => html(),
  css: () => css(),
  scss: () => sass(),
  less: () => less(),
  xml: () => xml(),
  yaml: () => yaml(),
  markdown: () => markdown(),
  python: () => python(),
  sql: () => sql(),
  mysql: () => sql({ dialect: MySQL }),
  go: () => go(),
  java: () => java(),
  rust: () => rust(),
  cpp: () => cpp(),
  shell: () => StreamLanguage.define(shell),
  ini: () => StreamLanguage.define(properties),
  dockerfile: () => StreamLanguage.define(dockerFile),
  ruby: () => StreamLanguage.define(ruby),
  swift: () => StreamLanguage.define(swift),
  kotlin: () => StreamLanguage.define(kotlin),
  csharp: () => StreamLanguage.define(csharp),
  powershell: () => StreamLanguage.define(powerShell),
  pug: () => StreamLanguage.define(pug),
};

const cache = new Map<string, Extension>();

/** Language support for a language id; undefined for plain text. Cached so the viewer keeps one instance per language. */
export function languageFor(id: string): Extension | undefined {
  const make = LANGUAGES[id];
  if (!make) return undefined;
  let ext = cache.get(id);
  if (!ext) cache.set(id, (ext = make()));
  return ext;
}
