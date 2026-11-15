// `llms-ink context`: version-pinned, code-relevant docs for a repo's dependencies in .context/, referenced from AGENTS.md.
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, VERSION } from '../cli.js';
import { resolveVersions } from './lockfiles.js';
import { GROUPS, MANIFESTS, parseManifest } from './manifests.js';
import { agentsBlock, fileName, ownFiles, packageFile, readme, removeFile, updateAgentsMd, writeIfChanged } from './output.js';
import { findDocs } from './registry.js';
import { scanSources, usageOf } from './scan.js';
import { trimDocs } from './trim.js';
import { outputDirectory, readOutput, validateOutputContent } from './files.js';

export const CONTEXT_HELP = `llms-ink context — version-pinned docs for your dependencies, trimmed to what your code uses

Usage
  llms-ink context [--manifest <file>]... [--out .context] [--max 10] [--agents-md AGENTS.md]

Reads each manifest (package.json, pyproject.toml, requirements*.txt, Cargo.toml, go.mod; by default the ones in
this folder) and its lockfile, finds docs for the installed version, keeps the sections that mention what the code
imports, and writes <out>/<package>@<version>.md, <out>/README.md and a block in AGENTS.md.

Options
  -m, --manifest <file>  a manifest to read; repeat for several                 [found here]
      --out <dir>        where to write the docs                                [.context]
      --max <n>          packages to fetch docs for, most imported first, 1–50  [10]
      --tokens <n>       about how many tokens per package, 500–50000           [6000]
      --agents-md <file> the file to keep the docs block in; none to skip      [AGENTS.md]
      --quiet            nothing on stderr but errors
      --api <url>        API base URL (or LLMS_INK_API)
      --key <key>        API key for higher limits (or LLMS_INK_KEY); optional

Output paths must not contain symlinks; existing output files must not be hard-linked.
Writes replace individual files atomically. Do not modify output directories during a run.
Each package fetched counts as a link toward llms.ink's daily limit (cached links are free).
Generation does not inspect content. See context inspect --help for explicit pack
inspection and context verify --help for offline manifest verification.`;

const ORDER = { npm: 0, pypi: 1, crates: 2, go: 3 };
const posix = (p) => p.split(sep).join('/');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function integer(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(`--${name}: a whole number from ${min} to ${max}.`, 2);
  return n;
}

/** Registry and GitHub reads: JSON (null on 404/410), text (null on any failure) and a yes/no probe, cached for the run. */
export function registryHttp(fetchImpl) {
  const headers = { 'user-agent': `llms-ink-cli/${VERSION} (+https://llms.ink)`, accept: 'application/json' };
  const cache = new Map();
  const once = (key, run) => {
    if (!cache.has(key)) cache.set(key, run());
    return cache.get(key);
  };
  const get = async (url, init = {}) => {
    try {
      return await fetchImpl(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error(`couldn’t reach ${new URL(url).host}`);
    }
  };
  return {
    json: (url) => once(`json ${url}`, async () => {
      const res = await get(url);
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
      return res.json();
    }),
    text: (url) => once(`text ${url}`, async () => {
      const res = await get(url, { headers: { accept: '*/*' } }).catch(() => null);
      return res?.ok ? res.text() : null;
    }),
    ok: (url) => once(`ok ${url}`, async () => {
      const res = await get(url, { method: 'HEAD' }).catch(() => null);
      return !!res?.ok;
    }),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Manifests to read: the ones given, else the supported ones in `cwd`. */
async function manifestsFor(values, cwd) {
  if (values.manifest?.length) {
    const files = [];
    for (const m of values.manifest) {
      const path = resolve(cwd, m);
      if (!(await stat(path).then((s) => s.isFile(), () => false))) throw new CliError(`No such file: ${m}`, 2);
      files.push(path);
    }
    return [...new Set(files)];
  }
  const found = [];
  for (const name of MANIFESTS) if (await stat(join(cwd, name)).then((s) => s.isFile(), () => false)) found.push(join(cwd, name));
  if (!found.length) throw new CliError(`No manifest here (${MANIFESTS.join(', ')}). Pass one with --manifest.`);
  return found;
}

/** Direct dependencies of every manifest with their installed version and what the code uses of them. */
export async function collect(manifests, { cwd, outDir }) {
  const deps = [];
  const skipped = [];
  const scans = new Map();
  for (const [m, file] of manifests.entries()) {
    const rel = posix(relative(cwd, file)) || file;
    let parsed;
    try {
      parsed = parseManifest(file, await readFile(file, 'utf8'));
    } catch (err) {
      throw new CliError(`${rel}: ${err.message}`);
    }
    const key = `${parsed.ecosystem} ${dirname(file)}`;
    if (!scans.has(key)) scans.set(key, await scanSources(dirname(file), parsed.ecosystem, { workspace: parsed.workspace, skip: [outDir] }));
    for (const dep of await resolveVersions(file, parsed.deps, cwd)) deps.push({ ...dep, manifest: m, usage: usageOf(dep, scans.get(key)) });
    skipped.push(...parsed.skipped);
  }
  const seen = new Set();
  const unique = deps.filter((d) => {
    const id = `${d.ecosystem} ${d.name} ${d.version}`;
    return !seen.has(id) && seen.add(id);
  });
  unique.sort((a, b) => b.usage.files - a.usage.files || GROUPS[a.group] - GROUPS[b.group] || a.manifest - b.manifest || compare(a.name, b.name));
  return { deps: unique, skipped };
}

/**
 * Runs `llms-ink context <argv>`. `io`: `{ env, stdout, stderr, cwd, fetch, client, reporter }` (client and reporter
 * are the CLI's). Returns the exit code: 0 done (some packages may be listed as not included), 1 when every docs
 * fetch failed, 2 wrong usage.
 */
export async function cmdContext(argv, io) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        manifest: { type: 'string', short: 'm', multiple: true }, out: { type: 'string' }, max: { type: 'string' }, tokens: { type: 'string' },
        'agents-md': { type: 'string' }, quiet: { type: 'boolean' }, api: { type: 'string' }, key: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw new CliError(`${err.message.replace(/\. To specify.*$/, '')}\nRun llms-ink context --help for the options.`, 2);
  }
  const { values, positionals } = parsed;
  if (values.help) { io.stdout.write(`${CONTEXT_HELP}\n`); return 0; }
  if (positionals.length) throw new CliError(`context takes options only (got “${positionals[0]}”); use --manifest <file>.`, 2);
  const max = integer(values.max, 'max', 1, 50, 10);
  const maxTokens = integer(values.tokens, 'tokens', 500, 50_000, 6000);
  const lexicalCwd = resolve(io.cwd), cwd = await realpath(io.cwd);
  const outputPath = (value) => {
    const rel = relative(lexicalCwd, resolve(lexicalCwd, value));
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) ? resolve(cwd, rel) : resolve(cwd, value);
  };
  const outDir = outputPath(values.out ?? '.context');
  const agentsMd = values['agents-md'] === 'none' ? null : outputPath(values['agents-md'] ?? 'AGENTS.md');
  const progress = io.reporter(io.stderr, !!values.quiet);
  const show = (p) => posix(relative(cwd, p)) || '.';

  const { deps, skipped } = await collect(await manifestsFor(values, cwd), { cwd, outDir });
  const chosen = deps.slice(0, max);
  for (const d of deps.slice(max)) skipped.push({ ecosystem: d.ecosystem, name: d.name, reason: `over the --max ${max} limit` });

  // Validate every prospective destination before fetching. Repo-supplied links,
  // malformed versions and broken merge markers must not cause partial writes.
  await outputDirectory(outDir);
  const existing = await ownFiles(outDir), previous = new Map(), filenames = new Map(), allocated = new Set();
  for (const dep of chosen) {
    let file = fileName(dep.name, dep.version);
    if (allocated.has(file)) file = file.replace(/\.md$/, `.${dep.ecosystem}.md`);
    if (allocated.has(file)) throw new CliError('Dependency output filenames collide. Review the selected manifests.');
    allocated.add(file); filenames.set(dep, file);
  }
  for (const path of new Set([...existing.keys(), ...allocated, 'README.md'].map(file => join(outDir, file)).concat(agentsMd ? [agentsMd] : [])))
    previous.set(path, await readOutput(path));
  const managedPaths = new Set([...existing.keys(), ...allocated, 'README.md'].map(file => join(outDir, file)));
  if (agentsMd && managedPaths.has(agentsMd)) throw new CliError('Context outputs overlap. Choose a separate AGENTS.md path.');
  for (const file of allocated) if (previous.get(join(outDir, file)) !== null && !existing.has(file))
    throw new CliError('A dependency output already exists without context generator metadata. Move it or choose another output directory.');
  const indexBefore = previous.get(join(outDir, 'README.md'));
  if (indexBefore !== null && (!indexBefore.startsWith('# Dependency docs\n\n') || !indexBefore.includes('Written by `llms-ink context` from the lockfiles;')))
    throw new CliError('The output README.md is not a generated context index. Move it or choose another output directory.');
  const agentsBefore = agentsMd ? previous.get(agentsMd) : null;
  if (agentsMd) updateAgentsMd(agentsBefore, '');

  const api = io.client(values.api ?? io.env.LLMS_INK_API ?? 'https://llms.ink', (values.key ?? io.env.LLMS_INK_KEY)?.trim(), io.fetch);
  const http = registryHttp(io.fetch);
  const reads = new Map();
  const read = (url) => {
    if (!reads.has(url)) reads.set(url, api.call(`/api/v0/llms?${new URLSearchParams({ url, mode: 'full' })}`).then((res) => res.json()));
    return reads.get(url);
  };
  let done = 0;
  // Two at a time: llms.ink rate-limits bursts per IP, and CI runners share theirs.
  const results = await mapLimit(chosen, 2, async (dep) => {
    const label = `${dep.name}${dep.version ? `@${dep.version}` : ''}`;
    progress.say(`Reading docs (${done}/${chosen.length})… ${label}`);
    try {
      let docs;
      try {
        docs = await findDocs(dep, http);
      } catch (err) {
        return { dep, skip: `registry lookup failed: ${err.message}` };
      }
      if (docs.skip) return { dep, skip: docs.skip };
      let result;
      try {
        result = await read(docs.url);
      } catch (err) {
        return { dep, failed: `reading ${docs.url} failed: ${err.message}` };
      }
      if (typeof result?.text !== 'string') return { dep, failed: `unexpected answer from /api/llms for ${docs.url}` };
      const trimmed = trimDocs(result.text, { symbols: dep.usage.symbols, maxTokens, native: result.source === 'native' });
      return { dep, docs, trimmed, usage: dep.usage };
    } finally {
      done++;
    }
  });
  progress.done('');

  const keep = new Map();
  const changes = [], writes = [], removals = [];
  const entry = (file, fm) => ({ file, package: fm.package, ecosystem: fm.ecosystem, version: fm.version, docs: fm.docs, uses: fm.uses ?? [] });
  for (const r of results) {
    if (r.trimmed) {
      const file = filenames.get(r.dep);
      const content = packageFile(r);
      keep.set(file, entry(file, { package: r.dep.name, ecosystem: r.dep.ecosystem, version: r.dep.version ?? 'unresolved', docs: r.docs.pinned ? 'pinned' : 'unpinned', uses: r.usage.symbols }));
      writes.push([join(outDir, file), content, `${r.docs.pinned ? 'pinned' : 'unpinned'} · ${r.trimmed.tokens.toLocaleString('en-US')} tokens`]);
      continue;
    }
    // A failed read keeps the package's earlier file, if any, rather than dropping docs over a transient error.
    const earlier = [...existing].filter(([, fm]) => fm.package === r.dep.name && fm.ecosystem === r.dep.ecosystem);
    for (const [file, fm] of earlier) keep.set(file, entry(file, fm));
    skipped.push({ ecosystem: r.dep.ecosystem, name: r.dep.name, reason: `${r.skip ?? r.failed}${earlier.length ? '; kept the earlier file' : ''}` });
  }
  for (const file of existing.keys()) {
    if (keep.has(file)) continue;
    removals.push(join(outDir, file));
  }
  const entries = [...keep.values()].sort((a, b) => compare(a.file, b.file));
  skipped.sort((a, b) => ORDER[a.ecosystem] - ORDER[b.ecosystem] || compare(a.name, b.name) || compare(a.reason, b.reason));
  writes.push([join(outDir, 'README.md'), readme(entries, skipped), 'index']);
  if (agentsMd) {
    let next;
    try {
      next = updateAgentsMd(agentsBefore, agentsBlock(entries, posix(relative(dirname(agentsMd), outDir)) || '.'));
    } catch (err) {
      throw new CliError(`${show(agentsMd)}: ${err.message}`);
    }
    writes.push([agentsMd, next, 'docs block']);
  }

  if (new Set(writes.map(([path]) => path)).size !== writes.length || removals.some(path => writes.some(([dest]) => dest === path)))
    throw new CliError('Context outputs overlap. Choose a separate AGENTS.md path.');
  for (const [, content] of writes) validateOutputContent(content);
  for (const [path, before] of previous) if (await readOutput(path) !== before)
    throw new CliError('A context output changed while fetching. No files were written; review it and rerun.');
  for (const [path, content, note] of writes) changes.push([await writeIfChanged(path, content, previous.get(path)), path, note]);
  for (const path of removals) { await removeFile(path, previous.get(path)); changes.push(['removed', path, '']); }

  for (const [status, path, note] of changes) io.stdout.write(`${status.padEnd(9)} ${show(path)}${note ? `  (${note})` : ''}\n`);
  for (const s of skipped) progress.done(`not included: ${s.name} (${s.ecosystem}): ${s.reason}`);
  const failed = results.filter((r) => r.failed).length;
  const fetched = results.filter((r) => r.trimmed).length;
  progress.done(`${fetched} of ${deps.length} ${deps.length === 1 ? 'package' : 'packages'} with docs in ${show(outDir)}${failed ? ` · ${failed} failed` : ''}`);
  return failed && !fetched ? 1 : 0;
}
