// Version-matched docs for a package: registry metadata for that version, then the repo at the release tag, else latest.

/** npm-style repository fields (git+https, git@, shorthands) → a browsable https URL without .git. */
export function repositoryUrl(repository) {
  let raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  raw = raw.trim();
  const short = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(raw);
  if (short) raw = `https://${{ gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[short[1]] ?? 'github.com'}/${short[2]}`;
  raw = raw.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@([^/:]+)(?::\d+)?\//, 'https://$1/').replace(/^git@([^:]+):/, 'https://$1/');
  return raw.replace(/\.git(?=$|[#?/])/, '').replace(/[#?].*$/, '').replace(/\/+$/, '');
}

/** `{ owner, repo }` for a github.com URL (any page in it), else null. */
export function githubRepo(url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i.exec(url ?? '');
  return m ? { owner: m[1], repo: m[2] } : null;
}

const isHttp = (u) => typeof u === 'string' && /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(u.trim());

/** A docs URL that names the version in its path (`/v1.2.3/`, `/1.2.3/`, `@1.2.3`). */
export const namesVersion = (url, version) => new RegExp(`[/@=]v?${version.replace(/[.+]/g, '\\$&')}(?:[/#?]|$)`).test(url);

/** Release tag names to try for `version`, most common first. */
export function tagCandidates(name, version) {
  const base = name.split('/').at(-1);
  return [...new Set([`v${version}`, version, `${name}@${version}`, `${base}@${version}`, `${name}-v${version}`, `${base}-v${version}`, `${name}-${version}`, `${base}-${version}`, `release-${version}`, `${name}/v${version}`])];
}

/** Tags of a GitHub repo (`tag → commit`) from git's smart-HTTP ref list (no API rate limit), or null. */
export async function githubTags(http, { owner, repo }) {
  const text = await http.text(`https://github.com/${owner}/${repo}.git/info/refs?service=git-upload-pack`);
  if (!text) return null;
  const tags = new Map();
  for (const m of text.matchAll(/([0-9a-f]{40}) refs\/tags\/([^\s^]+)(\^\{\})?/g)) if (m[3] || !tags.has(m[2])) tags.set(m[2], m[1]);
  return tags;
}

/** GitHub tree URL at `ref` (a tag without slashes, else the commit), plus a sub-folder. */
const treeUrl = ({ owner, repo }, ref, dir) => `https://github.com/${owner}/${repo}/tree/${ref}${dir ? `/${dir.replace(/^\/+|\/+$/g, '')}` : ''}`;

/** The repo at the release: a matching tag (or the publish commit npm records), else null. */
async function repoAtVersion(http, repoUrl, name, version, { dir = '', commit = null } = {}) {
  const gh = githubRepo(repoUrl);
  if (!gh) return null;
  const tags = await githubTags(http, gh);
  const tag = tags && tagCandidates(name, version).find((t) => tags.has(t));
  if (tag) return { url: treeUrl(gh, tag.includes('/') ? tags.get(tag) : tag, dir), how: `repo at tag ${tag}` };
  if (commit && /^[0-9a-f]{40}$/.test(commit)) return { url: treeUrl(gh, commit, dir), how: `repo at commit ${commit.slice(0, 7)} (published ${version})` };
  return null;
}

const npmPath = (name) => name.replace('/', '%2F');

/**
 * Where to read `dep`'s docs for `dep.version`:
 * `{ url, pinned, how, registry, note? }`, or `{ skip: reason }` when the registry doesn't know the package or it has no public URL.
 * `http`: `{ json(url) → object|null (404), text(url) → string|null, ok(url) → boolean }`.
 */
export async function findDocs(dep, http) {
  const { ecosystem, name, version } = dep;
  if (ecosystem === 'go') {
    const escaped = name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
    const registry = `https://proxy.golang.org/${escaped}/@v/${version}.info`;
    if (!(await http.json(registry))) return { skip: 'not in the public Go module proxy (private module?)' };
    return { url: `https://pkg.go.dev/${name}@${version}`, pinned: true, how: 'pkg.go.dev at this version', registry };
  }
  if (ecosystem === 'crates') {
    const registry = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ''}`;
    const meta = await http.json(registry);
    if (!meta) return { skip: version ? `${name} ${version} isn’t on crates.io` : 'not on crates.io' };
    if (!version) return { url: `https://docs.rs/${name}/latest`, pinned: false, how: 'docs.rs, latest', registry, note: 'no Cargo.lock entry or exact version' };
    return { url: `https://docs.rs/${name}/${version}`, pinned: true, how: 'docs.rs at this version', registry };
  }

  let registry;
  let meta;
  let docs = [];
  let repo = null;
  let dir = '';
  let commit = null;
  if (ecosystem === 'npm') {
    registry = `https://registry.npmjs.org/${npmPath(name)}/${version ?? 'latest'}`;
    meta = await http.json(registry);
    if (!meta && version) {
      registry = `https://registry.npmjs.org/${npmPath(name)}/latest`;
      meta = await http.json(registry);
      if (meta) meta.unpublished = true;
    }
    if (!meta) return { skip: 'not on the npm registry' };
    repo = repositoryUrl(meta.repository);
    dir = typeof meta.repository === 'object' && typeof meta.repository?.directory === 'string' ? meta.repository.directory : '';
    commit = typeof meta.gitHead === 'string' ? meta.gitHead : null;
    docs = [meta.homepage];
  } else {
    registry = `https://pypi.org/pypi/${encodeURIComponent(name)}/${version ? `${encodeURIComponent(version)}/` : ''}json`;
    meta = await http.json(registry);
    if (!meta && version) {
      registry = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
      meta = await http.json(registry);
      if (meta) meta.unpublished = true;
    }
    const info = meta?.info;
    if (!info) return { skip: 'not on PyPI' };
    const urls = Object.entries(info.project_urls ?? {}).filter(([, u]) => isHttp(u));
    const pick = (re) => urls.filter(([label]) => re.test(label)).map(([, u]) => u);
    docs = [...pick(/doc/i), ...pick(/^home\s*-?\s*page$|^home$/i), info.home_page];
    repo = [...pick(/source|repo|code|github|gitlab/i), ...urls.map(([, u]) => u)].find((u) => githubRepo(u)) ?? null;
  }
  docs = [...new Set(docs.filter(isHttp).map((u) => u.trim()))];
  const pinnedVersion = version && !meta.unpublished ? version : null;
  if (pinnedVersion) {
    const versioned = docs.find((u) => !githubRepo(u) && namesVersion(u, pinnedVersion));
    if (versioned) return { url: versioned, pinned: true, how: 'versioned docs', registry };
    // Read the Docs builds per-version docs at /en/<version>/ when the project enables it.
    for (const u of docs.filter((d) => /^https?:\/\/[^/]+\.readthedocs\.io(?:\/|$)/i.test(d))) {
      const host = new URL(u).origin;
      for (const v of [pinnedVersion, `v${pinnedVersion}`]) if (await http.ok(`${host}/en/${v}/`)) return { url: `${host}/en/${v}/`, pinned: true, how: 'versioned docs (Read the Docs)', registry };
    }
    const atTag = repo && (await repoAtVersion(http, repo, name, pinnedVersion, { dir, commit }));
    if (atTag) return { url: atTag.url, pinned: true, how: atTag.how, registry };
  }
  const why = !version ? 'no lockfile entry or exact version' : meta.unpublished ? `${version} isn’t in the registry` : `no versioned docs or release tag for ${version}`;
  const latest = docs.find((u) => !githubRepo(u)) ?? (repo && githubRepo(repo) ? (dir ? treeUrl(githubRepo(repo), 'HEAD', dir) : repo) : docs[0] ?? repo);
  if (!latest || !isHttp(latest)) return { skip: 'no public docs or repository URL in the registry metadata' };
  return { url: latest, pinned: false, how: 'latest docs', registry, note: why };
}
