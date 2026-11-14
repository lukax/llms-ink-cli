// Dependency manifests → direct dependencies (name, the name the code imports it as, version spec, group).
import { basename } from 'node:path';
import { parseToml } from './toml.js';

/** Manifests looked for in the working folder when no --manifest is given, in this order. */
export const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod'];
export const GROUPS = { runtime: 0, peer: 1, optional: 2, build: 3, dev: 4 };

/** PEP 503 name: lowercase, runs of -_. as one -. */
export const pep503 = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

const NAMES = {
  npm: /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i,
  pypi: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
  crates: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  go: /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[A-Za-z0-9._~+-]+)*$/i,
};
const LOCAL = 'not a registry package (local, workspace, git or URL)';

export function ecosystemOf(file) {
  const base = basename(file).toLowerCase();
  if (base === 'package.json') return 'npm';
  if (base === 'pyproject.toml' || /^requirements.*\.(?:txt|in)$/.test(base)) return 'pypi';
  if (base === 'cargo.toml') return 'crates';
  if (base === 'go.mod') return 'go';
  return null;
}

/** `==1.2.3` (or `===1.2.3`) in a PEP 508 spec; wildcards don't count. */
export function pythonPin(spec) {
  const m = /(?:^|[\s,(])===?\s*([A-Za-z0-9.+!_-]+)(?=\s*(?:[,;)]|$))/.exec(spec ?? '');
  return m && !m[1].includes('*') ? m[1] : null;
}

/**
 * Direct dependencies of package.json, pyproject.toml, requirements*.txt, Cargo.toml or go.mod.
 * Each: `{ ecosystem, name, importAs, spec, group }`; `importAs` is the name the code imports (an npm alias or a renamed crate).
 * `workspace`: the manifest declares a workspace (its members' sources count as its own).
 */
export function parseManifest(file, text) {
  const ecosystem = ecosystemOf(file);
  if (!ecosystem) throw new Error(`Unsupported manifest ${file}; use package.json, pyproject.toml, requirements*.txt, Cargo.toml or go.mod.`);
  const deps = [];
  const skipped = [];
  let workspace = false;
  const add = (name, group, spec = null, importAs = name) => {
    if (!NAMES[ecosystem].test(name)) return skipped.push({ ecosystem, name, reason: 'unrecognized package name' });
    deps.push({ ecosystem, name: ecosystem === 'pypi' ? pep503(name) : name, importAs, spec, group });
  };
  const skip = (name) => skipped.push({ ecosystem, name, reason: LOCAL });
  const pep508 = (spec, group) => {
    if (typeof spec !== 'string') return;
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
    if (!m) return;
    if (/^\s*[A-Za-z0-9._-]+\s*(?:\[[^\]]*\])?\s*@/.test(spec)) skip(m[1]);
    else add(m[1], group, spec.slice(m[0].length).trim() || null);
  };
  if (ecosystem === 'npm') {
    const json = JSON.parse(text);
    workspace = !!json.workspaces;
    for (const [field, group] of [['dependencies', 'runtime'], ['peerDependencies', 'peer'], ['optionalDependencies', 'optional'], ['devDependencies', 'dev']]) {
      for (const [key, spec] of Object.entries(json[field] ?? {})) {
        if (deps.some((d) => d.importAs === key)) continue;
        const alias = typeof spec === 'string' && /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(spec.trim());
        if (alias) add(alias[1], group, spec.trim(), key);
        else if (typeof spec !== 'string' || /^(?:file|link|workspace|portal|patch|git|git\+[a-z]+|github|gitlab|bitbucket|https?):|^(?:\.|\/|~\/)|^[\w.-]+\/[\w.-]+(?:#.*)?$/i.test(spec.trim())) skip(key);
        else add(key, group, spec.trim());
      }
    }
  } else if (basename(file).toLowerCase() === 'pyproject.toml') {
    const toml = parseToml(text);
    for (const spec of toml.project?.dependencies ?? []) pep508(spec, 'runtime');
    for (const list of Object.values(toml.project?.['optional-dependencies'] ?? {})) for (const spec of list) pep508(spec, 'optional');
    const poetry = toml.tool?.poetry ?? {};
    const poetryTable = (table, group) => {
      for (const [name, spec] of Object.entries(table ?? {})) {
        if (name.toLowerCase() === 'python') continue;
        if (spec && typeof spec === 'object' && !Array.isArray(spec) && (spec.path || spec.git || spec.url)) skip(name);
        else add(name, group, typeof spec === 'string' ? spec : typeof spec?.version === 'string' ? spec.version : null);
      }
    };
    poetryTable(poetry.dependencies, 'runtime');
    poetryTable(poetry['dev-dependencies'], 'dev');
    for (const g of Object.values(poetry.group ?? {})) poetryTable(g?.dependencies, 'dev');
    for (const list of Object.values(toml['dependency-groups'] ?? {})) for (const spec of list) pep508(spec, 'dev');
    for (const spec of toml.tool?.uv?.['dev-dependencies'] ?? []) pep508(spec, 'dev');
    workspace = !!toml.tool?.uv?.workspace;
  } else if (ecosystem === 'pypi') {
    for (const raw of text.split(/\r?\n/)) {
      const entry = raw.replace(/(?:^|\s)#.*$/, '').replace(/\s+--hash=\S+/g, '').replace(/\\$/, '').trim();
      if (!entry || entry.startsWith('-')) continue;
      if (/^(?:[.~/]|[a-z][a-z0-9+.-]*:\/\/|git\+)/i.test(entry)) { skip(entry); continue; }
      pep508(entry, 'runtime');
    }
  } else if (ecosystem === 'crates') {
    const toml = parseToml(text);
    workspace = !!toml.workspace;
    const table = (entries, group) => {
      for (const [key, spec] of Object.entries(entries ?? {})) {
        const obj = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
        const name = typeof obj?.package === 'string' ? obj.package : key;
        if (deps.some((d) => d.name === name)) continue;
        if (obj && (((obj.path || obj.git) && !obj.version && !obj.workspace) || obj.registry)) skip(name);
        else add(name, group, typeof spec === 'string' ? spec : typeof obj?.version === 'string' ? obj.version : null, key);
      }
    };
    const kinds = [['dependencies', 'runtime'], ['build-dependencies', 'build'], ['dev-dependencies', 'dev']];
    for (const [field, group] of kinds) table(toml[field], group);
    for (const target of Object.values(toml.target ?? {})) for (const [field, group] of kinds) table(target?.[field], group);
    table(toml.workspace?.dependencies, 'runtime');
  } else {
    // go.mod: `require` lists the selected (minimal version selection) version of each module; `replace` can swap it.
    const replaces = new Map();
    let block = null;
    for (const raw of text.split(/\r?\n/)) {
      const entry = raw.replace(/\/\/(?!\s*indirect\b).*$/, '').trim();
      if (!entry) continue;
      if (block && entry === ')') { block = null; continue; }
      const open = /^(require|replace|exclude|retract)\s*\($/.exec(entry);
      if (open) { block = open[1]; continue; }
      const verb = block ?? /^(require|replace|exclude|retract)\b/.exec(entry)?.[1];
      const rest = block ? entry : entry.replace(/^\S+\s*/, '');
      if (verb === 'require') {
        const m = /^(\S+)\s+(\S+)(.*)$/.exec(rest);
        if (m && !/\/\/\s*indirect\b/.test(m[3])) add(m[1], 'runtime', m[2]);
      } else if (verb === 'replace') {
        const m = /^(\S+)(?:\s+\S+)?\s*=>\s*(\S+)(?:\s+(\S+))?$/.exec(rest);
        if (m) replaces.set(m[1], m[3] ? { name: m[2], version: m[3] } : null);
      }
    }
    for (let i = deps.length - 1; i >= 0; i--) {
      if (!replaces.has(deps[i].name)) continue;
      const to = replaces.get(deps[i].name);
      if (!to) { skip(deps[i].name); deps.splice(i, 1); } else deps[i] = { ...deps[i], name: to.name, spec: to.version };
    }
  }
  return { ecosystem, deps, skipped, workspace };
}
