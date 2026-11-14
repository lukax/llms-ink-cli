// What the code uses from each package: imports per language (JS/TS, Python, Rust, Go) and the names it reaches through them.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const EXTENSIONS = {
  npm: /\.(?:[cm]?[jt]sx?|astro|vue|svelte)$/i,
  pypi: /\.pyi?$/i,
  crates: /\.rs$/i,
  go: /\.go$/i,
};
/** A folder with one of these is its own project of that ecosystem: not scanned for the outer manifest (unless it's a workspace). */
const PROJECT_FILES = { npm: ['package.json'], pypi: ['pyproject.toml', 'setup.py', 'setup.cfg'], crates: ['Cargo.toml'], go: ['go.mod'] };
const SKIP_DIRS = new Set(['node_modules', 'bower_components', 'dist', 'build', 'out', 'target', 'vendor', 'venv', 'env', '__pycache__', 'site-packages', 'coverage', 'third_party']);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1_000_000;

/** Source files of `ecosystem` under `root`, sorted: hidden and build folders skipped, `skip` (absolute paths) too. */
export async function sourceFiles(root, ecosystem, { workspace = false, skip = [] } = {}) {
  const files = [];
  const walk = async (dir, top) => {
    if (files.length >= MAX_FILES || skip.includes(dir)) return;
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!top && !workspace && entries.some((e) => e.isFile() && PROJECT_FILES[ecosystem].includes(e.name))) return;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path, false); }
      else if (e.isFile() && EXTENSIONS[ecosystem].test(e.name) && files.length < MAX_FILES) files.push(path);
    }
  };
  await walk(root, true);
  return files;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** Members too generic to say anything about an API. */
const STOP = new Set(['default', 'prototype', 'constructor', 'length', 'then', 'catch', 'call', 'apply', 'bind', 'toString', 'self', 'super', 'crate', 'as', 'Self']);

/** Per file: `Map<importKey, Set<symbol>>` (importKey: npm package, Python top-level module, Rust crate ident, Go import path). */
function addTo(found, key, symbol) {
  if (!found.has(key)) found.set(key, new Set());
  if (symbol && !STOP.has(symbol.split('.').at(-1))) found.get(key).add(symbol);
}

/** Code with string literals emptied, so `'scripts/build.ts'` doesn't read as a use of `build.ts`. */
const blankStrings = (code) => code.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');

/** `name.member` uses of a local binding (in code passed through blankStrings). */
function members(text, local, re = /[A-Za-z_$][\w$]*/) {
  const out = new Set();
  const escaped = local.replace(/\$/g, '\\$');
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\??\\.(${re.source})`, 'g'))) out.add(`${local}.${m[1]}`);
  return out;
}

/** The package an npm import specifier names (`@scope/name/sub` → `@scope/name`), or null for relative/builtin/URL imports. */
export function npmPackage(spec) {
  if (/^(?:\.|\/|[a-z]+:|#|~)/i.test(spec)) return null;
  const segs = spec.split('/');
  return spec.startsWith('@') ? (segs.length >= 2 ? segs.slice(0, 2).join('/') : null) : segs[0];
}

export function scanJs(text) {
  const found = new Map();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  const bare = blankStrings(code);
  const bind = (spec, clause) => {
    const pkg = npmPackage(spec);
    if (!pkg) return;
    addTo(found, pkg, spec !== pkg ? spec : null);
    if (!clause) return;
    const named = /\{([^}]*)\}/.exec(clause);
    const locals = [];
    for (const part of named ? named[1].split(',') : []) {
      const m = /^\s*(?:type\s+)?([\w$]+)(?:\s*(?:as|:)\s*([\w$]+))?\s*$/.exec(part);
      if (!m) continue;
      addTo(found, pkg, m[1]);
      locals.push([m[2] ?? m[1], m[1]]);
    }
    const whole = (named ? clause.replace(named[0], '') : clause).replace(/^\s*type\s+/, '').split(',').map((s) => s.replace(/^\s*\*\s*as\s+/, '').trim()).filter((s) => IDENT.test(s));
    for (const local of whole) for (const m of members(bare, local)) addTo(found, pkg, m);
    for (const [local, imported] of locals) for (const m of members(bare, local)) addTo(found, pkg, `${imported}${m.slice(local.length)}`);
  };
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?([\w$*{][^;]*?)\s+from\s*['"]([^'"]+)['"]/g)) bind(m[2], m[1]);
  for (const m of code.matchAll(/\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)) bind(m[2], m[1].startsWith('{') ? m[1] : null);
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) bind(m[1], null);
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) bind(m[1], null);
  for (const m of code.matchAll(/(?:\b(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*)?\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) bind(m[2], m[1] ?? null);
  return found;
}

/** Python `import a.b as x` / `from a.b import c, d`: keyed by every dotted prefix of the module (`a`, `a.b`). */
export function scanPython(text) {
  const found = new Map();
  const code = text.replace(/#.*$/gm, '');
  const bare = blankStrings(code);
  const add = (path, symbol) => {
    const segs = path.split('.');
    for (let i = 1; i <= segs.length; i++) addTo(found, segs.slice(0, i).join('.'), symbol);
  };
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n;]+)/gm)) {
    for (const part of m[1].split(',')) {
      const p = /^\s*([A-Za-z_][\w.]*)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (!p) continue;
      add(p[1], p[1].includes('.') ? p[1] : null);
      const local = p[2] ?? p[1].split('.')[0];
      for (const member of members(bare, local, /[A-Za-z_]\w*/)) add(p[1], member);
    }
  }
  for (const m of code.matchAll(/^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]+)/gm)) {
    add(m[1], m[1].includes('.') ? m[1] : null);
    for (const part of m[2].replace(/[()\\]/g, ' ').split(',')) {
      const p = /^\s*([A-Za-z_]\w*)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (!p || p[1] === '*') continue;
      add(m[1], p[1]);
      for (const member of members(bare, p[2] ?? p[1], /[A-Za-z_]\w*/)) add(m[1], `${p[1]}${member.slice((p[2] ?? p[1]).length)}`);
    }
  }
  return found;
}

/** Rust `use krate::{a, b::C}` and `krate::path::Item` paths: keyed by the crate ident (dashes are underscores). */
export function scanRust(text) {
  const found = new Map();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const m of code.matchAll(/\buse\s+(?:::)?([a-z_][a-z0-9_]*)::([^;]*);/g)) {
    addTo(found, m[1], null);
    const body = m[2].replace(/\bas\s+\w+/g, '');
    for (const ident of body.match(/[A-Za-z_]\w*/g) ?? []) addTo(found, m[1], ident);
  }
  for (const m of code.matchAll(/\bextern\s+crate\s+([a-z_][a-z0-9_]*)/g)) addTo(found, m[1], null);
  for (const m of code.matchAll(/(?<![\w:])([a-z_][a-z0-9_]*)::((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)/g)) {
    if (/^(?:std|core|alloc|self|super|crate)$/.test(m[1])) continue;
    for (const ident of m[2].split('::')) addTo(found, m[1], ident);
  }
  return found;
}

/** The name a Go import path is used under by default: the last element without /vN, gopkg.in .vN, go-/-go affixes. */
export function goPackageName(path) {
  const segs = path.split('/');
  let last = segs.at(-1);
  if (/^v\d+$/.test(last) && segs.length > 1) last = segs.at(-2);
  return last.replace(/\.v\d+$/, '').replace(/^go-/, '').replace(/[-.]go$/, '').replace(/[^A-Za-z0-9_]/g, '');
}

/** Go imports (single and grouped, with aliases) and the exported names reached through them: keyed by import path. */
export function scanGo(text) {
  const found = new Map();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
  const bare = blankStrings(code);
  const specs = [];
  for (const m of code.matchAll(/\bimport\s*\(([^)]*)\)/g)) for (const s of m[1].matchAll(/(?:([\w.]+)\s+)?"([^"]+)"/g)) specs.push([s[1], s[2]]);
  for (const m of code.matchAll(/\bimport\s+(?:([\w.]+)\s+)?"([^"]+)"/g)) specs.push([m[1], m[2]]);
  for (const [alias, path] of specs) {
    addTo(found, path, null);
    if (alias === '_' || alias === '.') continue;
    const local = alias ?? goPackageName(path);
    for (const member of members(bare, local, /[A-Z]\w*/)) addTo(found, path, member);
  }
  return found;
}

const SCANNERS = { npm: scanJs, pypi: scanPython, crates: scanRust, go: scanGo };

/**
 * Scans the sources for one ecosystem: `Map<importKey, { files, symbols: Map<symbol, files> }>`.
 * Reading is sequential and sorted, so the counts are the same on every run.
 */
export async function scanSources(root, ecosystem, options) {
  const usage = new Map();
  for (const path of await sourceFiles(root, ecosystem, options)) {
    const info = await stat(path).catch(() => null);
    if (!info || info.size > MAX_FILE_BYTES) continue;
    const text = await readFile(path, 'utf8').catch(() => '');
    for (const [key, symbols] of SCANNERS[ecosystem](text)) {
      if (!usage.has(key)) usage.set(key, { files: 0, symbols: new Map() });
      const entry = usage.get(key);
      entry.files++;
      for (const s of symbols) entry.symbols.set(s, (entry.symbols.get(s) ?? 0) + 1);
    }
  }
  return usage;
}

/** Python distributions whose import name isn't the distribution name. */
const PY_MODULES = {
  pyyaml: ['yaml'], beautifulsoup4: ['bs4'], pillow: ['PIL'], 'scikit-learn': ['sklearn'], 'scikit-image': ['skimage'], 'python-dateutil': ['dateutil'],
  'opencv-python': ['cv2'], 'opencv-python-headless': ['cv2'], protobuf: ['google.protobuf'], attrs: ['attr', 'attrs'], 'python-dotenv': ['dotenv'],
  'python-multipart': ['multipart'], pyjwt: ['jwt'], 'typing-extensions': ['typing_extensions'], pymongo: ['pymongo', 'bson', 'gridfs'],
  'python-magic': ['magic'], pycryptodome: ['Crypto'], pyopenssl: ['OpenSSL'], 'msgpack-python': ['msgpack'], mysqlclient: ['MySQLdb'], 'psycopg2-binary': ['psycopg2'],
};

/** Module paths a Python distribution name can stand for: each `-` as `_` or `.` (`llama-index-core` → `llama_index.core`). */
function pythonModules(name) {
  const parts = name.split('-');
  if (parts.length > 5) return [parts.join('_')];
  let out = [parts[0]];
  for (const part of parts.slice(1)) out = out.flatMap((p) => [`${p}_${part}`, `${p}.${part}`]);
  return out;
}

/** The import keys a dependency appears under in the code. */
export function importKeys(dep) {
  if (dep.ecosystem === 'npm') return [dep.importAs];
  if (dep.ecosystem === 'crates') return [dep.importAs.replace(/-/g, '_')];
  if (dep.ecosystem === 'pypi') {
    const plain = dep.name.replace(/-/g, '_');
    return [...new Set([...(PY_MODULES[dep.name] ?? []), ...pythonModules(dep.name), plain.replace(/^python_|^py_|_python$|_py$/, '')])];
  }
  return [dep.importAs];
}

/**
 * What the code uses of `dep`: files importing it and its symbols, most used first (ties by name), at most `limit`.
 * Go sums the module's package paths; Python takes its best-matching module path (the scan keys every dotted prefix).
 */
export function usageOf(dep, usage, limit = 40) {
  const keys = importKeys(dep);
  let hits = [...usage].filter(([key]) => (dep.ecosystem === 'go' ? keys.some((k) => key === k || key.startsWith(`${k}/`)) : keys.includes(key)));
  if (dep.ecosystem === 'pypi' && hits.length > 1) hits = [hits.reduce((best, h) => (h[1].files > best[1].files || (h[1].files === best[1].files && h[0].length > best[0].length) ? h : best))];
  let files = 0;
  const symbols = new Map();
  for (const [, entry] of hits) {
    files += entry.files;
    for (const [s, n] of entry.symbols) symbols.set(s, (symbols.get(s) ?? 0) + n);
  }
  const sorted = [...symbols].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, limit).map(([s]) => s);
  return { files, symbols: sorted };
}
