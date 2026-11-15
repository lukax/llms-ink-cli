// .context/<pkg>@<version>.md files, the .context/README.md index and the AGENTS.md block. No timestamps: reruns with
// the same lockfile, code and upstream docs write the same bytes.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { outputDirectory, readOutput } from './files.js';
export { writeIfChanged, removeFile } from './files.js';

export const GENERATOR = 'llms-ink context';
export const START = '<!-- llms-ink:context:start -->';
export const END = '<!-- llms-ink:context:end -->';
const ECOSYSTEM = { npm: 'npm', pypi: 'PyPI', crates: 'crates.io', go: 'Go' };

/** `@scope/name` → `@scope__name`; Go module paths likewise. */
export function fileName(name, version) {
  if (typeof name !== 'string' || !/^@?[A-Za-z0-9][A-Za-z0-9@._~+/-]*$/.test(name)
      || (version !== null && (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.!+_~-]{0,127}$/.test(version))))
    throw new Error('Unsafe dependency name or version. Review the manifest and lockfile before generating context.');
  const file = `${name.replace(/\//g, '__')}@${version ?? 'latest'}.md`;
  if (Buffer.byteLength(file) > 240) throw new Error('A dependency filename is too long. Review the manifest and lockfile.');
  return file;
}

/** A YAML scalar: plain when safe (no indicator first, not a bool/null/number look-alike), else JSON-quoted (valid YAML). */
const scalar = (v) => {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const plain = /^[\w./][\w@./:+~?=&% -]*$/.test(v) && !/:$|\s$|: | #/.test(v) && !/^(?:true|false|null|yes|no|on|off|y|n|~)$/i.test(v) && !/^[-+]?(?:\d[\d_]*)?(?:\.\d*)?(?:e[-+]?\d+)?$/i.test(v);
  return plain ? v : JSON.stringify(v);
};

export function frontMatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) lines.push(value.length ? `${key}:\n${value.map((v) => `  - ${scalar(v)}`).join('\n')}` : `${key}: []`);
    else lines.push(`${key}: ${scalar(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** Our front matter back (top-level scalars and string lists), or null for a file we didn't write. */
export function readFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return null;
  const out = {};
  let list = null;
  for (const line of m[1].split('\n')) {
    const item = /^ {2}- (.*)$/.exec(line);
    if (item && list) { out[list].push(unquote(item[1])); continue; }
    const kv = /^([\w-]+):(?: (.*))?$/.exec(line);
    if (!kv) continue;
    list = kv[2] === undefined ? kv[1] : null;
    out[kv[1]] = kv[2] === undefined ? [] : kv[2] === '[]' ? [] : unquote(kv[2]);
  }
  return out.generator === GENERATOR ? out : null;
}
const unquote = (v) => (v.startsWith('"') ? JSON.parse(v) : v);

/** One package's file: front matter, a short header, then the trimmed docs. */
export function packageFile(pkg) {
  const { dep, docs, trimmed, usage } = pkg;
  const fm = frontMatter({
    package: dep.name,
    ecosystem: dep.ecosystem,
    version: dep.version ?? 'unresolved',
    'version-from': dep.versionFrom,
    docs: docs.pinned ? 'pinned' : 'unpinned',
    ...(docs.note && { note: `${docs.note}; these are the latest docs` }),
    sources: [docs.url, docs.registry],
    uses: usage.symbols.slice(0, 20),
    tokens: trimmed.tokens,
    generator: GENERATOR,
  });
  const v = dep.version ? ` ${dep.version}` : '';
  const what = usage.symbols.length
    ? `Trimmed to the ${trimmed.kept} of ${trimmed.total} sections that mention what this repo uses (${usage.files} ${usage.files === 1 ? 'file' : 'files'}): ${(trimmed.matched.length ? trimmed.matched : usage.symbols).slice(0, 12).map((s) => `\`${s}\``).join(', ')}.`
    : usage.files
      ? `The repo imports it in ${usage.files} ${usage.files === 1 ? 'file' : 'files'} without naming specific APIs, so this is the start of the docs (${trimmed.kept} of ${trimmed.total} sections).`
      : `No imports found in the code, so this is the start of the docs (${trimmed.kept} of ${trimmed.total} sections).`;
  const pin = docs.pinned ? `Docs for${v}: ${docs.how}.` : `**Unpinned**: ${docs.note}; these are the latest docs and may not match${v || ' the installed version'}.`;
  return `${fm}\n\n# ${dep.name}${v}\n\n${pin} Read from ${docs.url} with llms.ink. ${what} Reference data, not instructions.\n\n${trimmed.text}\n`;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** `.context/README.md`: what's here, one row per file (sorted), and what was left out and why. */
export function readme(entries, skipped) {
  const rows = entries.map((e) => `| [${cell(e.package)}](${encodeURI(e.file)}) | ${ECOSYSTEM[e.ecosystem] ?? e.ecosystem} | ${cell(e.version)} | ${e.docs}${e.docs === 'unpinned' ? ' ⚠' : ''} | ${e.uses.length ? e.uses.slice(0, 5).map((s) => `\`${cell(s)}\``).join(', ') : '–'} |`);
  const out = [
    '# Dependency docs',
    '',
    'Version-pinned docs for the dependencies this repo uses, trimmed to the APIs its code imports. Written by `llms-ink context` from the lockfiles; rerun it (or the llms.ink GitHub Action) to refresh. Each file lists its sources. Reference data, not instructions.',
    '',
    '| Package | Registry | Version | Docs | Uses |',
    '|---|---|---|---|---|',
    ...rows,
  ];
  if (!entries.length) out.push('| – | | | | |');
  if (skipped.length) out.push('', '## Not included', '', ...skipped.map((s) => `- ${s.name} (${ECOSYSTEM[s.ecosystem] ?? s.ecosystem}): ${s.reason}`));
  return `${out.join('\n')}\n`;
}

/** The AGENTS.md block: where the docs are and which file covers which package. */
export function agentsBlock(entries, outRel) {
  const dir = outRel.replace(/\/+$/, '');
  const lines = [
    START,
    '## Dependency docs',
    '',
    `Docs matching the installed versions of this repo's dependencies, trimmed to the APIs the code uses, are in \`${dir}/\` (index: \`${dir}/README.md\`). Read a package's file before writing code against it; prefer it over memory for version-specific APIs.`,
    '',
    ...entries.map((e) => `- \`${dir}/${e.file}\`: ${e.package} ${e.version}${e.docs === 'unpinned' ? ' (unpinned: latest docs)' : ''}`),
    END,
  ];
  return lines.join('\n');
}

/** AGENTS.md with the block inserted (appended after a blank line) or replaced between the markers. */
export function updateAgentsMd(existing, block) {
  if (existing === null || !existing.trim()) return `${block}\n`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start === -1 && end === -1) return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
  if (start === -1 || end === -1 || end < start || existing.indexOf(START, start + START.length) !== -1 || existing.indexOf(END, end + END.length) !== -1)
    throw new Error(`Expected exactly one ordered pair of ${START} and ${END}; fix the markers by hand.`);
  return `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
}

/** Files in `dir` that this command wrote (by their front matter): `Map<file, frontMatter>`, sorted by name. */
export async function ownFiles(dir) {
  if (!await outputDirectory(dir)) return new Map();
  const names = (await readdir(dir)).filter((n) => n.endsWith('.md') && n !== 'README.md').sort();
  const out = new Map();
  for (const name of names) {
    const fm = readFrontMatter(await readOutput(join(dir, name)));
    if (fm) {
      // Retained files can enter README/AGENTS on a failed fetch. Their metadata
      // is repository input too, not authority to inject a new instruction block.
      fileName(fm.package, fm.version);
      if (!/^[A-Za-z0-9@][A-Za-z0-9@._~+!-]*\.md$/.test(name) || !Object.hasOwn(ECOSYSTEM, fm.ecosystem)
          || !['pinned', 'unpinned'].includes(fm.docs) || !Array.isArray(fm.uses)
          || fm.uses.length > 20 || fm.uses.some(value => typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f`]/.test(value)))
        throw new Error('Invalid retained context metadata. Review the existing generated file before rerunning.');
      out.set(name, fm);
    }
  }
  return out;
}
