// Installed versions from lockfiles: package-lock.json / npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock (classic and
// berry), uv.lock / poetry.lock / pdm.lock, requirements*.txt pins, Cargo.lock; go.mod's require is already the version.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pep503, pythonPin } from './manifests.js';

const read = (path) => readFile(path, 'utf8').catch(() => null);

/** The first folder from `dir` up to `root` (inclusive) holding one of `names`: `{ dir, name, text }`. */
async function findUp(dir, root, names) {
  for (let at = dir; ; at = dirname(at)) {
    for (const name of names) {
      const text = await read(join(at, name));
      if (text !== null) return { dir: at, name, text };
    }
    if (at === root || !(at + sep).startsWith(root + sep) || dirname(at) === at) return null;
  }
}

/** Strips pnpm/yarn peer suffixes (`1.2.3(react@18.0.0)`, `1.2.3_react@18.0.0`) and alias names (`npm:pkg@1.2.3`, `pkg@1.2.3`). */
const cleanVersion = (v) => String(v).replace(/^['"]|['"]$/g, '').replace(/\(.*$/, '').replace(/_.*$/, '').replace(/^(?:npm:)?@?[^@]+@(?=\d)/, '').trim();

/** package-lock.json v1–v3: the member's own node_modules first, then the hoisted one. */
export function npmLockVersions(text, member = '') {
  const lock = JSON.parse(text);
  return (key) => {
    const prefix = member ? `${member}/` : '';
    const entry = lock.packages?.[`${prefix}node_modules/${key}`] ?? lock.packages?.[`node_modules/${key}`] ?? lock.dependencies?.[key];
    return typeof entry?.version === 'string' && !/^(?:file|link|git|https?):/.test(entry.version) ? entry.version : null;
  };
}

/** Block mappings of a YAML file as `path → scalar` (enough for pnpm-lock.yaml; sequences are ignored). */
function yamlPaths(text) {
  const out = new Map();
  const stack = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*(?:#|- )/.test(raw)) continue;
    const m = /^(\s*)('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^:\s][^:]*?):(?:\s+(.*))?$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const key = m[2].replace(/^'(.*)'$/, (_, s) => s.replace(/''/g, "'")).replace(/^"(.*)"$/, '$1');
    stack.push({ indent, key });
    if (m[3] !== undefined && m[3] !== '') out.set(stack.map((s) => s.key).join('\0'), m[3].replace(/\s+#.*$/, ''));
  }
  return out;
}

/** pnpm-lock.yaml v5–v9: `importers.<member>.<deps>.<name>.version` (v6+) or `<deps>.<name>` (v5 without importers). */
export function pnpmLockVersions(text, member = '') {
  const paths = yamlPaths(text);
  const importer = member || '.';
  return (key) => {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const v = paths.get(['importers', importer, field, key, 'version'].join('\0')) ?? paths.get(['importers', importer, field, key].join('\0')) ?? (importer === '.' ? paths.get([field, key].join('\0')) : undefined);
      if (v && !/^(?:link|file|workspace):/.test(v)) return cleanVersion(v);
    }
    return null;
  };
}

/** yarn.lock (classic `version "x"`, berry `version: x`): the entry listing `key@spec`, else the only entry for `key`. */
export function yarnLockVersions(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S.*:$/.test(line) && !line.startsWith('#')) {
      current = { descriptors: line.slice(0, -1).split(/,\s*/).map((d) => d.trim().replace(/^"|"$/g, '')), version: null };
      entries.push(current);
    } else if (current && !current.version) {
      const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
      if (m) current.version = m[1];
    }
  }
  const nameOf = (d) => d.slice(0, d.indexOf('@', 1));
  return (key, spec) => {
    const wanted = spec ? new Set([`${key}@${spec}`, `${key}@npm:${spec}`]) : new Set();
    const exact = entries.find((e) => e.descriptors.some((d) => wanted.has(d)));
    if (exact?.version) return exact.version;
    const versions = [...new Set(entries.filter((e) => e.descriptors.some((d) => nameOf(d) === key)).map((e) => e.version).filter(Boolean))];
    return versions.length === 1 ? versions[0] : null;
  };
}

/** `[[package]]` tables with name and version (Cargo.lock, uv.lock, poetry.lock, pdm.lock) without a full TOML parse. */
export function lockPackages(text) {
  const out = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\[\[package\]\]\s*$/.test(line)) { current = {}; out.push(current); continue; }
    if (/^\[/.test(line)) { current = null; continue; }
    const m = current && /^(name|version)\s*=\s*"([^"]*)"/.exec(line);
    if (m && current[m[1]] === undefined) current[m[1]] = m[2];
  }
  return out.filter((p) => p.name && p.version);
}

const parts = (v) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return a.localeCompare(b);
}

/** Cargo's default (caret) requirement: same leftmost non-zero component as the requirement's. */
function caretMatches(version, req) {
  const r = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(req ?? '');
  if (!r) return true;
  const want = [r[1], r[2], r[3]].map((n) => (n === undefined ? null : Number(n)));
  const have = parts(version);
  const lead = want.findIndex((n) => n !== 0 && n !== null);
  const upto = lead === -1 ? want.filter((n) => n !== null).length - 1 : lead;
  for (let i = 0; i <= upto; i++) if (want[i] !== null && want[i] !== have[i]) return false;
  return true;
}

/** Cargo.lock may hold several versions of a crate: the highest one the manifest's requirement accepts. */
export function cargoLockVersions(text) {
  const all = lockPackages(text);
  return (name, spec) => {
    const versions = all.filter((p) => p.name === name).map((p) => p.version).sort(compareVersions);
    const fit = versions.filter((v) => caretMatches(v, spec));
    return (fit.length ? fit : versions).at(-1) ?? null;
  };
}

/** requirements*.txt next to the manifest: `name==version` pins. */
async function requirementPins(dir) {
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^requirements.*\.(?:txt|in)$/i.test(f)).sort();
  const pins = new Map();
  for (const file of files) {
    for (const raw of ((await read(join(dir, file))) ?? '').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(raw.replace(/(?:^|\s)#.*$/, ''));
      const pin = m && pythonPin(m[2]);
      if (pin && !pins.has(pep503(m[1]))) pins.set(pep503(m[1]), { version: pin, from: file });
    }
  }
  return pins;
}

/** An exact version written in the manifest itself (npm `1.2.3`, PEP 440 `==1.2.3`, Cargo `=1.2.3`). */
function manifestPin(dep) {
  const spec = (dep.spec ?? '').trim();
  if (dep.ecosystem === 'npm') return /^(?:npm:(?:@[^/@]+\/)?[^@]+@)?=?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(spec)?.[1] ?? null;
  if (dep.ecosystem === 'pypi') return pythonPin(spec);
  if (dep.ecosystem === 'crates') return /^=\s*(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(spec)?.[1] ?? null;
  return null;
}

/**
 * Sets `version` and `versionFrom` on each dependency of the manifest at `file` (null when nothing pins it).
 * Lockfiles are looked for next to the manifest, then in parent folders up to `root` (workspaces).
 */
export async function resolveVersions(file, deps, root) {
  const dir = dirname(file);
  const resolved = [];
  const member = (lockDir) => relative(lockDir, dir).split(sep).join('/');
  let lookup = null;
  let from = null;
  if (deps[0]?.ecosystem === 'npm') {
    const lock = await findUp(dir, root, ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);
    if (lock) {
      from = relative(root, join(lock.dir, lock.name)).split(sep).join('/');
      lookup = lock.name === 'pnpm-lock.yaml' ? pnpmLockVersions(lock.text, member(lock.dir)) : lock.name === 'yarn.lock' ? yarnLockVersions(lock.text) : npmLockVersions(lock.text, member(lock.dir));
    }
  } else if (deps[0]?.ecosystem === 'pypi') {
    const lock = await findUp(dir, root, ['uv.lock', 'poetry.lock', 'pdm.lock']);
    const locked = lock ? new Map(lockPackages(lock.text).map((p) => [pep503(p.name), p.version])) : new Map();
    const pins = await requirementPins(dir);
    const lockName = lock && relative(root, join(lock.dir, lock.name)).split(sep).join('/');
    const reqDir = relative(root, dir).split(sep).join('/');
    lookup = (name) => {
      if (locked.has(name)) return { version: locked.get(name), from: lockName };
      const pin = pins.get(name);
      return pin ? { version: pin.version, from: reqDir ? `${reqDir}/${pin.from}` : pin.from } : null;
    };
  } else if (deps[0]?.ecosystem === 'crates') {
    const lock = await findUp(dir, root, ['Cargo.lock']);
    if (lock) {
      from = relative(root, join(lock.dir, lock.name)).split(sep).join('/');
      lookup = cargoLockVersions(lock.text);
    }
  }
  const manifestName = relative(root, file).split(sep).join('/');
  for (const dep of deps) {
    let version = null;
    let versionFrom = null;
    if (dep.ecosystem === 'go') [version, versionFrom] = [dep.spec, manifestName];
    else if (lookup) {
      const hit = dep.ecosystem === 'npm' ? lookup(dep.importAs, dep.spec) : lookup(dep.name, dep.spec);
      if (hit && typeof hit === 'object') [version, versionFrom] = [hit.version, hit.from];
      else if (hit) [version, versionFrom] = [hit, from];
    }
    if (!version && (version = manifestPin(dep))) versionFrom = manifestName;
    resolved.push({ ...dep, version: version ?? null, versionFrom });
  }
  return resolved;
}
