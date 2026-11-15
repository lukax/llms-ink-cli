import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { main } from '../src/cli.js';
import { cargoLockVersions, lockPackages, npmLockVersions, pnpmLockVersions, resolveVersions, yarnLockVersions } from '../src/context/lockfiles.js';
import { parseManifest } from '../src/context/manifests.js';
import { END, START, agentsBlock, fileName, frontMatter, readFrontMatter, updateAgentsMd } from '../src/context/output.js';
import { findDocs, namesVersion, repositoryUrl, tagCandidates } from '../src/context/registry.js';
import { goPackageName, scanGo, scanJs, scanPython, scanRust, usageOf } from '../src/context/scan.js';
import { pageTier, splitFull, symbolTest, trimDocs } from '../src/context/trim.js';

const API = 'https://api.test';

/* ---------- a stand-in for the registries, GitHub's ref list and the llms.ink API ---------- */

const sha = (c) => c.repeat(40);
const refs = (tags) => `001e# service=git-upload-pack\n0000${Object.entries(tags).map(([t, s]) => `003f${s} refs/tags/${t}\n`).join('')}0000`;

/** llms-full.txt the way llms.ink builds it for a repo: index, then `---` + title + Source per page. */
function full(title, pages) {
  const index = `# ${title}\n\n> Generated summary ${Math.random()}\n\n## Docs\n\n${pages.map((p) => `- [${p.title}](${p.url}): generated note ${Math.random()}`).join('\n')}`;
  return [index, ...pages.map((p) => `---\n\n# ${p.title}\n\nSource: ${p.url}\n\n${p.body}`)].join('\n\n') + '\n';
}

const ZOD_PAGES = [
  { title: 'README', url: 'https://raw.githubusercontent.com/colinhacks/zod/v3.23.8/README.md', body: 'Zod is a schema library.\n\n## Basic usage\n\nCall `z.object({ name: z.string() })` to build a schema.\n\n## Errors\n\nParsing throws a ZodError with issues.\n\n```ts\n# not a heading inside code\nconst x = 1;\n```\n\n## Promises\n\nUnrelated text about promise schemas.' },
  { title: 'Changelog', url: 'https://raw.githubusercontent.com/colinhacks/zod/v3.23.8/CHANGELOG.md', body: '## 3.23.8\n\nFixed a bug in unions.' },
];
const ZOD_DOCS = full('colinhacks/zod', ZOD_PAGES);
/** A generated result rebuilt on every request: new summary wording and page order, same pages. */
const zodDocs = () => full('colinhacks/zod', Math.random() < 0.5 ? ZOD_PAGES : [...ZOD_PAGES].reverse());

function makeWorld() {
  const requests = [];
  const llms = new Map();
  const routes = new Map();
  const world = {
    requests,
    llms,
    routes,
    failLlms: new Set(),
    fetch: async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, method: init.method ?? 'GET', auth: init.headers?.authorization ?? null });
      if (url.startsWith(`${API}/api/v0/llms?`)) {
        const q = new URL(url).searchParams;
        assert.equal(q.get('mode'), 'full');
        const target = q.get('url');
        if (world.failLlms.has(target) || world.failLlms.has('*')) return Response.json({ status: 429, code: 'quota_exceeded', detail: 'Daily limit reached (60 new links). Cached links still work.' }, { status: 429 });
        const text = llms.get(target);
        if (!text) return Response.json({ status: 422, detail: `Couldn’t read ${target}.` }, { status: 422 });
        return Response.json({ url: target, kind: 'repo', source: target.includes('native') ? 'native' : 'generated', mode: 'full', title: 'x', text: typeof text === 'function' ? text() : text, tokens: 1, pages: 2, model: null, cached: true, generatedAt: new Date().toISOString() });
      }
      const route = routes.get(`${init.method ?? 'GET'} ${url}`) ?? routes.get(url);
      if (route === undefined) return new Response('not found', { status: 404 });
      if (typeof route === 'string') return new Response(route, { status: 200 });
      if (typeof route === 'number') return new Response(null, { status: route });
      return Response.json(route);
    },
  };
  return world;
}

/** Registry answers for every fixture package. */
function seed(world) {
  const r = world.routes;
  // npm: zod has a v-tag; @acme/ui only a publish commit; left-pad has no repo tag and a homepage → unpinned.
  r.set('https://registry.npmjs.org/zod/3.23.8', { name: 'zod', version: '3.23.8', homepage: 'https://zod.dev', repository: { type: 'git', url: 'git+https://github.com/colinhacks/zod.git' }, gitHead: sha('a') });
  r.set('https://github.com/colinhacks/zod.git/info/refs?service=git-upload-pack', refs({ 'v3.23.7': sha('b'), 'v3.23.8': sha('a') }));
  r.set('https://registry.npmjs.org/zod/3.24.0', { name: 'zod', version: '3.24.0', homepage: 'https://zod.dev', repository: 'github:colinhacks/zod', gitHead: sha('c') });
  r.set('https://registry.npmjs.org/@acme%2Fui/2.0.1', { name: '@acme/ui', version: '2.0.1', repository: { url: 'https://github.com/acme/mono', directory: 'packages/ui' }, gitHead: sha('d') });
  r.set('https://github.com/acme/mono.git/info/refs?service=git-upload-pack', refs({ '@acme/ui@2.0.1': sha('d') }));
  r.set('https://registry.npmjs.org/left-pad/latest', { name: 'left-pad', version: '1.3.0', homepage: 'https://left-pad.example/docs' });
  // PyPI: requests via a repo tag (Read the Docs has no per-version build); httpx has versioned docs.
  r.set('https://pypi.org/pypi/requests/2.32.3/json', { info: { version: '2.32.3', project_urls: { Documentation: 'https://requests.readthedocs.io', Source: 'https://github.com/psf/requests', Changelog: 'https://github.com/psf/requests/blob/main/HISTORY.md' } } });
  r.set('https://github.com/psf/requests.git/info/refs?service=git-upload-pack', refs({ 'v2.32.3': sha('e') }));
  r.set('https://pypi.org/pypi/httpx/0.27.0/json', { info: { version: '0.27.0', project_urls: { Documentation: 'https://httpx.readthedocs.io' } } });
  r.set('HEAD https://httpx.readthedocs.io/en/0.27.0/', 200);
  r.set('https://pypi.org/pypi/pyyaml/6.0.1/json', { info: { version: '6.0.1', project_urls: { Homepage: 'https://pyyaml.org/' } } });
  // crates.io and the Go proxy.
  r.set('https://crates.io/api/v1/crates/serde/1.0.210', { version: { num: '1.0.210', repository: 'https://github.com/serde-rs/serde' } });
  r.set('https://crates.io/api/v1/crates/tokio/1.40.0', { version: { num: '1.40.0' } });
  r.set('https://proxy.golang.org/github.com/spf13/cobra/@v/v1.8.1.info', { Version: 'v1.8.1' });
  r.set('https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.4.0.info', { Version: 'v1.4.0' });

  world.llms.set('https://github.com/colinhacks/zod/tree/v3.23.8', zodDocs);
  world.llms.set(`https://github.com/acme/mono/tree/${sha('d')}/packages/ui`, full('acme/mono/packages/ui', [{ title: 'UI', url: 'https://raw.githubusercontent.com/acme/mono/x/packages/ui/README.md', body: 'Intro.\n\n## Button\n\nRender a Button with variants.\n\n## Theme\n\nNothing used here.' }]));
  world.llms.set('https://left-pad.example/docs', full('left-pad', [{ title: 'Docs', url: 'https://left-pad.example/docs/', body: 'Pads strings on the left.' }]));
  world.llms.set('https://github.com/psf/requests/tree/v2.32.3', full('psf/requests', [{ title: 'Quickstart', url: 'https://raw.githubusercontent.com/psf/requests/v2.32.3/docs/quickstart.rst', body: 'Intro.\n\n## Make a request\n\nUse requests.get(url) and check r.status_code.\n\n## Sessions\n\nA Session keeps cookies.\n\n## Proxies\n\nNot used.' }]));
  world.llms.set('https://httpx.readthedocs.io/en/0.27.0/', full('httpx', [{ title: 'Clients', url: 'https://httpx.readthedocs.io/en/0.27.0/advanced/clients/', body: '## Client instances\n\nUse httpx.Client for pooling.\n\n## Transports\n\nNot used.' }]));
  world.llms.set('https://pyyaml.org/', full('PyYAML', [{ title: 'Docs', url: 'https://pyyaml.org/wiki/PyYAMLDocumentation', body: '## Loading\n\nyaml.safe_load parses a document.\n\n## Dumping\n\nyaml.dump writes one.' }]));
  world.llms.set('https://docs.rs/serde/1.0.210', full('serde', [{ title: 'serde', url: 'https://docs.rs/serde/1.0.210/serde/', body: '## Derive\n\nDerive Serialize and Deserialize.\n\n## Data formats\n\nNot used.' }]));
  world.llms.set('https://docs.rs/tokio/1.40.0', full('tokio', [{ title: 'tokio', url: 'https://docs.rs/tokio/1.40.0/tokio/', body: '## Spawning\n\nUse tokio::spawn to run a task.\n\n## Sync\n\nA Mutex for async code.' }]));
  world.llms.set('https://pkg.go.dev/github.com/spf13/cobra@v1.8.1', full('cobra', [{ title: 'cobra', url: 'https://pkg.go.dev/github.com/spf13/cobra@v1.8.1', body: '## type Command\n\nCommand is a CLI command; call Execute.\n\n## func OnInitialize\n\nNot used.' }]));
  world.llms.set('https://pkg.go.dev/github.com/BurntSushi/toml@v1.4.0', full('toml', [{ title: 'toml', url: 'https://pkg.go.dev/github.com/BurntSushi/toml@v1.4.0', body: '## func DecodeFile\n\nDecodeFile reads a file.\n\n## type Encoder\n\nNot used.' }]));
}

/* ---------- fixture repos ---------- */

const FIXTURES = {
  npm: {
    'package.json': JSON.stringify({ name: 'app', dependencies: { zod: '^3.23.0', '@acme/ui': '^2.0.0', 'left-pad': '^1.3.0', local: 'file:../local' }, devDependencies: { typescript: '^5.0.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/zod': { version: '3.23.8' }, 'node_modules/@acme/ui': { version: '2.0.1' }, 'node_modules/typescript': { version: '5.6.3' } } }),
    'src/schema.ts': "import { z } from 'zod';\nimport type { ZodError } from 'zod';\nexport const User = z.object({ name: z.string() });\nexport type E = ZodError;\n",
    'src/form.tsx': "import { z } from 'zod';\nimport { Button } from '@acme/ui';\nexport const F = () => <Button>{z.string().parse('x')}</Button>;\n",
    'node_modules/zod/index.js': "import { nope } from 'nothing';\n",
  },
  python: {
    'pyproject.toml': '[project]\nname = "app"\ndependencies = ["requests>=2.31", "httpx", "PyYAML==6.0.1"]\n',
    'uv.lock': 'version = 1\n\n[[package]]\nname = "requests"\nversion = "2.32.3"\nsource = { registry = "https://pypi.org/simple" }\ndependencies = [\n    { name = "idna" },\n]\n\n[[package]]\nname = "httpx"\nversion = "0.27.0"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n',
    'app/main.py': 'import requests\nimport yaml\nfrom httpx import Client\n\nr = requests.get("https://x")\nsession = requests.Session()\nconfig = yaml.safe_load(open("c.yml"))\nwith Client() as c:\n    pass\n',
  },
  rust: {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\ntokio = "1.38"\n',
    'Cargo.lock': '[[package]]\nname = "serde"\nversion = "0.9.15"\n\n[[package]]\nname = "serde"\nversion = "1.0.210"\n\n[[package]]\nname = "tokio"\nversion = "1.40.0"\n',
    'src/main.rs': 'use serde::{Deserialize, Serialize};\n\n#[derive(Serialize, Deserialize)]\nstruct A;\n\n#[tokio::main]\nasync fn main() { tokio::spawn(async {}); }\n',
  },
  go: {
    'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/BurntSushi/toml v1.4.0\n\tgithub.com/spf13/cobra v1.8.1\n\tgithub.com/inconshreveable/mousetrap v1.1.0 // indirect\n)\n',
    'go.sum': 'github.com/spf13/cobra v1.8.1 h1:x\n',
    'main.go': 'package main\n\nimport (\n\t"github.com/BurntSushi/toml"\n\t"github.com/spf13/cobra"\n)\n\nfunc main() {\n\tcmd := &cobra.Command{}\n\t_ = cmd.Execute()\n\ttoml.DecodeFile("a", nil)\n}\n',
  },
};

let dir;
test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'llms-ink-context-')); });
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function fixture(files, at = dir) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(at, name)), { recursive: true });
    await writeFile(join(at, name), text);
  }
}

function capture() {
  const chunks = [];
  const stream = new Writable({ write(chunk, _enc, done) { chunks.push(Buffer.from(chunk)); done(); } });
  Object.defineProperty(stream, 'text', { get: () => Buffer.concat(chunks).toString() });
  return stream;
}

async function context(world, args = [], env = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main({ argv: ['context', ...args], env: { LLMS_INK_API: API, ...env }, cwd: dir, stdout, stderr, fetch: world.fetch });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

async function snapshot(root) {
  const out = {};
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      if (e.isDirectory()) await walk(join(d, e.name));
      else out[join(d, e.name).slice(root.length + 1)] = await readFile(join(d, e.name), 'utf8');
    }
  };
  await walk(root);
  return out;
}

/* ---------- manifests and lockfiles ---------- */

test('manifests: direct dependencies with specs, aliases, renames and skips', () => {
  const npm = parseManifest('package.json', JSON.stringify({ workspaces: ['packages/*'], dependencies: { zod: '^3', str: 'npm:string-width@^4', loc: 'file:../x', gh: 'user/repo' }, devDependencies: { zod: '^3' } }));
  assert.deepEqual(npm.deps.map((d) => [d.name, d.importAs, d.spec, d.group]), [['zod', 'zod', '^3', 'runtime'], ['string-width', 'str', 'npm:string-width@^4', 'runtime']]);
  assert.deepEqual(npm.skipped.map((s) => s.name), ['loc', 'gh']);
  assert.equal(npm.workspace, true);
  const py = parseManifest('pyproject.toml', '[project]\ndependencies = ["Requests[socks]==2.32.3 ; python_version>\'3.8\'", "pkg @ https://x/y.whl"]\n[tool.poetry.dependencies]\npython = "^3.11"\nFlask_Login = "^0.6"\n');
  assert.deepEqual(py.deps.map((d) => [d.name, d.group]), [['requests', 'runtime'], ['flask-login', 'runtime']]);
  assert.match(py.deps[0].spec, /==2\.32\.3/);
  assert.deepEqual(py.skipped.map((s) => s.name), ['pkg']);
  const req = parseManifest('requirements-dev.txt', '-r base.txt\nrich==13.7.1 --hash=sha256:abc\n./local\n# comment\n');
  assert.deepEqual(req.deps.map((d) => [d.name, d.spec]), [['rich', '==13.7.1']]);
  const cargo = parseManifest('Cargo.toml', '[dependencies]\nserde_json = "1"\nmy_tokio = { package = "tokio", version = "1" }\nlocal = { path = "../l" }\n[target.\'cfg(unix)\'.dependencies]\nlibc = "0.2"\n');
  assert.deepEqual(cargo.deps.map((d) => [d.name, d.importAs, d.spec]), [['serde_json', 'serde_json', '1'], ['tokio', 'my_tokio', '1'], ['libc', 'libc', '0.2']]);
  const go = parseManifest('go.mod', 'module x\n\nrequire github.com/a/b v1.0.0\nrequire (\n\tgithub.com/c/d v2.1.0+incompatible\n\tgithub.com/e/f v0.1.0 // indirect\n\tgithub.com/g/h v1.0.0\n)\nreplace github.com/g/h => ../h\nreplace github.com/a/b v1.0.0 => github.com/fork/b v1.0.1\n');
  assert.deepEqual(go.deps.map((d) => [d.name, d.importAs, d.spec]), [['github.com/fork/b', 'github.com/a/b', 'v1.0.1'], ['github.com/c/d', 'github.com/c/d', 'v2.1.0+incompatible']]);
  assert.deepEqual(go.skipped.map((s) => s.name), ['github.com/g/h']);
  assert.throws(() => parseManifest('setup.py', ''), /Unsupported manifest/);
});

test('lockfiles: npm, pnpm, yarn, Cargo and Python locks', async () => {
  const npm = npmLockVersions(JSON.stringify({ packages: { 'node_modules/a': { version: '1.0.0' }, 'apps/web/node_modules/a': { version: '2.0.0' }, 'node_modules/l': { version: 'file:../l' } } }), 'apps/web');
  assert.equal(npm('a'), '2.0.0');
  assert.equal(npm('l'), null);
  assert.equal(npmLockVersions(JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '0.1.0' } } }))('a'), '0.1.0');

  const pnpm9 = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      zod:\n        specifier: ^3.23.0\n        version: 3.23.8\n      '@astrojs/check':\n        specifier: ^0.9.0\n        version: 0.9.4(typescript@5.6.3)\n      str:\n        specifier: npm:string-width@^4\n        version: string-width@4.2.3\n  packages/web:\n    devDependencies:\n      vite:\n        specifier: ^5\n        version: 5.4.0\n      ui:\n        specifier: workspace:*\n        version: link:../ui\n\npackages:\n\n  zod@3.23.8:\n    resolution: {integrity: sha512-x}\n";
  const root = pnpmLockVersions(pnpm9);
  assert.deepEqual([root('zod'), root('@astrojs/check'), root('str'), root('vite')], ['3.23.8', '0.9.4', '4.2.3', null]);
  const web = pnpmLockVersions(pnpm9, 'packages/web');
  assert.deepEqual([web('vite'), web('ui')], ['5.4.0', null]);
  assert.equal(pnpmLockVersions('lockfileVersion: 5.4\n\nspecifiers:\n  react: ^18.0.0\n\ndependencies:\n  react: 18.2.0_abc\n')('react'), '18.2.0');

  const classic = '# yarn lockfile v1\n\n"zod@^3.20.0", zod@^3.23.0:\n  version "3.23.8"\n  resolved "https://x"\n\nzod@^2.0.0:\n  version "2.1.0"\n\nleft-pad@^1.0.0:\n  version "1.3.0"\n';
  assert.deepEqual([yarnLockVersions(classic)('zod', '^3.23.0'), yarnLockVersions(classic)('zod', '^2.0.0'), yarnLockVersions(classic)('zod', '^9'), yarnLockVersions(classic)('left-pad', null)], ['3.23.8', '2.1.0', null, '1.3.0']);
  const berry = '__metadata:\n  version: 8\n\n"zod@npm:^3.23.0, zod@npm:^3.22.0":\n  version: 3.23.8\n  resolution: "zod@npm:3.23.8"\n';
  assert.equal(yarnLockVersions(berry)('zod', '^3.22.0'), '3.23.8');

  const cargo = cargoLockVersions('[[package]]\nname = "rand"\nversion = "0.7.3"\n\n[[package]]\nname = "rand"\nversion = "0.8.5"\n\n[[package]]\nname = "syn"\nversion = "1.0.109"\n\n[[package]]\nname = "syn"\nversion = "2.0.77"\n');
  assert.deepEqual([cargo('rand', '0.7'), cargo('rand', '0.8.1'), cargo('syn', '1'), cargo('syn', null), cargo('nope', '1')], ['0.7.3', '0.8.5', '1.0.109', '2.0.77', null]);
  assert.deepEqual(lockPackages('[[package]]\nname = "a"\nversion = "1"\n[package.dependencies]\nversion = "9"\n\n[metadata]\nname = "x"\n'), [{ name: 'a', version: '1' }]);

  // Resolution walks up to the workspace root's lock; manifest pins and requirements pins fill the gaps.
  await fixture({ 'package-lock.json': JSON.stringify({ packages: { 'node_modules/a': { version: '1.2.3' } } }), 'apps/web/package.json': '{}', 'py/requirements.txt': 'b==2.0.0\n', 'py/pyproject.toml': '' });
  const member = await resolveVersions(join(dir, 'apps/web/package.json'), [{ ecosystem: 'npm', name: 'a', importAs: 'a', spec: '^1' }, { ecosystem: 'npm', name: 'c', importAs: 'c', spec: '4.0.0' }, { ecosystem: 'npm', name: 'd', importAs: 'd', spec: '^4' }], dir);
  assert.deepEqual(member.map((d) => [d.version, d.versionFrom]), [['1.2.3', 'package-lock.json'], ['4.0.0', 'apps/web/package.json'], [null, null]]);
  const py = await resolveVersions(join(dir, 'py/pyproject.toml'), [{ ecosystem: 'pypi', name: 'b', importAs: 'b', spec: '>=2' }], dir);
  assert.deepEqual(py.map((d) => [d.version, d.versionFrom]), [['2.0.0', 'py/requirements.txt']]);
});

/* ---------- source scanning ---------- */

test('scan: JS/TS imports, requires, re-exports and the members used', () => {
  const found = scanJs(`
    import express, { Router as R } from 'express';
    import * as React from 'react';
    import type { Props } from '@scope/ui/button';
    import './side-effect.css';
    import 'reflect-metadata';
    export { helper } from 'utils-lib';
    const { readFile } = require('fs-extra');
    const lodash = require('lodash');
    // import { Commented } from 'commented';
    const app = express(); express.static('x'); React.useState(); lodash.debounce(f); R(); run('express.notUsed', \`lodash.nope\`);
    const m = await import('dyn-pkg');
    import { foo } from 'node:fs'; import x from './local.js';
  `);
  assert.deepEqual([...found.keys()].sort(), ['@scope/ui', 'express', 'fs-extra', 'lodash', 'react', 'reflect-metadata', 'utils-lib', 'dyn-pkg'].sort());
  assert.deepEqual([...found.get('express')].sort(), ['Router', 'express.static']);
  assert.deepEqual([...found.get('react')], ['React.useState']);
  assert.deepEqual([...found.get('@scope/ui')].sort(), ['@scope/ui/button', 'Props']);
  assert.deepEqual([...found.get('lodash')], ['lodash.debounce']);
  assert.deepEqual([...found.get('fs-extra')], ['readFile']);
});

test('scan: Python, Rust and Go imports and the names used', () => {
  const py = scanPython('import numpy as np, os\nfrom requests.adapters import (\n    HTTPAdapter,\n    Retry as R,\n)\nfrom . import local\nimport google.protobuf.json_format\n# import commented\nnp.array([1]); R.total\n');
  assert.deepEqual([...py.get('numpy')], ['np.array']);
  assert.deepEqual([...py.get('requests')].sort(), ['HTTPAdapter', 'Retry', 'Retry.total', 'requests.adapters']);
  assert.ok(py.has('requests.adapters') && py.has('google.protobuf') && !py.has('commented'));
  const rs = scanRust('use serde::{Deserialize, Serialize as S};\nuse tokio::sync::{mpsc, Mutex};\nextern crate log;\nfn f() { let x = serde_json::to_string(&y); std::mem::drop(x); let s = "a::b"; }\n');
  assert.deepEqual([...rs.get('serde')].sort(), ['Deserialize', 'Serialize']);
  assert.deepEqual([...rs.get('tokio')].sort(), ['Mutex', 'mpsc', 'sync']);
  assert.deepEqual([...rs.get('serde_json')], ['to_string']);
  assert.ok(rs.has('log') && !rs.has('std') && !rs.has('a'));
  const go = scanGo('package x\nimport (\n\ty "gopkg.in/yaml.v3"\n\t"github.com/spf13/cobra"\n\t_ "github.com/lib/pq"\n\t"fmt"\n)\nimport "github.com/go-chi/chi/v5"\nfunc f() { y.Unmarshal(b, &v); cobra.Command{}; chi.NewRouter(); fmt.Println() }\n');
  assert.deepEqual([...go.get('gopkg.in/yaml.v3')], ['y.Unmarshal']);
  assert.deepEqual([...go.get('github.com/spf13/cobra')], ['cobra.Command']);
  assert.deepEqual([...go.get('github.com/go-chi/chi/v5')], ['chi.NewRouter']);
  assert.deepEqual([...go.get('github.com/lib/pq')], []);
  assert.deepEqual(['gopkg.in/yaml.v3', 'github.com/go-chi/chi/v5', 'github.com/mattn/go-sqlite3', 'github.com/x/client-go'].map(goPackageName), ['yaml', 'chi', 'sqlite3', 'client']);
  // A dependency's usage merges its import keys: Python distribution → module path, Go module → its packages.
  const usage = new Map([['llama_index', { files: 3, symbols: new Map([['A', 3]]) }], ['llama_index.core', { files: 2, symbols: new Map([['Document', 2], ['BaseReader', 1]]) }], ['yaml', { files: 1, symbols: new Map([['yaml.safe_load', 1]]) }]]);
  assert.deepEqual(usageOf({ ecosystem: 'pypi', name: 'llama-index-core' }, usage), { files: 2, symbols: ['Document', 'BaseReader'] });
  assert.deepEqual(usageOf({ ecosystem: 'pypi', name: 'pyyaml' }, usage), { files: 1, symbols: ['yaml.safe_load'] });
  const goUsage = new Map([['github.com/a/b', { files: 1, symbols: new Map([['b.X', 1]]) }], ['github.com/a/b/sub', { files: 2, symbols: new Map([['sub.Y', 2]]) }], ['github.com/a/bc', { files: 5, symbols: new Map() }]]);
  assert.deepEqual(usageOf({ ecosystem: 'go', name: 'github.com/a/b', importAs: 'github.com/a/b' }, goUsage), { files: 3, symbols: ['sub.Y', 'b.X'] });
});

/* ---------- trimming ---------- */

test('trim: keeps the index and the sections that mention used symbols, within the budget', () => {
  const { index, pages } = splitFull(ZOD_DOCS);
  assert.match(index, /^# colinhacks\/zod/);
  assert.deepEqual(pages.map((p) => [p.title, p.sections.map((s) => s.heading)]), [['README', [null, 'Basic usage', 'Errors', 'Promises']], ['Changelog', ['3.23.8']]]);
  const t = trimDocs(ZOD_DOCS, { symbols: ['z.object', 'z.string', 'ZodError', 'z'] });
  assert.match(t.text, /^## Pages\n\n- \[Changelog\]\(https:\/\/raw\.githubusercontent\.com\/colinhacks\/zod\/v3\.23\.8\/CHANGELOG\.md\)\n- \[README\]/);
  assert.match(t.text, /## Basic usage/);
  assert.match(t.text, /## Errors[\s\S]*# not a heading inside code/);
  assert.doesNotMatch(t.text, /Promises|Generated summary|generated note|Fixed a bug/);
  assert.deepEqual([t.kept, t.matching, t.total], [2, 2, 5]);
  assert.deepEqual(t.matched, ['z.object', 'z.string', 'ZodError']);
  // Under a tight budget the sections matching the most symbols win; a native index is kept as written.
  const native = '# Lib\n\n> Own llms.txt\n\n- [A](https://x/a)\n\n---\n\nSource: https://x/a\n\n# A\n\n## One\n\nalpha beta\n\n## Two\n\nalpha only ' + 'x'.repeat(4000) + '\n';
  const tight = trimDocs(native, { symbols: ['alpha', 'beta'], maxTokens: 500, native: true });
  assert.match(tight.text, /^# Lib\n\n> Own llms.txt/);
  assert.match(tight.text, /## One/);
  assert.doesNotMatch(tight.text, /## Two/);
  // No symbols: the start of the docs, up to the budget.
  const start = trimDocs(ZOD_DOCS, { symbols: [], maxTokens: 500 });
  assert.match(start.text, /Zod is a schema library/);
  assert.ok(start.tokens <= 520);
  // Docs pages win over changelogs that mention the same names.
  const withLog = full('lib', [{ title: 'Changelog', url: 'https://x/CHANGELOG.md', body: '## 2.0.0\n\nRenamed makeThing and useThing.' }, { title: 'Guide', url: 'https://x/docs/guide.md', body: '## Making things\n\nCall makeThing() once. ' + 'y'.repeat(2560) }]);
  const docsFirst = trimDocs(withLog, { symbols: ['makeThing', 'useThing'], maxTokens: 700 });
  assert.match(docsFirst.text, /## Making things/);
  assert.doesNotMatch(docsFirst.text, /Renamed/);
  assert.ok(docsFirst.tokens <= 700, `${docsFirst.tokens}`);
  assert.deepEqual(['CHANGELOG.md', 'HISTORY.rst', 'CHANGELOG-2023.md', 'Contributing.md', 'docs/guide.md', 'README.md'].map((f) => pageTier({ source: `https://x/${f}` })), [2, 2, 2, 1, 0, 0]);
  assert.ok(symbolTest('z.object')('use z.object('));
  assert.ok(symbolTest('requests.Session')('A Session keeps cookies'));
  assert.ok(!symbolTest('np.get')('get it'));
  assert.ok(!symbolTest('z')('z is here'));
});

/* ---------- docs sources ---------- */

test('docs: versioned registry docs, then the repo at the tag, else latest marked unpinned', async () => {
  const world = makeWorld();
  seed(world);
  const http = (await import('../src/context/index.js')).registryHttp(world.fetch);
  const find = (dep) => findDocs(dep, http);
  assert.deepEqual(await find({ ecosystem: 'npm', name: 'zod', version: '3.23.8' }), { url: 'https://github.com/colinhacks/zod/tree/v3.23.8', pinned: true, how: 'repo at tag v3.23.8', registry: 'https://registry.npmjs.org/zod/3.23.8' });
  // A tag with a slash in it (or only a publish commit) → the commit, keeping the package folder.
  assert.equal((await find({ ecosystem: 'npm', name: '@acme/ui', version: '2.0.1' })).url, `https://github.com/acme/mono/tree/${sha('d')}/packages/ui`);
  const noTag = await find({ ecosystem: 'npm', name: 'zod', version: '3.24.0' });
  assert.deepEqual([noTag.url, noTag.pinned, noTag.how], [`https://github.com/colinhacks/zod/tree/${sha('c')}`, true, `repo at commit ${sha('c').slice(0, 7)} (published 3.24.0)`]);
  assert.deepEqual(await find({ ecosystem: 'npm', name: 'left-pad', version: null }), { url: 'https://left-pad.example/docs', pinned: false, how: 'latest docs', registry: 'https://registry.npmjs.org/left-pad/latest', note: 'no lockfile entry or exact version' });
  assert.deepEqual(await find({ ecosystem: 'npm', name: 'missing', version: '1.0.0' }), { skip: 'not on the npm registry' });
  assert.equal((await find({ ecosystem: 'pypi', name: 'httpx', version: '0.27.0' })).url, 'https://httpx.readthedocs.io/en/0.27.0/');
  assert.equal((await find({ ecosystem: 'pypi', name: 'requests', version: '2.32.3' })).url, 'https://github.com/psf/requests/tree/v2.32.3');
  const yaml = await find({ ecosystem: 'pypi', name: 'pyyaml', version: '6.0.1' });
  assert.deepEqual([yaml.url, yaml.pinned, yaml.note], ['https://pyyaml.org/', false, 'no versioned docs or release tag for 6.0.1']);
  assert.deepEqual(await find({ ecosystem: 'crates', name: 'serde', version: '1.0.210' }), { url: 'https://docs.rs/serde/1.0.210', pinned: true, how: 'docs.rs at this version', registry: 'https://crates.io/api/v1/crates/serde/1.0.210' });
  assert.equal((await find({ ecosystem: 'go', name: 'github.com/BurntSushi/toml', version: 'v1.4.0' })).url, 'https://pkg.go.dev/github.com/BurntSushi/toml@v1.4.0');
  assert.deepEqual(await find({ ecosystem: 'go', name: 'github.com/acme/private', version: 'v1.0.0' }), { skip: 'not in the public Go module proxy (private module?)' });
  assert.equal(repositoryUrl('git+ssh://git@github.com/a/b.git'), 'https://github.com/a/b');
  assert.equal(repositoryUrl({ url: 'git@github.com:a/b.git' }), 'https://github.com/a/b');
  assert.ok(namesVersion('https://docs.x.dev/v1.2.3/', '1.2.3') && !namesVersion('https://docs.x.dev/v1.2.30/', '1.2.3'));
  assert.deepEqual(tagCandidates('@s/p', '1.0.0').slice(0, 4), ['v1.0.0', '1.0.0', '@s/p@1.0.0', 'p@1.0.0']);
  // Registry lookups are cached for the run: one info/refs read for two zod versions.
  assert.equal(world.requests.filter((r) => r.url.includes('colinhacks/zod.git')).length, 1);
});

/* ---------- output files ---------- */

test('AGENTS.md block: created, appended once, replaced in place, malformed markers refused', () => {
  const block = agentsBlock([{ file: 'zod@3.23.8.md', package: 'zod', version: '3.23.8', docs: 'pinned' }, { file: 'x@latest.md', package: 'x', version: 'unresolved', docs: 'unpinned' }], '.context');
  assert.match(block, /^<!-- llms-ink:context:start -->\n## Dependency docs\n/);
  assert.match(block, /- `\.context\/zod@3\.23\.8\.md`: zod 3\.23\.8\n- `\.context\/x@latest\.md`: x unresolved \(unpinned: latest docs\)\n<!-- llms-ink:context:end -->$/);
  assert.equal(updateAgentsMd(null, block), `${block}\n`);
  const appended = updateAgentsMd('# Rules\n\nBe brief.\n\n\n', block);
  assert.equal(appended, `# Rules\n\nBe brief.\n\n${block}\n`);
  const next = agentsBlock([], '.context');
  const replaced = updateAgentsMd(`${appended}\n## After\n\nKeep me.\n`, next);
  assert.equal(replaced, `# Rules\n\nBe brief.\n\n${next}\n\n## After\n\nKeep me.\n`);
  assert.equal(updateAgentsMd(replaced, next), replaced);
  assert.throws(() => updateAgentsMd(`x\n${START}\nno end`, block), /exactly one ordered pair/);
  assert.throws(() => updateAgentsMd(`${END}\n${START}`, block), /exactly one ordered pair/);
});

test('front matter round-trips and file names are safe', () => {
  const fm = frontMatter({ package: '@a/b', version: '1.0.0', note: 'no tag: latest', empty: [], sources: ['https://x/y?z=1', 'yes'], tokens: 12, generator: 'llms-ink context' });
  assert.equal(fm, '---\npackage: "@a/b"\nversion: 1.0.0\nnote: "no tag: latest"\nempty: []\nsources:\n  - https://x/y?z=1\n  - "yes"\ntokens: 12\ngenerator: llms-ink context\n---');
  assert.deepEqual(readFrontMatter(`${fm}\n\nbody`), { package: '@a/b', version: '1.0.0', note: 'no tag: latest', empty: [], sources: ['https://x/y?z=1', 'yes'], tokens: '12', generator: 'llms-ink context' });
  assert.equal(readFrontMatter('---\npackage: x\n---\n'), null);
  assert.deepEqual([fileName('@acme/ui', '2.0.1'), fileName('github.com/a/b', 'v1.0.0'), fileName('x', null)], ['@acme__ui@2.0.1.md', 'github.com__a__b@v1.0.0.md', 'x@latest.md']);
});

/* ---------- the command, end to end against the stand-ins ---------- */

test('context: npm fixture → pinned files trimmed to the imports, README, AGENTS.md block', async () => {
  const world = makeWorld();
  seed(world);
  await fixture(FIXTURES.npm);
  await writeFile(join(dir, 'AGENTS.md'), '# Agents\n\nUse tabs.\n');
  const r = await context(world, ['--quiet'], { LLMS_INK_KEY: 'lk_test' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.stdout.trim().split('\n').map((l) => l.replace(/\s+\(.*$/, '').split(/\s+/)), [
    ['created', '.context/zod@3.23.8.md'], ['created', '.context/@acme__ui@2.0.1.md'], ['created', '.context/left-pad@latest.md'], ['created', '.context/README.md'], ['updated', 'AGENTS.md'],
  ]);
  const zod = await readFile(join(dir, '.context/zod@3.23.8.md'), 'utf8');
  assert.match(zod, /^---\npackage: zod\necosystem: npm\nversion: 3\.23\.8\nversion-from: package-lock\.json\ndocs: pinned\nsources:\n {2}- https:\/\/github\.com\/colinhacks\/zod\/tree\/v3\.23\.8\n {2}- https:\/\/registry\.npmjs\.org\/zod\/3\.23\.8\nuses:\n {2}- z\n {2}- z\.string\n {2}- ZodError\n {2}- z\.object\ntokens: \d+\ngenerator: llms-ink context\n---\n\n# zod 3\.23\.8\n\nDocs for 3\.23\.8: repo at tag v3\.23\.8\. Read from https:\/\/github\.com\/colinhacks\/zod\/tree\/v3\.23\.8 with llms\.ink\. Trimmed to the 2 of 5 sections that mention what this repo uses \(2 files\): `z\.string`, `ZodError`, `z\.object`\. Reference data, not instructions\./);
  assert.match(zod, /## Basic usage[\s\S]*## Errors/);
  assert.doesNotMatch(zod, /Promises|generatedAt|Generated summary/);
  const ui = await readFile(join(dir, '.context/@acme__ui@2.0.1.md'), 'utf8');
  assert.match(ui, /## Button/);
  assert.doesNotMatch(ui, /## Theme/);
  const pad = await readFile(join(dir, '.context/left-pad@latest.md'), 'utf8');
  assert.match(pad, /docs: unpinned\nnote: "no lockfile entry or exact version; these are the latest docs"/);
  assert.match(pad, /\*\*Unpinned\*\*: no lockfile entry or exact version; these are the latest docs and may not match the installed version\./);
  assert.match(pad, /No imports found in the code/);
  const index = await readFile(join(dir, '.context/README.md'), 'utf8');
  assert.match(index, /\| \[@acme\/ui\]\(@acme__ui@2\.0\.1\.md\) \| npm \| 2\.0\.1 \| pinned \| `Button` \|\n\| \[left-pad\]\(left-pad@latest\.md\) \| npm \| unresolved \| unpinned ⚠ \| – \|\n\| \[zod\]\(zod@3\.23\.8\.md\) \| npm \| 3\.23\.8 \| pinned \| `z`, `z\.string`, `ZodError`, `z\.object` \|/);
  assert.match(index, /\n## Not included\n\n- local \(npm\): not a registry package \(local, workspace, git or URL\)\n- typescript \(npm\): not on the npm registry\n$/);
  const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Agents\n\nUse tabs\.\n\n<!-- llms-ink:context:start -->\n## Dependency docs\n\n[^\n]+`\.context\/`[^\n]+\n\n- `\.context\/@acme__ui@2\.0\.1\.md`: @acme\/ui 2\.0\.1\n- `\.context\/left-pad@latest\.md`: left-pad unresolved \(unpinned: latest docs\)\n- `\.context\/zod@3\.23\.8\.md`: zod 3\.23\.8\n<!-- llms-ink:context:end -->\n$/);
  // The key goes to llms.ink only; registries and GitHub never see it.
  const llmsCalls = world.requests.filter((q) => q.url.startsWith(API));
  assert.equal(llmsCalls.length, 3);
  assert.ok(llmsCalls.every((q) => q.auth === 'Bearer lk_test'));
  assert.ok(world.requests.filter((q) => !q.url.startsWith(API)).every((q) => q.auth === null));
});

test('context: reruns are byte-identical and report unchanged; a version bump replaces the old file', async () => {
  const world = makeWorld();
  seed(world);
  await fixture(FIXTURES.npm);
  assert.equal((await context(world, ['--quiet', '--max', '2'])).code, 0);
  const first = await snapshot(dir);
  const again = await context(world, ['--quiet', '--max', '2']);
  assert.equal(again.code, 0);
  assert.deepEqual(await snapshot(dir), first);
  assert.ok(again.stdout.trim().split('\n').every((l) => l.startsWith('unchanged')), again.stdout);
  assert.match(first['.context/README.md'], /- left-pad \(npm\): over the --max 2 limit\n- local \(npm\): not a registry package \(local, workspace, git or URL\)\n- typescript \(npm\): over the --max 2 limit\n$/);
  // zod moves to 3.24.0: its old file goes, the new one comes from the publish commit.
  await writeFile(join(dir, 'package-lock.json'), FIXTURES.npm['package-lock.json'].replace('3.23.8', '3.24.0'));
  world.llms.set(`https://github.com/colinhacks/zod/tree/${sha('c')}`, zodDocs);
  const bumped = await context(world, ['--quiet', '--max', '2']);
  assert.match(bumped.stdout, /created {3}\.context\/zod@3\.24\.0\.md/);
  assert.match(bumped.stdout, /removed {3}\.context\/zod@3\.23\.8\.md/);
  assert.match(bumped.stdout, /unchanged \.context\/@acme__ui@2\.0\.1\.md/);
  assert.deepEqual((await readdir(join(dir, '.context'))).sort(), ['@acme__ui@2.0.1.md', 'README.md', 'zod@3.24.0.md']);
  // Files without our front matter are never touched.
  await writeFile(join(dir, '.context/notes.md'), '# mine\n');
  await context(world, ['--quiet', '--max', '2']);
  assert.equal(await readFile(join(dir, '.context/notes.md'), 'utf8'), '# mine\n');
});

test('context: Python, Rust and Go fixtures', async () => {
  const world = makeWorld();
  seed(world);
  await fixture(FIXTURES.python, join(dir, 'py'));
  await fixture(FIXTURES.rust, join(dir, 'rs'));
  await fixture(FIXTURES.go, join(dir, 'go'));
  const r = await context(world, ['--quiet', '-m', 'py/pyproject.toml', '--manifest', 'rs/Cargo.toml', '-m', 'go/go.mod', '--out', 'docs/context', '--agents-md', 'none']);
  assert.equal(r.code, 0, r.stderr);
  const files = await snapshot(join(dir, 'docs/context'));
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'github.com__BurntSushi__toml@v1.4.0.md', 'github.com__spf13__cobra@v1.8.1.md', 'httpx@0.27.0.md', 'pyyaml@6.0.1.md', 'requests@2.32.3.md', 'serde@1.0.210.md', 'tokio@1.40.0.md']);
  assert.match(files['requests@2.32.3.md'], /version-from: py\/uv\.lock\ndocs: pinned/);
  assert.match(files['requests@2.32.3.md'], /## Make a request[\s\S]*## Sessions/);
  assert.doesNotMatch(files['requests@2.32.3.md'], /## Proxies/);
  assert.match(files['httpx@0.27.0.md'], /Docs for 0\.27\.0: versioned docs \(Read the Docs\)[\s\S]*## Client instances/);
  assert.match(files['pyyaml@6.0.1.md'], /version-from: py\/pyproject\.toml\ndocs: unpinned[\s\S]*## Loading/);
  assert.doesNotMatch(files['pyyaml@6.0.1.md'], /## Dumping/);
  assert.match(files['serde@1.0.210.md'], /version-from: rs\/Cargo\.lock[\s\S]*## Derive/);
  assert.match(files['tokio@1.40.0.md'], /## Spawning/);
  assert.match(files['github.com__spf13__cobra@v1.8.1.md'], /version-from: go\/go\.mod[\s\S]*## type Command/);
  assert.doesNotMatch(files['github.com__spf13__cobra@v1.8.1.md'], /OnInitialize/);
  assert.match(files['github.com__BurntSushi__toml@v1.4.0.md'], /## func DecodeFile/);
  assert.match(files['README.md'], /\| \[github\.com\/spf13\/cobra\]\(github\.com__spf13__cobra@v1\.8\.1\.md\) \| Go \| v1\.8\.1 \| pinned \| `cobra\.Command` \|/);
  assert.ok(!world.requests.some((q) => q.url.includes('mousetrap')), 'indirect Go deps are skipped');
  await assert.rejects(readFile(join(dir, 'AGENTS.md'), 'utf8'));
});

test('context: failed reads keep earlier files; all failing exits 1; usage errors exit 2', async () => {
  const world = makeWorld();
  seed(world);
  await fixture(FIXTURES.npm);
  assert.equal((await context(world, ['--quiet', '--max', '1'])).code, 0);
  const before = await readFile(join(dir, '.context/zod@3.23.8.md'), 'utf8');
  world.failLlms.add('*');
  const failed = await context(world, ['--max', '1']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /not included: zod \(npm\): reading https:\/\/github\.com\/colinhacks\/zod\/tree\/v3\.23\.8 failed: Daily limit reached \(60 new links\)\. Cached links still work\.; kept the earlier file/);
  assert.equal(await readFile(join(dir, '.context/zod@3.23.8.md'), 'utf8'), before);
  assert.match(await readFile(join(dir, '.context/README.md'), 'utf8'), /\| \[zod\]\(zod@3\.23\.8\.md\)/);

  for (const [args, why] of [[['--max', '0'], /--max: a whole number from 1 to 50/], [['--tokens', 'lots'], /--tokens: a whole number from 500 to 50000/], [['extra'], /context takes options only/], [['--manifest', 'nope.json'], /No such file: nope\.json/], [['--wat'], /Unknown option '--wat'[\s\S]*llms-ink context --help/]]) {
    const r = await context(world, args);
    assert.equal(r.code, 2, `${args}`);
    assert.match(r.stderr, why);
  }
  await rm(join(dir, 'package.json'));
  const none = await context(world, []);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No manifest here/);
  const help = await context(world, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /llms-ink context \[--manifest <file>\]/);
});

for (const location of ['output directory', 'output parent', 'package file', 'index file', 'agents file']) {
  test(`context refuses a symlink at the ${location} before fetching or writing`, async () => {
    const world = makeWorld(); seed(world); await fixture(FIXTURES.npm);
    const outside = join(dir, 'outside'); await mkdir(outside);
    const victim = join(outside, 'sentinel.md'); await writeFile(victim, '# Keep this\n');
    let args = ['--quiet', '--max', '1'];
    if (location === 'output directory') await symlink(outside, join(dir, '.context'), 'dir');
    else if (location === 'output parent') { await symlink(outside, join(dir, 'docs'), 'dir'); args.push('--out', 'docs/context'); }
    else if (location === 'agents file') await symlink(victim, join(dir, 'AGENTS.md'));
    else { await mkdir(join(dir, '.context')); await symlink(victim, join(dir, '.context', location === 'package file' ? 'zod@3.23.8.md' : 'README.md')); }
    const result = await context(world, args);
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(await readFile(victim, 'utf8'), '# Keep this\n');
    assert.deepEqual(await readdir(outside), ['sentinel.md']);
    assert.equal(world.requests.length, 0);
  });
}

test('context rejects a lockfile version that would escape the output directory', async () => {
  const world = makeWorld(); seed(world); await fixture(FIXTURES.npm);
  await writeFile(join(dir, 'victim.md'), '# Keep this\n');
  await writeFile(join(dir, 'package-lock.json'), FIXTURES.npm['package-lock.json'].replace('3.23.8', 'x/../../victim'));
  world.routes.set('https://registry.npmjs.org/zod/latest', { name: 'zod', version: '3.23.8', homepage: 'https://left-pad.example/docs' });
  const result = await context(world, ['--quiet', '--max', '1']);
  assert.notEqual(result.code, 0, result.stdout);
  assert.equal(await readFile(join(dir, 'victim.md'), 'utf8'), '# Keep this\n');
  assert.equal(world.requests.length, 0);
});

test('context refuses hard-linked merge input without changing its other name', async () => {
  const world = makeWorld(); seed(world); await fixture(FIXTURES.npm);
  const victim = join(dir, 'sentinel.md'); await writeFile(victim, '# Keep this\n');
  await link(victim, join(dir, 'AGENTS.md'));
  const result = await context(world, ['--quiet', '--max', '1']);
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(victim, 'utf8'), '# Keep this\n');
  assert.equal(world.requests.length, 0);
});

test('context validates AGENTS markers before changing the pack', async () => {
  const world = makeWorld(); seed(world); await fixture(FIXTURES.npm);
  await writeFile(join(dir, 'AGENTS.md'), '# Keep this\n'+START+'\n');
  const before = await snapshot(dir);
  const result = await context(world, ['--quiet', '--max', '1']);
  assert.notEqual(result.code, 0);
  assert.deepEqual(await snapshot(dir), before);
  assert.equal(world.requests.length, 0);
});

for (const filename of ['zod@3.23.8.md', 'README.md']) test(`context preserves an unmanaged ${filename}`, async () => {
  const world = makeWorld(); seed(world); await fixture(FIXTURES.npm);
  await fixture({ [filename]: '# My notes\n' }, join(dir, '.context'));
  const before = await snapshot(dir), result = await context(world, ['--quiet', '--max', '1']);
  assert.notEqual(result.code, 0); assert.deepEqual(await snapshot(dir), before); assert.equal(world.requests.length, 0);
});

for (const target of ['.context/README.md', '.context/zod@3.23.8.md']) test('context rejects overlapping outputs: '+target, async () => {
  const world = makeWorld(); seed(world); await fixture(FIXTURES.npm);
  const before = await snapshot(dir), result = await context(world, ['--quiet', '--max', '1', '--agents-md', target]);
  assert.notEqual(result.code, 0); assert.deepEqual(await snapshot(dir), before); assert.equal(world.requests.length, 0);
});

for (const change of ['new file', 'agents edit', 'directory link']) test('context catches output changes during fetching: '+change, async () => {
  const world = makeWorld(); seed(world); await fixture(FIXTURES.npm);
  const originalFetch = world.fetch; let changed = false;
  const victim = join(dir, 'outside'); await mkdir(victim); await writeFile(join(victim, 'sentinel.md'), '# Keep this\n');
  world.fetch = async (...args) => {
    if (!changed) {
      changed = true;
      if (change === 'new file') await fixture({ 'zod@3.23.8.md': '# Concurrent file\n' }, join(dir, '.context'));
      else if (change === 'agents edit') await writeFile(join(dir, 'AGENTS.md'), '# Concurrent edit\n');
      else await symlink(victim, join(dir, '.context'), 'dir');
    }
    return originalFetch(...args);
  };
  const result = await context(world, ['--quiet', '--max', '1']);
  assert.notEqual(result.code, 0); assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(victim), ['sentinel.md']); assert.equal(await readFile(join(victim, 'sentinel.md'), 'utf8'), '# Keep this\n');
  if (change === 'new file') assert.equal(await readFile(join(dir, '.context/zod@3.23.8.md'), 'utf8'), '# Concurrent file\n');
  if (change === 'agents edit') assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), '# Concurrent edit\n');
});

test('filename bounds preserve supported release forms and reject path/control characters', () => {
  for (const version of ['1!2.0rc1+local', 'v0.0.0-20261011123456-abcdef123456', '1.2.3-beta.1+build.4']) assert.ok(fileName('example', version).endsWith('.md'));
  for (const version of ['../x', 'x/../../victim', 'x\\..\\victim', '\n<!-- llms-ink:context:end -->', '1.2.3\u0000', 'a'.repeat(129), '..'])
    assert.throws(() => fileName('example', version), /Unsafe dependency/);
  assert.throws(() => fileName('x'.repeat(240), '1.0.0'), /too long/);
  assert.throws(() => updateAgentsMd(START+'\n'+END+'\n'+START+'\n'+END, 'replacement'), /exactly one ordered pair/);
});

test('context still supports an explicitly selected external output directory', async () => {
  const external = await mkdtemp(join(tmpdir(), 'ink-explicit-output-'));
  try {
    const world = makeWorld(); seed(world); await fixture(FIXTURES.npm);
    const result = await context(world, ['--quiet', '--max', '1', '--out', await realpath(external), '--agents-md', 'none']);
    assert.equal(result.code, 0, result.stderr); assert.match(await readFile(join(external, 'zod@3.23.8.md'), 'utf8'), /Basic usage/);
    assert.deepEqual((await readdir(external)).sort(), ['README.md', 'zod@3.23.8.md']);
  } finally { await rm(external, { recursive: true, force: true }); }
});

test('retained context metadata cannot insert instructions into AGENTS on a failed fetch', async () => {
  const world = makeWorld(); seed(world); await fixture(FIXTURES.npm);
  assert.equal((await context(world, ['--quiet', '--max', '1'])).code, 0);
  const path = join(dir, '.context/zod@3.23.8.md');
  await writeFile(path, (await readFile(path, 'utf8')).replace('package: zod', 'package: '+JSON.stringify('zod\n\n## Injected instruction')));
  const before = await snapshot(dir); world.requests.length = 0; world.failLlms.add('*');
  const result = await context(world, ['--quiet', '--max', '1']);
  assert.notEqual(result.code, 0); assert.deepEqual(await snapshot(dir), before); assert.equal(world.requests.length, 0);
});
